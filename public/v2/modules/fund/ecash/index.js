// Fund module: eCash. One box takes both kinds of eCash, pasted or scanned: a Cashu token or Fedimint
// notes (core/fedinote.js tells them apart on the phone). Both go through wallet.topup (POST
// /v1/wallet/topup), which stores the eCash on the phone before sending it and removes it only once the
// engine confirms the credit (core/vault.js).
//
// Cashu from the engine's own mint is added as it is: to the balance of its own unit, the second balance
// opened with the first one's key (docs/PAYMENTS.md, Two balances). Only where that balance cannot be
// opened is it changed (methods.convert), price first, with Yes and No (kit.js foreignQuote).
// Cashu from another mint is priced here, in this box (POST /v1/wallet/fund/foreign/quote): the amount
// added, where it comes from and the most the fees take, then Add or Keep my eCash. Nothing is spent
// before Add; the token is kept on the phone from then until the engine reports the outcome.
//
// Fedimint notes go to the sat balance (docs/PAYMENTS.md, Fedimint notes). Nothing is sent while the
// engine takes no Fedimint notes (fedimint absent from its methods), while none of its federations
// issued them, or while they are worth more than it takes at once. Every refusal says whether the notes
// are still the person's, and leaves them in the box with a Copy button; the vault keeps them too,
// marked not added, listed under Funds until the person removes them. An outcome not known yet
// (topup_pending) keeps them on the phone and sends the same notes again: here while this screen is
// open, and on every start of the app and when the connection comes back (app.js retryAll). Notes the
// federation took without the value being added (issuance_failed) are marked stuck, never sent again,
// and shown with their id for whoever helps.
//
// A BitNotes paper note (core/bitnote.js) is read on the phone: its code that controls the funds becomes
// a Cashu token of its one mint, which goes the way any Cashu token goes from here. Its other code, which
// only shows the note, is refused with a word to scan the other one; so is a note of more than one mint.
//
// A token handed over by another fund module (a scanned note, a card tap) fills the box and is sent at once.
import { isBitnote, readBitnote, shownAmount } from '../../../core/bitnote.js';
import { fedimintAnswer, fedimintCheck, notesIdOf, readFedimint, shortId, tokenKind } from '../../../core/fedinote.js';
import { isNoteUnit, mintLabel, noteVerdict, readNote } from '../../../core/note.js';
import { foreignQuote, fundIn, inviteField, poll, tokenBox } from '../kit.js';

/** The picture for each Fedimint answer: what the line says before it is read. */
const ICON = {
  'fund.ecash.fm.off': 'noMoney',
  'fund.ecash.fm.notTaken': 'noMoney',
  'fund.ecash.fm.paused': 'clock',
  'fund.ecash.fm.full': 'gauge',
  'fund.ecash.fm.tooLarge': 'gauge',
  'fund.ecash.fm.tooSmall': 'coins',
  'fund.ecash.fm.unsupported': 'noMoney',
  'fund.ecash.fm.invalid': 'xCircle',
  'fund.ecash.fm.unavailable': 'server',
  'fund.ecash.fm.unread': 'server',
  'fund.ecash.fm.needSats': 'sats',
  'fund.ecash.fm.failed': 'alert',
  'fund.ecash.fm.spent': 'xCircle',
  'fund.ecash.fm.pending': 'wait',
  'fund.ecash.fm.stuck': 'hand',
};

/** How often notes whose outcome is not known yet are sent again while this screen is open. */
export const RETRY_MS = 6000;

export function create(inputs) {
  const { t, ui, wallet, engine, format } = inputs;
  const fedimint = () => wallet.methods()?.fedimint;
  return {
    id: 'ecash',
    group: 'unlinked',
    icon: 'coins',
    available: () => true,
    // Fedimint is named only where the engine takes it.
    sub: () => (fedimint()?.enabled ? 'fund.ecash.subFedimint' : 'fund.ecash.sub'),
    view({ done, added, token: given }) {
      const msg = ui.msgLine();
      // Ways on from an answer: Copy the eCash back, Go on, Check now.
      const onward = ui.el('div', { class: 'onward row-btns', id: 'ecashOnward', hidden: true });
      const invite = inviteField(inputs);
      const add = ui.el('button', { type: 'button', class: 'btn primary block', id: 'ecashAdd' }, ui.icon('addMoney', 22), ui.el('span', { text: t('fund.ecash.add') }));
      // Which mints and federations are taken: detail, behind the info button at the box's label.
      const info = () => {
        const mints = wallet.mints();
        const feds = fedimint()?.enabled ? (fedimint().federations ?? []).map((f) => f.name || f.id?.slice(0, 8)).filter(Boolean) : [];
        return [mints.length ? t('fund.ecash.mints', { mints: mints.join(', ') }) : null, feds.length ? t('fund.ecash.federations', { names: feds.join(', ') }) : null];
      };
      const box = tokenBox(inputs, { id: 'ecashToken', label: t('fund.ecash.label'), onScanned: () => add.click(), info: info() ?? [], accept: (text) => readFedimint(text).ok || isBitnote(text) });
      // What the Fedimint notes are, once Add is pressed: their amount and their federation.
      const card = ui.el('div', { id: 'ecashCard' });
      const form = [invite.node, box.node, card, msg, onward].filter(Boolean);
      const body = ui.el('div', { class: 'scroll fund-body' }, ...form);
      const foot = ui.el('div', { class: 'foot' }, add);
      let quote = null;
      let poller = null;
      let busy = false;
      let gone = false;

      const btn = (id, ico, label, onclick, cls = 'btn') => ui.el('button', { type: 'button', class: cls, id, onclick }, ui.icon(ico, 20), ui.el('span', { text: label }));
      const copyBtn = (id, label, text, cls = 'btn') => btn(id, 'copy', label, async () => ui.toast((await ui.copy(text)) ? t('answer.copied') : t('answer.copyFailed')), cls);
      const showOnward = (...nodes) => {
        onward.replaceChildren(...nodes.filter(Boolean));
        onward.hidden = !onward.children.length;
      };
      const stopWatching = () => {
        poller?.stop();
        poller = null;
      };
      /** Back to the box, as it was: the token still in it. */
      const reset = () => {
        quote?.stop();
        quote = null;
        stopWatching();
        body.replaceChildren(...form);
        foot.replaceChildren(add);
        showOnward();
        card.replaceChildren();
        add.hidden = false;
      };
      /** The money is in: Funds says it in its success panel. */
      const finish = async (r, words) => {
        box.clear();
        msg.set(words, 'ok');
        await wallet.refresh();
        done({ words, amount: r.replay ? '' : r.free ? t('fund.note.free', { count: r.credited }) : format.units(r.credited, r.unit), plus: !r.free });
      };

      // ------------------------------------------------------------ Cashu

      /** The engine changes eCash from its own mint into `unit`, a balance this phone has. */
      const canConvert = (unit) => !!unit && !!(wallet.keyFor ? wallet.keyFor(unit) : wallet.key()) && !!wallet.methods()?.convert?.units?.includes(unit);
      /** No: back to the box with the token in it, nothing sent and nothing kept. */
      const keep = () => {
        reset();
        msg.set(t('fund.convert.kept'), 'ok');
      };
      const convert = async (token, unit) => {
        msg.set(t('fund.othermint.checking'));
        const r = await engine.foreignQuote(wallet.keyFor ? wallet.keyFor(unit) : wallet.key(), { token, unit, pubkey: wallet.lockKey() || undefined });
        if (!r.ok) return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
        msg.set('');
        quote = foreignQuote(inputs, { body, foot, f: r.body, token, done, added, onNo: keep });
      };

      /**
       * eCash from another mint, priced here (the flow of POST /v1/wallet/fund/foreign/quote). Its unit's
       * balance takes it, opened with the first one's key; an engine without two balances prices it in the
       * balance the phone has. A mint off the engine's list asks first (Go on).
       */
      const unitNow = (note) => (note?.ok && isNoteUnit(note.unit) && wallet.landsIn ? wallet.landsIn(note.unit) : (wallet.unit() ?? (wallet.methods()?.lightning?.units ?? ['usd', 'sat'])[0]));
      /** Over the most the engine takes from another mint at once (max: {sat, usd}): says so, and true. */
      const tooLarge = (note, max) => {
        const cap = note.ok && isNoteUnit(note.unit) ? max?.[note.unit] : undefined;
        if (typeof cap !== 'number' || note.amount <= cap) return false;
        msg.set(t('fund.ecash.otherTooLarge', { max: format.units(cap, note.unit) }), 'err', 'gauge');
        return true;
      };
      const priceOther = async (token, acceptUnlisted = false) => {
        const note = readNote(token);
        foot.replaceChildren(add);
        // Nothing is sent for eCash over the cap.
        if (tooLarge(note, wallet.methods()?.foreign?.max)) return;
        if (invite.missing(msg)) return;
        msg.set(t('fund.othermint.checking'));
        const unit = unitNow(note);
        const r = await fundIn(wallet, unit, invite.value(), (key, code, sibling) => engine.foreignQuote(key, { token, unit, invite: code, pubkey: wallet.lockKey() || undefined, ...(acceptUnlisted ? { accept_unlisted: true } : {}) }, sibling));
        // The engine would not open that balance: the price again, in the unit the phone holds.
        if (r.body?.error?.code === 'sibling_refused') return priceOther(token, acceptUnlisted);
        if (!r.ok) {
          const code = r.body?.error?.code;
          if (code === 'mint_unlisted') {
            // A mint off the list has a lower cap: over it, there is nothing to go on to.
            if (tooLarge(note, r.body?.unlisted?.max)) return;
            msg.set(t('fund.othermint.unlisted'), 'err', 'shield');
            // The mint's address under the words; Go on in Add's place, the one lit button while the box asks.
            showOnward(ui.sayEl('p', { class: 'mono note', id: 'ecashUnlisted' }, r.body?.unlisted?.mint ?? ''));
            foot.replaceChildren(btn('ecashGoOn', 'next', t('fund.othermint.goOn'), () => run(() => priceOther(token, true)), 'btn primary block'));
            return;
          }
          // From one of the engine's own mints after all: added as it is.
          if (code === 'use_topup') return addCashu(token, { asIs: true });
          if (code === 'amount_too_large') return msg.set(t('fund.ecash.otherTooMuch'), 'err', 'gauge');
          if (code === 'mint_not_allowed' || code === 'method_unavailable') return msg.set(t('fund.ecash.wrongMint'), 'err', 'noMoney');
          return msg.set(t('fund.ecash.noPrice', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
        }
        msg.set('');
        showOnward();
        quote = foreignQuote(inputs, { body, foot, f: r.body, token, done, added, onNo: keep });
      };

      const addCashu = async (token, { asIs = false } = {}) => {
        const note = readNote(token);
        const methods = wallet.methods();
        const otherMint = !!methods?.foreign?.enabled;
        if (!asIs && note.ok && !wallet.isCredit?.(note.mint)) {
          const v = noteVerdict(note, { mints: wallet.mints(), aliases: wallet.mintAliases(), otherMint });
          if (v === 'other_mint') return priceOther(token);
          if (v === 'wrong_mint') return msg.set(t('fund.ecash.wrongMint'), 'err', 'noMoney');
          // Read before sending: from the engine's own mint, in a unit no balance here takes as it is
          // (wallet.landsIn names another), goes to the price.
          const to = wallet.landsIn ? wallet.landsIn(note.unit) : wallet.unit();
          if (canConvert(to) && noteVerdict(note, { mints: wallet.mints(), aliases: wallet.mintAliases(), units: wallet.units(), balanceUnit: to, convert: true }) === 'convert') return convert(token, to);
        }
        if (invite.missing(msg)) return;
        msg.set(t('fund.ecash.sending'));
        try {
          const r = await wallet.topup(token, invite.value());
          // A voucher of free questions is counted in questions, never as an amount of money.
          await finish(r, r.replay ? t('fund.ecash.replay') : r.free ? t('fund.free.added', { count: r.credited }) : t('fund.ecash.added', { amount: format.units(r.credited, r.unit) }));
        } catch (e) {
          // The engine read it for the phone: its unit is not these funds', and it says it can change it.
          if (e?.code === 'wrong_unit' && e.body?.convert?.unit && wallet.key()) await convert(token, e.body.convert.unit).catch((x) => msg.set(t('fund.failed', { message: x?.message ?? String(x) }), 'err'));
          // A mint the phone could not check first: priced here when the engine takes other mints.
          else if (e?.code === 'untrusted_mint') {
            if (otherMint) await priceOther(token);
            else msg.set(t('fund.ecash.wrongMint'), 'err', 'noMoney');
          } else if (e?.code === 'token_spent') msg.set(t('fund.ecash.spent'), 'err', 'xCircle');
          else if (e?.retryable) msg.set(t('fund.ecash.kept'), 'err');
          else msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        }
      };

      // ------------------------------------------------------------ Fedimint

      /** Their amount (when the phone can read it) and their federation, as one card. */
      const notesCard = (read, federation) => {
        const name = federation?.name || null;
        card.replaceChildren(
          ui.el(
            'section',
            { class: 'card price-card', id: 'fmCard' },
            read.amountMsat != null ? ui.el('div', { class: 'amount-tag', id: 'fmAmount', text: format.units(read.amountMsat / 1000, 'sat') }) : null,
            ui.sayEl('p', { class: 'note', id: 'fmFrom' }, name ? t('fund.ecash.fm.from', { name }) : t('fund.ecash.fm.kind'), '', 'coins'),
          ),
        );
      };
      /** What an answer says, with its picture, and what can be done next. */
      const answer = (a, { notes, notesId, e }) => {
        stopWatching();
        const max = e?.body?.max?.sat ?? fedimint()?.max;
        const words = t(a.key, { message: e?.message ?? '', max: max != null ? format.units(max, 'sat') : '', id: shortId(notesId) });
        if (a.kind === 'pending') {
          msg.set(words, 'wait', ICON[a.key]);
          add.hidden = true;
          foot.replaceChildren(btn('fmCheck', 'again', t('fund.ecash.fm.checkNow'), () => sendNotes(notes, notesId), 'btn block'));
          showOnward();
          poller = poll(() => sendNotes(notes, notesId, true), RETRY_MS);
          return;
        }
        // Adding spent or stuck notes again changes nothing: Add waits for other eCash in the box.
        add.hidden = a.kind === 'spent' || a.kind === 'stuck';
        foot.replaceChildren(add);
        msg.set(words, 'err', ICON[a.key]);
        // Still theirs: they can take them back. Stuck: the id for whoever helps, the one next step.
        if (a.kind === 'yours') showOnward(copyBtn('fmCopy', t('fund.ecash.copyBack'), notes));
        else if (a.kind === 'stuck') showOnward(copyBtn('fmCopyCode', t('funds.copyCode'), notesId ?? '', 'btn primary'));
        else showOnward();
      };
      /**
       * Sends the notes (again): the same notes, to the same balance, so a repeat finds the first.
       * Resolves true once the outcome is known (for the poller).
       */
      const sendNotes = async (notes, notesId, quiet = false) => {
        if (busy || gone) return false;
        busy = true;
        if (!quiet) msg.set(t('fund.ecash.sending'));
        try {
          const r = await wallet.topup(notes, invite.value(), { kind: 'fedimint', notesId });
          stopWatching();
          if (!gone) await finish(r, r.replay ? t('fund.ecash.replay') : t('fund.ecash.added', { amount: format.units(r.credited, r.unit) }));
          return true;
        } catch (e) {
          const a = fedimintAnswer(e);
          if (gone) return a.kind !== 'pending';
          if (a.kind === 'pending' && poller) {
            if (!quiet) msg.set(t(a.key), 'wait', ICON[a.key]);
            return false;
          }
          answer(a, { notes, notesId, e });
          return a.kind !== 'pending';
        } finally {
          busy = false;
        }
      };
      const addNotes = async (text) => {
        const read = readFedimint(text);
        const c = fedimintCheck(read, wallet.methods());
        notesCard(read, c.federation);
        // Decided on the phone: nothing is sent. Ways not read yet (no connection) are said apart.
        if (!wallet.methods()) return answer({ kind: 'yours', key: 'fund.ecash.fm.unread' }, { notes: read.notes });
        if (c.verdict === 'off') return answer({ kind: 'yours', key: 'fund.ecash.fm.off' }, { notes: read.notes });
        if (c.verdict === 'not_taken') return answer({ kind: 'yours', key: 'fund.ecash.fm.notTaken' }, { notes: read.notes });
        if (c.verdict === 'too_large') return answer({ kind: 'yours', key: 'fund.ecash.fm.tooLarge' }, { notes: read.notes, e: { body: { max: { sat: c.maxSat } } } });
        if (invite.missing(msg)) return;
        // Their id, the one the engine and the receiver use: kept with them for whoever helps.
        const notesId = await notesIdOf(read.notes).catch(() => null);
        await sendNotes(read.notes, notesId);
      };

      // ------------------------------------------------------------ BitNotes

      /**
       * A BitNotes note: read and checked here, then its one mint's token goes on as Cashu. Nothing is sent
       * for the code that only shows the note, a note that does not check out, or one of several mints.
       */
      const addBitnote = async (text) => {
        const read = await readBitnote(text);
        if (!read.ok) return msg.set(t(read.reason === 'mismatch' ? 'fund.ecash.bn.mismatch' : 'fund.ecash.bn.unreadable'), 'err', read.reason === 'mismatch' ? 'xCircle' : null);
        if (read.kind === 'public') return msg.set(t('fund.ecash.bn.public'), 'err', 'scan');
        if (read.mints.length > 1) return msg.set(t('fund.ecash.bn.manyMints', { count: read.mints.length }), 'err', 'noMoney');
        // The note as one card: the amount printed on it (when the person cannot get less) and its mint.
        const shown = shownAmount(read);
        card.replaceChildren(
          ui.el(
            'section',
            { class: 'card price-card', id: 'bnCard' },
            shown != null ? ui.el('div', { class: 'amount-tag', id: 'bnAmount', text: format.units(shown, 'sat') }) : null,
            ui.sayEl('p', { class: 'note', id: 'bnFrom' }, t('fund.note.from', { mint: mintLabel(read.mints[0].mint) }), '', 'coins'),
          ),
        );
        await addCashu(read.mints[0].token);
      };

      // ------------------------------------------------------------ the box

      /** One press at a time. */
      const run = async (fn) => {
        if (busy) return;
        busy = true;
        add.disabled = true;
        try {
          await fn();
        } catch (e) {
          msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          busy = false;
          add.disabled = false;
        }
      };

      add.addEventListener('click', () => {
        const text = box.value();
        showOnward();
        card.replaceChildren();
        if (isBitnote(text)) return run(() => addBitnote(text));
        const kind = tokenKind(text);
        if (kind === 'none') return msg.set(t(fedimint()?.enabled ? 'fund.ecash.badBoth' : 'fund.ecash.bad'), 'err');
        // sendNotes keeps its own busy mark: run only guards the press.
        if (kind === 'fedimint') {
          if (busy) return;
          add.disabled = true;
          return addNotes(text)
            .catch((e) => msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err'))
            .finally(() => (add.disabled = false));
        }
        run(() => addCashu(text));
      });
      // Other eCash in the box: Add is the way on again.
      box.input.addEventListener('input', () => {
        add.hidden = false;
        if (!foot.contains(add) && !quote && !poller) foot.replaceChildren(add);
      });
      if (given) {
        box.input.value = given;
        queueMicrotask(() => add.click());
      }
      const node = ui.el('div', { class: 'fund-view' }, body, foot);
      let said = '';
      return {
        node,
        // The engine's mints and ways can arrive after the box is drawn.
        update: () => {
          const now = info();
          if (JSON.stringify(now) !== said) box.setInfo(now);
          said = JSON.stringify(now);
        },
        destroy: () => {
          gone = true;
          quote?.stop();
          stopWatching();
          box.stop();
        },
      };
    },
  };
}
