// Fund module: eCash from another mint. Wraps POST /v1/wallet/fund/foreign/quote and .../confirm and
// GET /v1/wallet/fund/:id, the flow v1's wallet uses: the engine pays a Forge Lightning invoice from
// the other mint and credits what arrives. The token is kept on the phone, with the funding id, from
// confirm until the engine reports the outcome; if the person leaves this screen first, the app looks
// the outcome up on start and on Funds (kit.js, settlePendingForeign). eCash the engine sends back
// (unused fees, or the token's value when the payment fails) is kept on the phone until the person
// saves it. Its amount is not known here, so it is shown without one. A token handed over by another
// fund module (a scanned paper note) fills the box and is checked at once.
import { confirmOutcome, inviteField, poll, settleForeign, tokenBox } from '../kit.js';

export function create(inputs) {
  const { t, ui, engine, wallet, vault, format } = inputs;
  return {
    id: 'othermint',
    group: 'depends',
    icon: 'swap',
    available: (methods) => !!methods?.foreign?.enabled,
    view({ done, token: given }) {
      const units = wallet.key() && wallet.unit() ? [wallet.unit()] : (wallet.methods()?.lightning?.units ?? ['usd', 'sat']);
      const unit = wallet.unit() ?? units[0];
      const msg = ui.msgLine();
      const invite = inviteField(inputs);
      const check = ui.el('button', { type: 'button', class: 'btn primary block', id: 'foreignCheck', text: t('fund.othermint.check') });
      const box = tokenBox(inputs, { id: 'foreignToken', label: t('fund.othermint.label'), onScanned: () => check.click() });
      const unlisted = ui.el('div', { class: 'notice', hidden: true });
      const body = ui.el('div', { class: 'scroll fund-body' }, invite.node, ui.el('p', { text: t('fund.othermint.what') }), box.node, msg, unlisted);
      const foot = ui.el('div', { class: 'foot' }, check);
      let poller = null;

      const quote = async (token, acceptUnlisted = false) => {
        check.disabled = true;
        msg.set(t('fund.othermint.checking'));
        try {
          const r = await engine.foreignQuote(wallet.key(), { token, unit, invite: invite.value(), pubkey: wallet.lockKey() || undefined, ...(acceptUnlisted ? { accept_unlisted: true } : {}) });
          if (r.body?.key) wallet.setKey(r.body.key);
          if (!r.ok) {
            const code = r.body?.error?.code;
            if (code === 'mint_unlisted') {
              unlisted.replaceChildren(ui.el('p', { text: t('fund.othermint.unlisted') }), ui.el('p', { class: 'mono note', text: r.body?.unlisted?.mint ?? '' }), ui.el('button', { type: 'button', class: 'btn', id: 'foreignGoOn', text: t('fund.othermint.goOn'), onclick: () => quote(token, true) }));
              unlisted.hidden = false;
              return msg.set('');
            }
            if (code === 'use_topup') return msg.set(t('fund.othermint.useEcash'), 'err');
            return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
          }
          unlisted.hidden = true;
          showQuote(r.body, token);
        } catch (e) {
          msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          check.disabled = false;
        }
      };

      const showQuote = (f, token) => {
        const q = f.foreign;
        const st = ui.el('p', { class: 'status-line', id: 'foreignStatus', role: 'status' });
        const confirm = ui.el('button', { type: 'button', class: 'btn primary block', id: 'foreignConfirm', text: t('fund.othermint.confirm', { amount: format.units(q.credit, f.unit) }) });
        const returned = ui.el('div', { class: 'returned' });
        body.replaceChildren(ui.el('div', { class: 'amount-tag', text: format.units(q.credit, f.unit) }), ui.el('p', { class: 'note', text: t('fund.othermint.fees', { amount: format.units(q.fee_max, q.unit) }) }), st, returned);
        foot.replaceChildren(confirm);
        let held = null;
        let refreshed = false;
        const finish = () => foot.replaceChildren(ui.el('button', { type: 'button', class: 'btn primary block', id: 'fundDone', text: t('fund.done'), onclick: done }));
        const update = (x) => {
          const xf = x.foreign ?? q;
          const steps = { receiving: 'fund.othermint.receiving', melting: 'fund.othermint.melting', pending: 'fund.othermint.pending', minting: 'fund.othermint.minting' };
          // The vault first: the outcome is stored before anything is shown.
          const r = settleForeign(vault, held, x);
          if (x.state === 'done') {
            st.textContent = t('fund.othermint.done', { amount: format.units(x.credited, x.unit) });
            if (xf.change_token) returned.replaceChildren(ui.el('p', { class: 'note', text: t('fund.othermint.change') }));
            if (!refreshed) wallet.refresh();
            refreshed = true;
            finish();
            return r.final;
          }
          if (x.state === 'refunded') {
            st.textContent = xf.refund_token || xf.payout_pending ? t('fund.othermint.refunded') : t('fund.failed', { message: x.error ?? '' });
            if (xf.refund_token) returned.replaceChildren(ui.el('textarea', { class: 'field-input mono', readonly: true, rows: '3', text: xf.refund_token }));
            finish();
            return r.final;
          }
          if (x.state === 'failed' || x.state === 'expired') {
            st.textContent = x.state === 'expired' ? t('fund.othermint.expired') : t('fund.failed', { message: x.error ?? '' });
            finish();
            return true;
          }
          if (steps[x.state]) st.textContent = t(steps[x.state]);
          return false;
        };
        const watch = (ms) =>
          (poller = poll(async () => {
            const s = await engine.funding(wallet.key(), f.id);
            return s.ok ? update(s.body) : false;
          }, ms));
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          st.textContent = t('fund.othermint.receiving');
          held = vault.hold(token, 'othermint', { fundingId: f.id });
          try {
            const r = await engine.foreignConfirm(wallet.key(), { id: f.id, token, pubkey: wallet.lockKey() || undefined });
            if (!r.ok) {
              const message = r.body?.error?.message ?? `HTTP ${r.status}`;
              if (confirmOutcome(r.status, r.body) === 'refused') {
                // Not taken: the eCash stays on the phone, listed under Funds as not added, so it can be copied.
                vault.refused(held.id, r.body?.error?.code ?? `http_${r.status}`, message);
                st.textContent = t('fund.failed', { message });
                confirm.disabled = false;
                return;
              }
              // The outcome is open (busy, a server error, or being processed now): keep the token pending
              // and watch the funding.
              vault.pending(held.id, r.body?.error?.code ?? `http_${r.status}`);
              st.textContent = t('fund.othermint.receiving');
              return watch(2000);
            }
            if (!update(r.body)) watch(2000);
          } catch {
            watch(3000);
          }
        });
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
