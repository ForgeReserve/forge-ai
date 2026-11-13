// Fund module: eCash from another mint. Wraps POST /v1/wallet/fund/foreign/quote and .../confirm and
// GET /v1/wallet/fund/:id, the flow v1's wallet uses: the engine pays a Forge Lightning invoice from
// the other mint and credits what arrives. The token is kept on the phone from confirm until the engine
// reports the outcome; eCash the engine sends back (unused fees, or the whole amount when the payment
// fails) is kept on the phone until the person saves it.
import { inviteField, poll, tokenBox } from '../kit.js';

export function create(inputs) {
  const { t, ui, engine, wallet, vault, format } = inputs;
  return {
    id: 'othermint',
    group: 'depends',
    icon: 'swap',
    available: (methods) => !!methods?.foreign?.enabled,
    view({ done }) {
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
      const keepReturned = (f, token, kind) => vault.keepRefund({ id: `${f.id}_${kind}`, token, amount: f.foreign?.token_amount ?? 0, unit: f.foreign?.unit ?? unit });

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
        const finish = () => foot.replaceChildren(ui.el('button', { type: 'button', class: 'btn primary block', id: 'fundDone', text: t('fund.done'), onclick: done }));
        const update = (x) => {
          const xf = x.foreign ?? q;
          const steps = { receiving: 'fund.othermint.receiving', melting: 'fund.othermint.melting', pending: 'fund.othermint.pending', minting: 'fund.othermint.minting' };
          if (x.state === 'done') {
            st.textContent = t('fund.othermint.done', { amount: format.units(x.credited, x.unit) });
            if (held) vault.credited(held.id);
            if (xf.change_token) {
              keepReturned(x, xf.change_token, 'change');
              returned.replaceChildren(ui.el('p', { class: 'note', text: t('fund.othermint.change') }));
            }
            wallet.refresh();
            finish();
            return !xf.payout_pending;
          }
          if (x.state === 'refunded') {
            st.textContent = t('fund.othermint.refunded');
            if (xf.refund_token) {
              keepReturned(x, xf.refund_token, 'refund');
              if (held) vault.credited(held.id);
              returned.replaceChildren(ui.el('textarea', { class: 'field-input mono', readonly: true, rows: '3', text: xf.refund_token }));
            }
            finish();
            return !xf.payout_pending;
          }
          if (x.state === 'failed' || x.state === 'expired') {
            st.textContent = x.state === 'expired' ? t('fund.othermint.expired') : t('fund.failed', { message: x.error ?? '' });
            if (held) vault.refused(held.id, x.state, x.error ?? x.state);
            finish();
            return true;
          }
          if (steps[x.state]) st.textContent = t(steps[x.state]);
          return false;
        };
        confirm.addEventListener('click', async () => {
          confirm.disabled = true;
          st.textContent = t('fund.othermint.receiving');
          held = vault.hold(token, 'othermint');
          try {
            const r = await engine.foreignConfirm(wallet.key(), { id: f.id, token, pubkey: wallet.lockKey() || undefined });
            if (!r.ok) {
              // Not taken: the eCash stays on the phone, listed under Funds as not added, so it can be copied.
              vault.refused(held.id, r.body?.error?.code ?? `http_${r.status}`, r.body?.error?.message ?? `HTTP ${r.status}`);
              st.textContent = t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` });
              confirm.disabled = false;
              return;
            }
            if (!update(r.body))
              poller = poll(async () => {
                const s = await engine.funding(wallet.key(), f.id);
                return s.ok ? update(s.body) : false;
              }, 2000);
          } catch {
            poller = poll(async () => {
              const s = await engine.funding(wallet.key(), f.id);
              return s.ok ? update(s.body) : false;
            }, 3000);
          }
        });
      };

      check.addEventListener('click', () => {
        const token = box.value();
        if (!/^cashu[AB]/.test(token)) return msg.set(t('fund.ecash.bad'), 'err');
        if (invite.missing(msg)) return;
        quote(token);
      });
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
