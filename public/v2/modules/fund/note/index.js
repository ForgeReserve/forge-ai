// Fund module: Scan a note. The camera (through the camera adapter and v1's scanner, so a single or an
// animated code both work) reads the eCash on a paper note. The phone shows the amount and the mint
// before anything is sent, and adds it on one tap through wallet.topup, which stores the note's eCash on
// the phone before sending it and removes it only once the engine confirms the credit (core/vault.js).
//
// A note from a mint the engine does not take says so and offers the other-mint path when the engine
// has one. Whether a note was already used is known only to its mint, so the phone learns it when the
// engine refuses the note (token_spent), and says so.
import { isNoteUnit, mintLabel, noteVerdict, readNote, refusalOf } from '../../../core/note.js';
import { inviteField } from '../kit.js';

const UNIT_WORD = { usd: 'unit.usd', sat: 'unit.sat' };
const REASON = { empty: 'fund.note.unreadable', not_ecash: 'fund.note.notEcash', old_format: 'fund.note.oldFormat', unreadable: 'fund.note.unreadable' };

export function create(inputs) {
  const { t, ui, wallet, format, scan } = inputs;
  return {
    id: 'note',
    group: 'unlinked',
    icon: 'qr',
    available: () => true,
    view({ done, open }) {
      const msg = ui.msgLine();
      const body = ui.el('div', { class: 'scroll fund-body' });
      const foot = ui.el('div', { class: 'foot' });
      let job = null;
      let runs = 0; // each stop() ends the scan in progress; a later answer from it is ignored
      let busy = false;

      const stop = () => {
        runs++;
        job?.stop();
        job = null;
      };

      const btn = (attrs, ico, label) => ui.el('button', { type: 'button', ...attrs }, ico ? ui.icon(ico, 20) : null, ui.el('span', { text: label }));

      /** The camera, with Paste instead for a phone or laptop without one. */
      const scanning = async () => {
        stop();
        const mine = runs;
        msg.set('');
        const video = ui.el('video', { muted: true, playsinline: true, 'aria-label': t('fund.note.point') });
        const progress = ui.el('p', { class: 'note', id: 'noteProgress', role: 'status' });
        const paste = btn({ class: 'btn block', id: 'notePaste', onclick: () => pasting() }, 'copy', t('fund.note.paste'));
        if (!scan?.available()) {
          body.replaceChildren(ui.el('p', { id: 'noteNoCamera', text: t('fund.note.noCamera') }));
          return pasting();
        }
        body.replaceChildren(ui.el('div', { class: 'scanner' }, video), ui.el('p', { class: 'note-hint', text: t('fund.note.point') }), progress, msg);
        foot.replaceChildren(paste);
        try {
          const started = await scan.open(video, (p) => {
            if (p > 0 && p < 1) progress.textContent = t('fund.note.reading', { percent: Math.round(p * 100) });
          });
          // Left or chose Paste while the camera was starting: turn it off again.
          if (mine !== runs) return started.stop();
          job = started;
          const text = await job.promise;
          if (mine !== runs) return;
          stop();
          show(text);
        } catch {
          if (mine !== runs) return; // stopped: the person left or chose Paste
          stop();
          msg.set(t('fund.note.cameraFailed'), 'err');
          pasting();
        }
      };

      /** Paste the code from the note, for when there is no camera. */
      const pasting = () => {
        stop();
        const ta = ui.el('textarea', { id: 'noteText', rows: '4', class: 'field-input mono', placeholder: 'cashuB...', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off' });
        const read = btn({ class: 'btn primary block', id: 'noteRead', onclick: () => show(ta.value) }, null, t('fund.note.read'));
        const keep = msg.textContent ? [msg] : [];
        body.replaceChildren(...[...body.children].filter((n) => n.id === 'noteNoCamera'), ...keep, ui.el('div', { class: 'field' }, ui.el('label', { for: 'noteText', class: 'label', text: t('fund.note.pasteLabel') }), ta));
        foot.replaceChildren(...[read, scan?.available() ? btn({ class: 'btn block', id: 'noteScanAgain', onclick: scanning }, 'qr', t('fund.note.again')) : null].filter(Boolean));
        ta.focus();
      };

      /** What was read: the amount and the mint, and the one next step. */
      const show = (text) => {
        msg.set('');
        const note = readNote(text);
        const camera = !!scan?.available();
        const again = btn({ class: 'btn block', id: 'noteScanAgain', onclick: () => (camera ? scanning() : pasting()) }, camera ? 'qr' : 'copy', camera ? t('fund.note.again') : t('fund.note.pasteAgain'));
        if (!note.ok) {
          body.replaceChildren(ui.el('p', { class: 'msg err', id: 'noteResult', role: 'status', text: t(REASON[note.reason]) }));
          foot.replaceChildren(again);
          return;
        }
        // An amount is shown only in a unit the phone formats exactly (usd, sat); any other unit is refused
        // before its amount could be shown wrong. A voucher of free questions (from the engine's credit
        // mint) is counted in questions: it is not money.
        const credit = !!wallet.isCredit?.(note.mint);
        const known = isNoteUnit(note.unit);
        const amount = credit ? t(note.amount === 1 ? 'fund.note.freeOne' : 'fund.note.free', { count: note.amount }) : known ? format.units(note.amount, note.unit) : '';
        const mintLine = ui.el('p', { class: 'note note-mint', id: 'noteMint', text: credit ? t('fund.note.freeFrom') : t('fund.note.from', { mint: mintLabel(note.mint) }) });
        const head = known ? [ui.el('div', { class: 'amount-tag', id: 'noteAmount', text: amount }), mintLine] : [mintLine];
        const methods = wallet.methods();
        const otherMintBtn = () => btn({ class: 'btn primary block', id: 'noteOtherMint', onclick: () => open('othermint', { token: note.token }) }, 'swap', t('fund.note.useOtherMint'));
        const refused = (kind) => {
          const words = { spent: t('fund.note.spent'), other_mint: t('fund.note.otherMint'), wrong_mint: t('fund.note.wrongMint'), wrong_unit: t('fund.note.wrongUnit', { unit: t(UNIT_WORD[note.unit] ?? 'unit.other') }) }[kind];
          body.replaceChildren(...head, ui.el('p', { class: 'msg err', id: 'noteResult', role: 'status', text: words }));
          foot.replaceChildren(...[kind === 'other_mint' && methods?.foreign?.enabled ? otherMintBtn() : null, again].filter(Boolean));
        };
        if (!known) return refused('wrong_unit');
        // Free questions go on their own balance, so the paid balance's unit and the invite do not apply.
        const verdict = credit ? 'add' : noteVerdict(note, { mints: wallet.mints(), aliases: wallet.mintAliases(), units: wallet.units(), balanceUnit: wallet.key() ? wallet.unit() : null, otherMint: !!methods?.foreign?.enabled });
        if (verdict !== 'add') return refused(verdict);

        const invite = credit ? { node: null, missing: () => false, value: () => undefined } : inviteField(inputs);
        const add = btn({ class: 'btn primary block', id: 'noteAdd' }, 'plus', t('fund.note.add', { amount }));
        body.replaceChildren(...head, invite.node ?? '', msg);
        foot.replaceChildren(add, again);
        add.addEventListener('click', async () => {
          if (busy || invite.missing(msg)) return;
          busy = true;
          add.disabled = true;
          msg.set(t('fund.note.adding'));
          try {
            const r = await wallet.topup(note.token, invite.value());
            const words = r.replay ? t('fund.note.replay') : r.free ? t('fund.free.added', { count: r.credited }) : t('fund.note.added', { amount: format.units(r.credited, r.unit) });
            ui.toast(words);
            msg.set(words, 'ok');
            await wallet.refresh();
            done();
          } catch (e) {
            const kind = refusalOf(e);
            if (kind === 'kept') msg.set(t('fund.note.kept'), 'err');
            else if (kind === 'failed') msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
            else refused(kind === 'other_mint' && !methods?.foreign?.enabled ? 'wrong_mint' : kind);
          } finally {
            busy = false;
            add.disabled = false;
          }
        });
      };

      scanning();
      return { node: ui.el('div', { class: 'fund-view note-view' }, body, foot), destroy: stop };
    },
  };
}
