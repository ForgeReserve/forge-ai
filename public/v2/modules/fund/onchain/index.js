// Fund module: on-chain bitcoin. Wraps POST /v1/wallet/fund/onchain and GET /v1/wallet/fund/:id, the
// flow v1's wallet uses: a deposit address, credited to a sat balance once it confirms. A phone with
// only a dollar balance gets its sat balance for it, opened with the dollar balance's key.
import { fundIn, inviteField, poll, requestQR } from '../kit.js';

export function create(inputs) {
  const { t, ui, engine, wallet, format } = inputs;
  return {
    id: 'onchain',
    group: 'depends',
    icon: 'chain',
    available: (methods) => !!methods?.onchain?.enabled,
    view({ done, added, open }) {
      const O = wallet.methods()?.onchain ?? {};
      // A dollar balance cannot take a deposit in sats, and an engine without two balances opens no sat
      // balance beside it: say so, with the one way forward the engine has.
      if ((wallet.landsIn ? wallet.landsIn('sat') : wallet.key() ? wallet.unit() : 'sat') !== 'sat') {
        const next = wallet.methods()?.lightning?.enabled ? ui.el('button', { type: 'button', class: 'btn primary block', id: 'onchainUseLightning', onclick: () => open('lightning') }, ui.icon('bolt', 20), ui.el('span', { text: t('fund.onchain.useLightning') })) : null;
        return { node: ui.el('div', { class: 'fund-view' }, ui.el('div', { class: 'scroll fund-body' }, ui.sayEl('p', {}, t('fund.onchain.satOnly'))), ui.el('div', { class: 'foot' }, next)) };
      }
      const msg = ui.msgLine();
      const invite = inviteField(inputs);
      const go = ui.el('button', { type: 'button', class: 'btn primary block', id: 'onchainGet' }, ui.icon('qr', 20), ui.el('span', { text: t('fund.onchain.get') }));
      const body = ui.el(
        'div',
        { class: 'scroll fund-body' },
        invite.node,
        ui.sayEl('p', {}, t('fund.onchain.what')),
        ui.sayEl('p', { class: 'note' }, t('fund.onchain.min', { amount: format.units(O.min_amount ?? 0, 'sat') }), '', 'coins'),
        ui.sayEl('p', { class: 'note' }, t('fund.onchain.confirmations', { count: O.confirmations || 3 }), '', 'clock'),
        msg,
      );
      const foot = ui.el('div', { class: 'foot' }, go);
      let poller = null;
      go.addEventListener('click', async () => {
        if (invite.missing(msg)) return;
        go.disabled = true;
        msg.set(t('fund.onchain.getting'));
        try {
          const r = await fundIn(wallet, 'sat', invite.value(), (key, code, sibling) => engine.fundOnchain(key, { invite: code }, sibling));
          if (r.body?.error?.code === 'sibling_refused') return open('onchain');
          if (!r.ok) return msg.set(t('fund.failed', { message: r.body?.error?.message ?? `HTTP ${r.status}` }), 'err');
          const f = r.body;
          const need = f.onchain?.confirmations_required ?? O.confirmations ?? 3;
          const st = ui.sayEl('p', { class: 'status-line', role: 'status' }, t('fund.onchain.watching'), 'wait');
          let last = f.credited ?? 0;
          const qrBlock = requestQR(inputs, { uri: 'bitcoin:' + f.request, copyText: f.request, copyLabel: t('fund.onchain.copy'), qrLabel: t('fund.onchain.qr') });
          const keyline = ui.sayEl('p', { class: 'mono keyline' }, f.request.match(/.{1,4}/g).join(' '));
          body.replaceChildren(qrBlock, keyline, st, ui.sayEl('p', { class: 'note' }, t('fund.onchain.close'), '', 'clock'));
          foot.replaceChildren(ui.el('button', { type: 'button', class: 'btn primary block', text: t('fund.done'), onclick: () => done() }));
          const update = (x) => {
            const o = x.onchain ?? {};
            if (x.state === 'failed') {
              st.className = 'status-line err';
              ui.say(st, t('fund.failed', { message: x.error ?? '' }), 'err');
              return true;
            }
            // The first deposit added: the success panel, with the address and its Copy under it (it takes more).
            if (x.credited > 0 && x.state !== 'minting') added({ amount: format.units(x.credited, 'sat'), words: t('fund.onchain.credited', { amount: format.units(x.credited, 'sat') }), extra: [keyline, qrBlock.querySelector('.row-btns')] });
            else if (x.state === 'minting') ui.say(st, t('fund.lightning.minting'), 'wait');
            else if (o.seen_sat) ui.say(st, t('fund.onchain.seen', { amount: format.units(o.seen_sat, 'sat'), count: o.confirmations ?? 0, need }), 'wait');
            if ((x.credited ?? 0) !== last) {
              last = x.credited ?? 0;
              wallet.refresh();
            }
            return x.state === 'expired';
          };
          if (!update(f))
            poller = poll(async () => {
              const s = await engine.funding(wallet.keyFor?.('sat') ?? wallet.key(), f.id);
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
