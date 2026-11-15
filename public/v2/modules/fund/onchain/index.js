// Fund module: on-chain bitcoin. Wraps POST /v1/wallet/fund/onchain and GET /v1/wallet/fund/:id, the
// flow v1's wallet uses: a deposit address, credited to a sat balance once it confirms.
import { inviteField, poll, requestQR } from '../kit.js';

export function create(inputs) {
  const { t, ui, engine, wallet, format } = inputs;
  return {
    id: 'onchain',
    group: 'depends',
    icon: 'chain',
    available: (methods) => !!methods?.onchain?.enabled,
    view({ done }) {
      const O = wallet.methods()?.onchain ?? {};
      if (wallet.key() && wallet.unit() && wallet.unit() !== 'sat') return { node: ui.el('div', { class: 'scroll fund-body' }, ui.sayEl('p', {}, t('fund.onchain.satOnly'))) };
      const msg = ui.msgLine();
      const invite = inviteField(inputs);
      const go = ui.el('button', { type: 'button', class: 'btn primary block', id: 'onchainGet' }, ui.icon('qr', 20), ui.el('span', { text: t('fund.onchain.get') }));
      const body = ui.el(
        'div',
        { class: 'scroll fund-body' },
        invite.node,
        ui.sayEl('p', {}, t('fund.onchain.what')),
        ui.sayEl('p', { class: 'note' }, t('fund.onchain.min', { amount: format.units(O.min_amount ?? 0, 'sat') })),
        ui.sayEl('p', { class: 'note' }, t('fund.onchain.confirmations', { count: O.confirmations || 3 })),
        msg,
      );
      const foot = ui.el('div', { class: 'foot' }, go);
      let poller = null;
      go.addEventListener('click', async () => {
        if (invite.missing(msg)) return;
        go.disabled = true;
        msg.set(t('fund.onchain.getting'));
        try {
          const r = await engine.fundOnchain(wallet.key(), { invite: invite.value() });
          if (r.body?.key) wallet.setKey(r.body.key);
          if (!r.ok) return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
          const f = r.body;
          const need = f.onchain?.confirmations_required ?? O.confirmations ?? 3;
          const st = ui.sayEl('p', { class: 'status-line', role: 'status' }, t('fund.onchain.watching'));
          let last = f.credited ?? 0;
          body.replaceChildren(requestQR(inputs, { uri: 'bitcoin:' + f.request, copyText: f.request, copyLabel: t('fund.onchain.copy'), qrLabel: t('fund.onchain.qr') }), ui.sayEl('p', { class: 'mono keyline' }, f.request.match(/.{1,4}/g).join(' ')), st, ui.sayEl('p', { class: 'note' }, t('fund.onchain.close')));
          foot.replaceChildren(ui.el('button', { type: 'button', class: 'btn primary block', text: t('fund.done'), onclick: done }));
          const update = (x) => {
            const o = x.onchain ?? {};
            if (x.state === 'failed') {
              ui.say(st, t('fund.failed', { message: x.error ?? '' }));
              return true;
            }
            if (x.credited > 0 && x.state !== 'minting') ui.say(st, t('fund.onchain.credited', { amount: format.units(x.credited, 'sat') }));
            else if (x.state === 'minting') ui.say(st, t('fund.lightning.minting'));
            else if (o.seen_sat) ui.say(st, t('fund.onchain.seen', { amount: format.units(o.seen_sat, 'sat'), count: o.confirmations ?? 0, need }));
            if ((x.credited ?? 0) !== last) {
              last = x.credited ?? 0;
              wallet.refresh();
            }
            return x.state === 'expired';
          };
          if (!update(f))
            poller = poll(async () => {
              const s = await engine.funding(wallet.key(), f.id);
              return s.ok ? update(s.body) : false;
            }, 15000);
        } catch (e) {
          msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          go.disabled = false;
        }
      });
      return { node: ui.el('div', { class: 'fund-view' }, body, foot), destroy: () => poller?.stop() };
    },
  };
}
