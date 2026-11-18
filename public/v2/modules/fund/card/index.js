// Fund module: Tap a Cashu card. A Cashu eCash card (the card protocol 2.0 that flash-pos speaks) gives its
// eCash to this phone: the card proves its key, the person enters its PIN and picks how much (all of it
// by default), the card signs one swap at its own mint, and the eCash that comes back is added to the
// funds. The work is core/card/flow.js; this file is the screen.
//
// Only the apps can read these cards (the nfc input is their reader). On the website the row says so
// and points to the app. On Android the card can stay on the phone for the whole thing: read, PIN and
// amount, signature, swap and the card's change. If it leaves early, the screen asks for it again and
// goes on from where it was; what the card already signed is kept on the phone and finished then
// (flow.js). On the iPhone the phone reads only while iOS's NFC sheet is up (nfc.sheet), and the sheet
// covers the screen: each step with the card is a press, then a tap (the read, then Move or Finish), and
// the sheet closes in between, while the person types the PIN and the amount.
//
// Where the eCash goes: a card from the engine's own mint tops up the funds through the vault (stored
// first, removed once credited). A card from another mint the engine takes through other-mint funding:
// the eCash is kept in the vault, marked not added, and the Other mint screen opens with it. The engine's
// own eCash in the unit these funds do not hold goes the same way, to the eCash screen, which shows the
// price to change it (when the engine changes units).
import { inviteField } from '../kit.js';
import { cardFace } from '../../../screens/brands/cards.js';

const UNIT_WORD = { usd: 'unit.usd', sat: 'unit.sat' };

/** The children to put in a node, without the empty ones (replaceChildren would write "null"). */
const kids = (...list) => list.filter((x) => x != null && x !== '' && x !== false);

/**
 * Where a card's eCash can go, decided before the card signs. info is the relay's answer about the
 * card's mint ({trusted}). 'topup', 'othermint', 'wrong_unit' or 'wrong_mint'. The engine's own eCash in
 * the unit these funds do not hold goes the 'othermint' way (to the phone, then a price) when the engine
 * changes it (convert): the eCash module shows that price.
 */
export function routeFor(info, { unit, units = [], balanceUnit = null, otherMint = false, convert = false }) {
  if (!unit) return 'wrong_unit';
  if (info?.trusted) {
    if (units.length && !units.includes(unit)) return 'wrong_unit';
    if (balanceUnit && balanceUnit !== unit) return convert ? 'othermint' : 'wrong_unit';
    return 'topup';
  }
  return otherMint ? 'othermint' : 'wrong_mint';
}

/** The words for a card flow failure (core/card/flow.js CardFlowError codes). */
export function wordsFor(e, t) {
  // A kept failure came after the card burned its pieces: it never reaches a "Nothing was taken" line.
  if (e?.kept && e.code !== 'unfinished' && e.code !== 'mint_refused') return t('fund.card.kept');
  switch (e?.code) {
    case 'pin_wrong':
      return t('fund.card.wrongPin', { tries: e.triesLeft === 1 ? t('fund.card.tryLeft') : t('fund.card.triesLeft', { count: e.triesLeft }) });
    case 'pin_blocked':
      return t('fund.card.pinBlocked');
    case 'pin_needed':
      return t('fund.card.pinNeeded');
    case 'over_limit':
      return t('fund.card.overLimit');
    case 'other_card':
      return t('fund.card.otherCard');
    case 'not_ecash':
      return t('fund.card.notEcash');
    case 'needs_update':
      return t('fund.card.needsUpdate');
    case 'not_genuine':
      return t('fund.card.notGenuine');
    case 'locked':
      return t('fund.card.locked');
    case 'empty':
      return t('fund.card.empty');
    case 'too_small':
      return t('fund.card.tooSmall');
    case 'all_only':
      return t('fund.card.allOnly');
    case 'over_max':
      return t('fund.card.overMax');
    case 'unfinished':
      return t('fund.card.unfinished');
    case 'mint_unavailable':
      return e.kept ? t('fund.card.kept') : t('fund.failed', { message: e.message });
    case 'mint_refused':
      return e.kept ? t('fund.card.refused') : t('fund.failed', { message: e.message });
    case 'not_taken':
      return t('fund.card.wrongMint');
    case 'not_stored':
      return t('fund.card.notStored');
    case 'tap_lost':
      return t('fund.card.holdAgain');
    default:
      return t('fund.card.failed');
  }
}

export function create(inputs) {
  const { t, ui, wallet, vault, format, nfc, card, engine } = inputs;
  return {
    id: 'card',
    group: 'unlinked',
    icon: 'card',
    // Listed on the website and in the apps: on the website the row says cards need the app. Not in an
    // iPhone app built before its reader, which has no app to point to (core/native.js NO_READER).
    // Usable only where there is a reader, so How you pay shows a card only in the app.
    available: () => nfc?.listed?.() !== false,
    usable: () => !!nfc?.supported?.(),
    view({ done, open }) {
      const msg = ui.msgLine();
      const body = ui.el('div', { class: 'scroll fund-body' });
      const foot = ui.el('div', { class: 'foot' });
      const node = ui.el('div', { class: 'fund-view card-view' }, body, foot);
      const btn = (attrs, ico, label) => ui.el('button', { type: 'button', ...attrs }, ico ? ui.icon(ico, 20) : null, ui.el('span', { text: label }));
      let gone = false;
      let reader = null;
      let cards = null; // {flow, handToken}, loaded on first use
      let current = null; // the card in the field now
      let busy = false;
      // What a card coming into the field is for: 'read', 'pay' or 'finish'.
      let next = 'read';
      // What the read found, and what the person chose.
      let summary = null;
      let info = null;
      let acceptUnlisted = false;
      let route = null;
      let choice = null; // {plan, pin}
      let changeWaiting = false; // the last payment's change goes back on the card at its next read

      const art = (amountText) =>
        ui.el(
          'div',
          { class: 'card-art', 'data-brand': 'card', role: 'img', 'aria-label': t('fund.card.picture') },
          // The card as it is printed (screens/brands/cards.js), with what it holds over it once read.
          cardFace('card'),
          amountText ? ui.el('span', { class: 'card-art-amount', text: amountText }) : null,
        );

      // ------------------------------------------------------------ the website: no reader

      if (!nfc?.supported?.()) {
        body.replaceChildren(...kids(art(), ui.sayEl('p', { id: 'cardAppOnly' }, t('fund.card.appOnly')), ui.sayEl('p', { class: 'note' }, t('fund.card.what'))));
        foot.replaceChildren(...kids(ui.el('a', { class: 'btn primary block', id: 'cardGetApp', href: '/download' }, ui.icon('download', 20), ui.el('span', { text: t('fund.card.getApp') }))));
        return { node, destroy() {} };
      }

      // ------------------------------------------------------------ the app

      const hold = (line = t('fund.card.keep')) => {
        body.replaceChildren(...kids(art(), ui.sayEl('p', { class: 'card-hold', id: 'cardHold' }, t('fund.card.hold')), ui.sayEl('p', { class: 'note', id: 'cardHoldLine' }, line), msg, failedList()));
        // The iPhone: waiting for the card is the NFC sheet. It opens now (this follows a press) unless a
        // card is being handled, whose sheet closes when it is done; Scan opens it again.
        foot.replaceChildren(...kids(nfc.sheet && btn({ class: 'btn primary block', id: 'cardScan', onclick: () => reader?.again() }, 'nfc', t('fund.card.scan'))));
        if (nfc.sheet) reader?.again();
      };

      /**
       * Card payments the card's mint refused: the money is on this phone and nowhere else, so each is
       * shown with what it is worth, its mint, what was said, and Try again.
       */
      const failedList = () => {
        const jobs = cards?.flow?.failed?.() ?? [];
        if (!jobs.length) return null;
        return ui.el(
          'section',
          { class: 'notice', id: 'cardFailed', 'aria-labelledby': 'cardFailedHead' },
          ui.el('b', { id: 'cardFailedHead', text: t('fund.card.failedHead') }),
          ...jobs.map((j) =>
            ui.el(
              'div',
              { class: 'card-failed', 'data-job': j.id },
              ui.sayEl('p', {}, t('fund.card.failedRow', { amount: format.units(j.outputs.reduce((s, o) => s + o.amount, 0), j.unit), mint: mintLabel(j.mint) })),
              j.error ? ui.sayEl('p', { class: 'note mono' }, t('fund.card.failedWhy', { error: String(j.error).slice(0, 200) })) : null,
              btn({ class: 'btn block', onclick: () => retry(j.id) }, 'again', t('fund.card.tryAgain')),
            ),
          ),
        );
      };

      /** Try a refused card payment again: the swap is sent now, or (no signature) at the card's next tap. */
      const retry = async (id) => {
        if (busy) return;
        busy = true;
        working(t('fund.card.moving'));
        try {
          const job = await cards.flow.retry(id);
          if (job?.state === 'ready') {
            next = 'read';
            hold(t('fund.card.holdAgain'));
            return;
          }
          await handFinished();
          ui.toast(t('fund.card.retried'));
          hold();
        } catch (e) {
          failed(e);
        } finally {
          busy = false;
        }
      };

      const working = (text) => {
        msg.set('');
        body.replaceChildren(...kids(art(summary ? format.units(summary.balance, summary.unit) : null), ui.el('p', { class: 'status-line', id: 'cardStatus', role: 'status', text })));
        foot.replaceChildren();
      };

      /** A card came into the field: whatever this screen was waiting for goes on with it. */
      const onCard = async (c) => {
        if (gone || busy) return;
        if (!c) return msg.set(t('fund.card.notEcash'), 'err');
        current = c;
        busy = true;
        try {
          if (next === 'pay') await pay();
          else if (next === 'finish') await finish();
          else await read();
        } finally {
          busy = false;
          // The iPhone lets the card go with its sheet once this is done: the next step needs a new tap.
          if (nfc.sheet) current = null;
        }
      };

      const startReading = async () => {
        msg.set('');
        const s = await nfc.status();
        if (!s.available) {
          body.replaceChildren(...kids(art(), ui.sayEl('p', { class: 'msg err', id: 'cardNoNfc' }, t('fund.card.noNfc'), 'err')));
          return;
        }
        if (!s.enabled) {
          body.replaceChildren(...kids(art(), ui.sayEl('p', { class: 'msg err', id: 'cardNfcOff' }, t('fund.card.nfcOff'), 'err')));
          foot.replaceChildren(...kids(btn({ class: 'btn primary block', id: 'cardRetry', onclick: startReading }, 'again', t('fund.card.tryAgain'))));
          return;
        }
        cards ??= await card.load();
        if (gone) return;
        hold();
        reader?.stop();
        reader = nfc.start((c) => onCard(c), nfc.sheet ? sheetWords() : undefined);
      };

      /** The words on the iPhone's NFC sheet (ios/App/App/NfcPlugin.swift). */
      const sheetWords = () => ({
        hold: t('fund.card.sheetHold'),
        keep: t('fund.card.sheetKeep'),
        done: t('fund.card.sheetDone'),
        lost: t('fund.card.sheetLost'),
        notCard: t('fund.card.notEcash'),
        one: t('fund.card.sheetOne'),
      });

      /** A card this engine cannot take from: said once, nothing asked of the card. */
      const refuse = (text) => {
        body.replaceChildren(...kids(art(), ui.el('p', { class: 'msg err', id: 'cardResult', role: 'status', text })));
        foot.replaceChildren(...kids(btn({ class: 'btn block', id: 'cardAgain', onclick: () => ((next = 'read'), (summary = null), hold()) }, 'again', t('fund.card.tryAgain'))));
      };

      /**
       * The words for a failure; the card waits for the next tap where one can help. from: 'finish' when
       * the failure came from finishing an earlier payment, so its own form comes back.
       */
      const failed = (e, from = null) => {
        const words = wordsFor(e, t);
        if (e?.code === 'tap_lost' || e?.code === 'unfinished' || e?.code === 'other_card') {
          if (e.code === 'unfinished') next = 'read';
          hold(words);
          return;
        }
        if (['pin_wrong', 'pin_needed', 'pin_blocked'].includes(e?.code)) {
          // A PIN the card refused is never sent again on its own: the next tap only reads the card,
          // and the person types the PIN again.
          next = 'read';
          if (choice) choice.pin = '';
        }
        if (summary && ['pin_wrong', 'pin_needed', 'too_small', 'all_only', 'over_max'].includes(e?.code)) {
          if (from === 'finish') showFinish();
          else showForm();
          msg.set(words, 'err');
          return;
        }
        body.replaceChildren(...kids(art(), ui.sayEl('p', { class: 'msg err', id: 'cardResult', role: 'status' }, words, 'err')));
        foot.replaceChildren(...kids(btn({ class: 'btn block', id: 'cardAgain', onclick: () => ((next = 'read'), (summary = null), hold()) }, 'again', t('fund.card.tryAgain'))));
      };

      /** Tokens the read finished (a tap that broke earlier) go where they belong. */
      const handFinished = async () => {
        await cards.flow.resume((job) => cards.handToken(job, { wallet, vault, engineBase: engine.base ?? '', message: t('fund.card.toOtherMint') }));
        await wallet.refresh();
      };

      const read = async () => {
        working(t('fund.card.reading'));
        try {
          summary = await cards.flow.read(current.transceive);
          await handFinished().catch(() => {});
          if (summary.unfinished) {
            next = 'finish';
            // The PIN was given on this screen for this same card: use it, the card is here. A PIN typed
            // for another card is never sent to this one.
            if ((choice?.pin && choice.cardKey === summary.pubkey) || summary.pinState !== 'set') return finish();
            return showFinish();
          }
          if (!summary.balance) throw Object.assign(new Error('empty'), { code: 'empty' });
          takeInfo(await cards.flow.mintInfo(summary, { acceptUnlisted }));
        } catch (e) {
          if (e?.code === 'mint_unlisted') return showUnlisted(e);
          summary = e?.code === 'empty' ? summary : null;
          return failed(e);
        }
        const balanceUnit = wallet.key() ? wallet.unit() : null;
        route = routeFor(info, { unit: summary.unit, units: wallet.units(), balanceUnit, otherMint: !!wallet.methods()?.foreign?.enabled, convert: !!balanceUnit && !!wallet.methods()?.convert?.units?.includes(balanceUnit) });
        if (route === 'wrong_unit') return refuse(t('fund.card.wrongUnit', { unit: t(UNIT_WORD[summary.unit] ?? 'unit.other') }));
        if (route === 'wrong_mint') return refuse(t('fund.card.wrongMint'));
        showForm();
        if (changeWaiting) msg.set(t('fund.card.changeBack'), 'ok');
        changeWaiting = false;
      };

      /** The relay's answer about the card's mint; another mint's cap limits what one tap moves. */
      const takeInfo = (i) => {
        info = i;
        if (Number.isSafeInteger(i?.max) && i.max > 0 && summary.max > i.max) summary = { ...summary, max: i.max };
      };

      const showUnlisted = (e) => {
        body.replaceChildren(...kids(art(), ui.el('div', { class: 'notice', id: 'cardUnlisted' }, ui.sayEl('p', {}, t('fund.othermint.unlisted')), ui.sayEl('p', { class: 'mono note' }, e.mint ?? ''))));
        foot.replaceChildren(...kids(
          btn({ class: 'btn primary block', id: 'cardGoOn', onclick: () => ((acceptUnlisted = true), (next = 'read'), hold(t('fund.card.holdAgain'))) }, 'next', t('fund.othermint.goOn')),
        ));
      };

      const pinField = (id) => {
        if (summary.pinState !== 'set') return { node: null, value: () => '' };
        const input = ui.el('input', { id, class: 'field-input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: '8', pattern: '[0-9]*' });
        const tries = summary.triesLeft < 3 ? ui.sayEl('p', { class: 'note', id: 'cardTries' }, summary.triesLeft === 1 ? t('fund.card.tryLeft') : t('fund.card.triesLeft', { count: summary.triesLeft })) : null;
        return { node: ui.el('div', { class: 'field' }, ui.el('label', { for: id, class: 'label', text: t('fund.card.pinLabel') }), input, tries), value: () => input.value.trim(), input };
      };

      /** A card left something unfinished with this phone: its PIN, then a tap, finishes it. */
      const showFinish = () => {
        const pin = pinField('cardFinishPin');
        body.replaceChildren(...kids(art(format.units(summary.balance, summary.unit)), ui.sayEl('p', { id: 'cardToFinish' }, t('fund.card.toFinish')), pin.node, msg));
        foot.replaceChildren(...kids(
          btn(
            {
              class: 'btn primary block',
              id: 'cardFinish',
              onclick: () => {
                if (summary.pinState === 'set' && !/^[0-9]{4,8}$/.test(pin.value())) return msg.set(t('fund.card.pinBad'), 'err');
                choice = { pin: pin.value(), cardKey: summary.pubkey };
                next = 'finish';
                go();
              },
            },
            'check',
            t('fund.card.finish'),
          ),
        ));
      };

      const finish = async () => {
        working(t('fund.card.moving'));
        try {
          summary = await cards.flow.finish(current.transceive, { summary, pin: choice?.pin ?? '' });
          await handFinished();
          next = 'read';
          if (!summary.balance) {
            toastAndDone(null);
            return;
          }
          takeInfo(await cards.flow.mintInfo(summary, { acceptUnlisted }));
          showForm();
        } catch (e) {
          failed(e, 'finish');
        }
      };

      /** How much and the PIN, and what the person gets, before the card signs anything. */
      const showForm = () => {
        const unit = summary.unit;
        const all = ui.el('button', { type: 'button', role: 'radio', 'aria-checked': 'true', id: 'cardAll', text: t('fund.card.all') });
        const some = ui.el('button', { type: 'button', role: 'radio', 'aria-checked': 'false', id: 'cardSome', text: t('fund.card.some') });
        const amountInput = ui.el('input', { id: 'cardAmount', class: 'field-input', inputmode: 'numeric', autocomplete: 'off', hidden: true, 'aria-label': t('fund.card.amountLabel') });
        const pin = pinField('cardPin');
        const preview = ui.el('div', { class: 'card-preview', id: 'cardPreview' });
        const moveBtn = btn({ class: 'btn primary block', id: 'cardMove' }, 'plus', '');
        let plan = null;
        const amount = () => (all.getAttribute('aria-checked') === 'true' ? summary.max : Number(amountInput.value.trim()));
        const update = () => {
          plan = null;
          const a = amount();
          if (!Number.isSafeInteger(a) || a < 1 || a > summary.max) {
            preview.replaceChildren(...kids(ui.sayEl('p', { class: 'note' }, t('fund.card.badAmount', { amount: format.units(summary.max, unit) }))));
            moveBtn.disabled = true;
            moveBtn.lastChild.textContent = t('fund.card.move', { amount: '' }).trim();
            return;
          }
          try {
            plan = cards.flow.plan(summary, info, a);
          } catch (e) {
            preview.replaceChildren(...kids(ui.sayEl('p', { class: 'msg err' }, wordsFor(e, t), 'err')));
            moveBtn.disabled = true;
            return;
          }
          const back = plan.selected - plan.amount;
          preview.replaceChildren(...kids(
            // Another mint's eCash still goes through Other mint, which shows its own price: what is
            // known here is only what reaches this phone.
            ui.sayEl('p', { class: 'card-get', id: 'cardGet' }, t(route === 'othermint' ? (info?.trusted ? 'fund.card.toPhoneChange' : 'fund.card.toPhone') : 'fund.card.youGet', { amount: format.units(plan.receive, unit) })),
            plan.fee ? ui.sayEl('p', { class: 'note', id: 'cardFee' }, t('fund.card.fee', { amount: format.units(plan.fee, unit) })) : null,
            back ? ui.sayEl('p', { class: 'note', id: 'cardBack' }, t('fund.card.backToCard', { amount: format.units(back, unit) })) : null,
          ));
          moveBtn.disabled = false;
          moveBtn.lastChild.textContent = t('fund.card.move', { amount: format.units(plan.amount, unit) });
        };
        const pick = (which) => {
          all.setAttribute('aria-checked', String(which === all));
          some.setAttribute('aria-checked', String(which === some));
          amountInput.hidden = which === all;
          if (which === some) amountInput.focus();
          update();
        };
        all.addEventListener('click', () => pick(all));
        some.addEventListener('click', () => pick(some));
        amountInput.addEventListener('input', update);
        const invite = route === 'topup' ? inviteField(inputs) : { node: null, missing: () => false };
        body.replaceChildren(...kids(
          art(format.units(summary.balance, unit)),
          ui.sayEl('p', { class: 'note note-mint', id: 'cardMint' }, t('fund.card.from', { mint: mintLabel(summary.mint) })),
          summary.max < summary.balance ? ui.sayEl('p', { class: 'note', id: 'cardPart' }, t('fund.card.partOnly', { amount: format.units(summary.max, unit) })) : null,
          invite.node,
          ui.el('div', { class: 'field' }, ui.sayEl('p', { class: 'label', id: 'cardHowMuch' }, t('fund.card.howMuch')), ui.el('div', { class: 'seg', role: 'radiogroup', 'aria-labelledby': 'cardHowMuch' }, all, some), amountInput),
          pin.node,
          preview,
          msg,
        ));
        foot.replaceChildren(...kids(moveBtn));
        moveBtn.addEventListener('click', () => {
          if (!plan || invite.missing(msg)) return;
          if (summary.pinState === 'set' && !/^[0-9]{4,8}$/.test(pin.value())) {
            msg.set(t('fund.card.pinBad'), 'err');
            return pin.input?.focus();
          }
          choice = { plan, pin: pin.value(), cardKey: summary.pubkey };
          next = 'pay';
          go();
        });
        update();
      };

      /** Goes on with the card in the field now, or waits for it. */
      const go = async () => {
        if (busy) return;
        if (!current) return hold(t('fund.card.holdAgain'));
        busy = true;
        try {
          if (next === 'pay') await pay();
          else if (next === 'finish') await finish();
        } finally {
          busy = false;
        }
      };

      const pay = async () => {
        working(t('fund.card.moving'));
        let job;
        try {
          job = await cards.flow.pay(current.transceive, { summary, info, plan: choice.plan, pin: choice.pin, acceptUnlisted, route });
        } catch (e) {
          // The card left before anything was asked of it: wait for it, the choice stands.
          if (e?.code === 'tap_lost') {
            current = null;
            return hold(t('fund.card.holdAgain'));
          }
          if (e?.code === 'unfinished') current = null;
          return failed(e);
        }
        next = 'read';
        working(t('fund.card.adding'));
        let r;
        try {
          r = await cards.handToken(job, { wallet, vault, engineBase: engine.base ?? '', message: t(info?.trusted ? 'fund.card.toChange' : 'fund.card.toOtherMint') });
          cards.flow.handed(job.id);
        } catch (e) {
          return failed({ code: 'mint_unavailable', kept: true, message: e?.message });
        }
        // The engine's own eCash in the other unit: the eCash module shows the price to change it.
        if (r.route === 'othermint') return open(info?.trusted ? 'ecash' : 'othermint', { token: job.token });
        await wallet.refresh();
        if (r.error) return failed({ code: 'mint_unavailable', kept: true });
        const words = r.replay ? t('fund.ecash.replay') : t('fund.card.added', { amount: format.units(r.credited, r.unit) });
        if (job.changeOwed) {
          // The eCash is here; the card's change waits for one more tap (it is read again then).
          summary = null;
          changeWaiting = true;
          current = null;
          ui.toast(words);
          hold(t('fund.card.changeOwed'));
          return;
        }
        toastAndDone(words, choice.plan.amount === summary.balance);
      };

      const toastAndDone = (words, empty = false) => {
        if (words) ui.toast(empty ? `${words} ${t('fund.card.emptyNow')}` : words);
        done();
      };

      startReading().catch((e) => failed(e));
      return {
        node,
        destroy() {
          gone = true;
          reader?.stop();
        },
      };
    },
  };
}

function mintLabel(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}
