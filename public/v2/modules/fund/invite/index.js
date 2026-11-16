// Fund module: Start free (docs/PAYMENTS.md, Free models). Opens a balance with an invite code
// and nothing on it, through wallet.open (POST /v1/wallet/open). Its balance key is all a free model
// needs: questions to one cost nothing and nothing is held. Funds can be added to the same balance later.
// Listed only while the engine has free models and this phone has no balance key yet. Free models
// are Standard models: with Private only on, it asks before turning it off (the same question as
// screens/startfree.js), and never turns it off without a yes.

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
          await wallet.open(code);
          if (wallet.privateOnly()) {
            msg.set(t('startFree.opened'), 'ok');
            field.hidden = go.hidden = true;
            ask.hidden = false;
            useBtn.focus();
          } else finish(false);
        } catch (e) {
          const why = e?.code;
          msg.set(why === 'invite_used' ? t('fund.invite.used') : why === 'invite_required' || why === 'invite_invalid' ? t('fund.invite.bad') : t('fund.failed', { message: e?.message ?? String(e) }), 'err');
        } finally {
          go.disabled = false;
        }
      });
      // The question, once the balance is open and Private only is on.
      const useBtn = ui.el('button', { type: 'button', class: 'btn primary', id: 'openUseFree' }, ui.icon('check', 20), ui.el('span', { text: t('startFree.use') }));
      const keepBtn = ui.el('button', { type: 'button', class: 'btn', id: 'openKeepPrivate' }, ui.icon('lock', 20), ui.el('span', { text: t('startFree.keep') }));
      const ask = ui.el('div', { class: 'free-ask', id: 'openFreeAsk', role: 'group', 'aria-labelledby': 'openFreeAskText', hidden: true }, ui.el('p', { id: 'openFreeAskText', 'data-approved': '', text: t('startFree.ask') }), ui.el('div', { class: 'row-btns' }, useBtn, keepBtn));
      /** Says what was chosen, then back to Funds. used: the free models (Private only goes off, after a yes). */
      function finish(wasOn, used = true) {
        const m = used ? wallet.useFreeModels() : null;
        const words = !used ? t('startFree.kept') : m ? t(wasOn ? 'startFree.using' : 'startFree.ready', { name: m.name ?? m.id }) : t('startFree.noModel');
        ui.toast(words, 4000);
        msg.set(words, 'ok');
        done();
      }
      useBtn.addEventListener('click', () => finish(true));
      keepBtn.addEventListener('click', () => finish(true, false));
      const field = ui.el('div', { class: 'field' }, ui.el('label', { for: 'openInvite', class: 'label', text: t('invite.label') }), input);
      const body = ui.el('div', { class: 'scroll fund-body' }, ui.sayEl('p', {}, t('fund.invite.what')), field, ask, msg, ui.sayEl('p', { class: 'note' }, t('fund.invite.later')));
      const node = ui.el('div', { class: 'fund-view' }, body, ui.el('div', { class: 'foot' }, go));
      return { node };
    },
  };
}
