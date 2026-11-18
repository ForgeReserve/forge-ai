// A fund module: paste eCash and add it to the balance. wallet.topup keeps the token on the phone until
// the engine has credited it. It reuses eCash's strings; it needs fund.paste.name in strings/en.js.
export function create({ t, ui, wallet, format }) {
  return {
    id: 'paste',
    icon: 'paste',
    available: () => true,
    view({ done }) {
      const msg = ui.msgLine();
      const box = ui.el('textarea', { id: 'pasteToken', rows: '4', class: 'field-input mono', spellcheck: 'false', 'aria-label': t('fund.ecash.label') });
      const add = ui.el('button', { type: 'button', class: 'btn primary block', id: 'pasteAdd' }, ui.icon('addMoney', 22), ui.el('span', { text: t('fund.ecash.add') }));
      add.addEventListener('click', async () => {
        const token = box.value.replace(/\s+/g, '');
        if (!/^cashu[AB]/.test(token)) return msg.set(t('fund.ecash.bad'), 'err');
        add.disabled = true;
        msg.set(t('fund.ecash.sending'));
        try {
          const r = await wallet.topup(token);
          const words = t('fund.ecash.added', { amount: format.units(r.credited, r.unit) });
          msg.set(words, 'ok');
          await wallet.refresh();
          // Funds says it in its success panel.
          done({ words, amount: format.units(r.credited, r.unit) });
        } catch (e) {
          msg.set(e?.retryable ? t('fund.ecash.kept') : t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          add.disabled = false;
        }
      });
      const body = ui.el('div', { class: 'scroll fund-body' }, box, msg);
      return { node: ui.el('div', { class: 'fund-view' }, body, ui.el('div', { class: 'foot' }, add)) };
    },
  };
}
