// Fund module: eCash. Paste (or scan) a Cashu token from an accepted mint. It wraps POST
// /v1/wallet/topup through wallet.topup, which stores the token on the phone before sending it and
// removes it only after the engine confirms the credit (core/vault.js).
import { inviteField, tokenBox } from '../kit.js';

export function create(inputs) {
  const { t, ui, wallet, format } = inputs;
  return {
    id: 'ecash',
    group: 'unlinked',
    icon: 'coins',
    available: () => true,
    view({ done }) {
      const msg = ui.msgLine();
      const invite = inviteField(inputs);
      const add = ui.el('button', { type: 'button', class: 'btn primary block', id: 'ecashAdd' }, ui.icon('plus', 20), ui.el('span', { text: t('fund.ecash.add') }));
      const box = tokenBox(inputs, { id: 'ecashToken', label: t('fund.ecash.label'), onScanned: () => add.click() });
      const mints = wallet.mints();
      add.addEventListener('click', async () => {
        const token = box.value();
        if (!/^cashu[AB]/.test(token)) return msg.set(t('fund.ecash.bad'), 'err');
        if (invite.missing(msg)) return;
        add.disabled = true;
        msg.set(t('fund.ecash.sending'));
        try {
          const r = await wallet.topup(token, invite.value());
          box.clear();
          // A voucher of free questions is counted in questions, never as an amount of money.
          const text = r.replay ? t('fund.ecash.replay') : r.free ? t('fund.free.added', { count: r.credited }) : t('fund.ecash.added', { amount: format.units(r.credited, r.unit) });
          ui.toast(text);
          msg.set(text, 'ok');
          await wallet.refresh();
          done();
        } catch (e) {
          if (e?.code === 'untrusted_mint') msg.set(t('fund.ecash.otherMint'), 'err');
          else if (e?.code === 'token_spent') msg.set(t('fund.ecash.spent'), 'err');
          else if (e?.retryable) msg.set(t('fund.ecash.kept'), 'err');
          else msg.set(t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          add.disabled = false;
        }
      });
      const body = ui.el('div', { class: 'scroll fund-body' }, invite.node, box.node, msg, mints.length ? ui.sayEl('p', { class: 'note' }, t('fund.ecash.mints', { mints: mints.join(', ') })) : null);
      const node = ui.el('div', { class: 'fund-view' }, body, ui.el('div', { class: 'foot' }, add));
      return { node, destroy: box.stop };
    },
  };
}
