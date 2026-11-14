// Fund module: Lightning. Wraps POST /v1/wallet/fund/lightning and GET /v1/wallet/fund/:id, the flow
// v1's wallet uses: choose an amount, pay the invoice from any Lightning wallet, the engine credits it.
import { inviteField, poll, requestQR } from '../kit.js';

export function create(inputs) {
  const { t, ui, engine, wallet, format } = inputs;
  return {
    id: 'lightning',
    group: 'depends',
    icon: 'bolt',
    available: (methods) => !!methods?.lightning?.enabled,
    view({ done }) {
      const L = wallet.methods()?.lightning ?? {};
      const units = wallet.key() && wallet.unit() ? [wallet.unit()] : (L.units ?? ['usd']);
      let unit = wallet.unit() ?? (units.includes('usd') ? 'usd' : units[0]);
      const msg = ui.msgLine();
      const invite = inviteField(inputs);
      const input = ui.el('input', { id: 'lnAmount', class: 'field-input', inputmode: 'decimal', autocomplete: 'off', 'aria-label': t('fund.lightning.amountLabel') });
      const seg = ui.el('div', { class: 'seg', role: 'group', 'aria-label': t('fund.lightning.amountLabel') });
      const setUnit = (u) => {
        unit = u;
        input.value = format.plain(u === 'usd' ? 500 : 5000, u);
        input.inputMode = u === 'usd' ? 'decimal' : 'numeric';
        for (const b of seg.children) b.setAttribute('aria-pressed', String(b.dataset.unit === u));
      };
      if (units.length > 1) for (const u of units) seg.append(ui.el('button', { type: 'button', 'data-unit': u, text: u === 'usd' ? 'USD' : 'sat', onclick: () => setUnit(u) }));
      setUnit(unit);
      const go = ui.el('button', { type: 'button', class: 'btn primary block', id: 'lnCreate' }, ui.icon('bolt', 20), ui.el('span', { text: t('fund.lightning.create') }));
      const body = ui.el('div', { class: 'scroll fund-body' }, invite.node, ui.el('label', { for: 'lnAmount', class: 'label', text: t('fund.lightning.amount') }), input, units.length > 1 ? seg : null, msg);
      const foot = ui.el('div', { class: 'foot' }, go);
      const node = ui.el('div', { class: 'fund-view' }, body, foot);
      let poller = null;
      go.addEventListener('click', async () => {
        const amount = format.parse(input.value, unit);
        if (!Number.isInteger(amount) || amount < 1) return msg.set(unit === 'usd' ? t('fund.lightning.badAmount') : t('fund.lightning.badSats'), 'err');
        if (L.min?.[unit] && amount < L.min[unit]) return msg.set(t('fund.lightning.min', { amount: format.units(L.min[unit], unit) }), 'err');
        if (L.max?.[unit] && amount > L.max[unit]) return msg.set(t('fund.lightning.max', { amount: format.units(L.max[unit], unit) }), 'err');
        if (invite.missing(msg)) return;
        go.disabled = true;
        msg.set(t('fund.lightning.creating'));
        try {
          const r = await engine.fundLightning(wallet.key(), { amount, unit, invite: invite.value() });
          if (r.body?.key) wallet.setKey(r.body.key);
          if (!r.ok) return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
          const f = r.body;
          const st = ui.el('p', { class: 'status-line', id: 'lnStatus', role: 'status', text: t('fund.lightning.waiting') });
          body.replaceChildren(ui.el('div', { class: 'amount-tag', text: format.units(f.amount, f.unit) }), requestQR(inputs, { uri: 'lightning:' + f.request, copyText: f.request, copyLabel: t('fund.lightning.copy'), qrLabel: t('fund.lightning.qr'), openLabel: t('fund.lightning.open') }), st);
          foot.replaceChildren();
          const update = (x) => {
            if (x.state === 'done') {
              st.textContent = t('fund.lightning.paid', { amount: format.units(x.credited, x.unit) });
              st.className = 'status-line ok';
              wallet.refresh();
              foot.replaceChildren(ui.el('button', { type: 'button', class: 'btn primary block', id: 'fundDone', text: t('fund.done'), onclick: done }));
              return true;
            }
            if (x.state === 'minting') st.textContent = t('fund.lightning.minting');
            if (x.state === 'expired' || x.state === 'failed') {
              st.textContent = x.state === 'expired' ? t('fund.lightning.expired') : t('fund.failed', { message: x.error ?? '' });
              st.className = 'status-line err';
              return true;
            }
            return false;
          };
          if (!update(f))
            poller = poll(async () => {
              const s = await engine.funding(wallet.key(), f.id);
              return s.ok ? update(s.body) : false;
            }, 2000);
        } catch (e) {
          msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          go.disabled = false;
        }
      });
      return { node, destroy: () => poller?.stop() };
    },
  };
}
