// Fund module: Start free (docs/PAYMENTS.md, Free models). Opens a balance with an invite code
// and nothing on it, through wallet.open (POST /v1/wallet/open). Its balance key is all a free model
// needs: questions to one cost nothing and nothing is held. Funds can be added to the same balance later.
// Listed only while the engine has free models and this phone has no balance key yet.

export function create(inputs) {
  const { t, ui, wallet } = inputs;
  return {
    id: 'invite',
    group: 'unlinked',
    icon: 'gift',
    available: (methods) => !!methods?.open?.enabled && !wallet.key(),
    view({ done }) {
      const msg = ui.msgLine();
      const input = ui.el('input', { id: 'openInvite', class: 'field-input', placeholder: t('invite.placeholder'), autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', value: wallet.invite() ?? '' });
      input.addEventListener('input', () => wallet.setInvite(input.value.trim()));
      const go = ui.el('button', { type: 'button', class: 'btn primary block', id: 'openBalance' }, ui.icon('gift', 20), ui.el('span', { text: t('fund.invite.open') }));
      go.addEventListener('click', async () => {
        const code = input.value.trim();
        if (!code) {
          msg.set(t('invite.missing'), 'err');
          input.focus();
          return;
        }
        go.disabled = true;
        msg.set(t('fund.invite.opening'));
        try {
          const r = await wallet.open(code);
          // With Private only on, the free models (Standard) are hidden: say how to see them.
          const words = t(r?.freeShown === false ? 'fund.invite.openedHidden' : 'fund.invite.opened');
          ui.toast(words);
          msg.set(words, 'ok');
          done();
        } catch (e) {
          const why = e?.code;
          msg.set(why === 'invite_used' ? t('fund.invite.used') : why === 'invite_required' || why === 'invite_invalid' ? t('fund.invite.bad') : t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          go.disabled = false;
        }
      });
      const field = ui.el('div', { class: 'field' }, ui.el('label', { for: 'openInvite', class: 'label', text: t('invite.label') }), input);
      const body = ui.el('div', { class: 'scroll fund-body' }, ui.el('p', { text: t('fund.invite.what') }), field, msg, ui.el('p', { class: 'note', text: t('fund.invite.later') }));
      const node = ui.el('div', { class: 'fund-view' }, body, ui.el('div', { class: 'foot' }, go));
      return { node };
    },
  };
}
