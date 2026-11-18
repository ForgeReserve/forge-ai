// Fund module: eCash from another mint. Wraps POST /v1/wallet/fund/foreign/quote and .../confirm and
// GET /v1/wallet/fund/:id, the flow v1's wallet uses: the engine pays a Forge Lightning invoice from
// the other mint and credits what arrives. The token is kept on the phone, with the funding id, from
// confirm until the engine reports the outcome; if the person leaves this screen first, the app looks
// the outcome up on start and on Funds (kit.js, settlePendingForeign). eCash the engine sends back
// (unused fees, or the token's value when the payment fails) is kept on the phone until the person
// saves it. Its amount is not known here, so it is shown without one. A token handed over by another
// fund module (a scanned paper note) fills the box and is checked at once.
import { isNoteUnit, readNote } from '../../../core/note.js';
import { foreignQuote, fundIn, inviteField, tokenBox } from '../kit.js';

export function create(inputs) {
  const { t, ui, engine, wallet } = inputs;
  return {
    id: 'othermint',
    group: 'depends',
    icon: 'swap',
    available: (methods) => !!methods?.foreign?.enabled,
    view({ done, added, open, token: given }) {
      // The unit is read when the price is asked for: a screen opened before the balance was read
      // (the app opened on this address) still asks in the balance's unit. eCash in sats goes to the sat
      // balance and eCash in dollars to the dollar one (wallet.landsIn), the second opened with the
      // first one's key.
      const unitNow = (token) => {
        const note = readNote(token);
        if (note.ok && isNoteUnit(note.unit) && wallet.landsIn) return wallet.landsIn(note.unit);
        return wallet.unit() ?? (wallet.methods()?.lightning?.units ?? ['usd', 'sat'])[0];
      };
      const msg = ui.msgLine();
      const invite = inviteField(inputs);
      const check = ui.el('button', { type: 'button', class: 'btn primary block', id: 'foreignCheck' }, ui.icon('swap', 20), ui.el('span', { text: t('fund.othermint.check') }));
      const box = tokenBox(inputs, { id: 'foreignToken', label: t('fund.othermint.label'), onScanned: () => check.click() });
      const unlisted = ui.el('div', { class: 'notice', hidden: true });
      // eCash from the engine's own mint goes to eCash, with the token.
      const onward = ui.el('div', { class: 'onward', hidden: true });
      const body = ui.el('div', { class: 'scroll fund-body' }, invite.node, ui.sayEl('p', {}, t('fund.othermint.what')), box.node, msg, onward, unlisted);
      const foot = ui.el('div', { class: 'foot' }, check);
      let poller = null;

      /** An unknown mint asks first: then Go on is the lit button, and Check eCash waits beside it. */
      const asking = (on) => {
        unlisted.hidden = !on;
        check.classList.toggle('primary', !on);
      };
      const quote = async (token, acceptUnlisted = false) => {
        check.disabled = true;
        onward.hidden = true;
        msg.set(t('fund.othermint.checking'));
        try {
          const unit = unitNow(token);
          const r = await fundIn(wallet, unit, invite.value(), (key, code, sibling) => engine.foreignQuote(key, { token, unit, invite: code, pubkey: wallet.lockKey() || undefined, ...(acceptUnlisted ? { accept_unlisted: true } : {}) }, sibling));
          // The engine would not open that balance: the price again, in the unit the phone holds.
          if (r.body?.error?.code === 'sibling_refused') return quote(token, acceptUnlisted);
          if (!r.ok) {
            const code = r.body?.error?.code;
            if (code === 'mint_unlisted') {
              unlisted.replaceChildren(ui.sayEl('p', {}, t('fund.othermint.unlisted')), ui.sayEl('p', { class: 'mono note' }, r.body?.unlisted?.mint ?? ''), ui.el('button', { type: 'button', class: 'btn primary', id: 'foreignGoOn', onclick: () => quote(token, true) }, ui.icon('next', 20), ui.el('span', { text: t('fund.othermint.goOn') })));
              asking(true);
              return msg.set('');
            }
            if (code === 'use_topup') {
              onward.replaceChildren(ui.el('button', { type: 'button', class: 'btn block', id: 'foreignUseEcash', onclick: () => open('ecash', { token }) }, ui.icon('coins', 20), ui.el('span', { text: t('fund.ecash.name') })));
              onward.hidden = false;
              return msg.set(t('fund.othermint.useEcash'), 'err');
            }
            return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
          }
          asking(false);
          poller = foreignQuote(inputs, { body, foot, f: r.body, token, done, added });
        } catch (e) {
          msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          check.disabled = false;
        }
      };

      check.addEventListener('click', () => {
        const token = box.value();
        if (!/^cashu[AB]/.test(token)) return msg.set(t('fund.ecash.bad'), 'err');
        if (invite.missing(msg)) return;
        quote(token);
      });
      // A token handed over by another fund module (a scanned note from another mint): ask for the price
      // at once, so the person sees the amount and the fees before confirming.
      if (given) {
        box.input.value = given;
        queueMicrotask(() => check.click());
      }
      return {
        node: ui.el('div', { class: 'fund-view' }, body, foot),
        destroy: () => {
          poller?.stop();
          box.stop();
        },
      };
    },
  };
}
