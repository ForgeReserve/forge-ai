// Type: a text field, what is attached, the price before sending, and Send. The canvas draws no typing
// screen (Decision 5), so this one is built from its tokens: back header, one field, one primary button.
import { priceLine } from '../core/price.js';
import { backHeader, el, icon, toast } from '../core/ui.js';
import { searchSwitch } from './parts.js';

export function typeScreen({ t, state, nav, back, actions }) {
  const S = state.S;
  const ta = el('textarea', { id: 'question', class: 'field-input', rows: '4', placeholder: t('type.placeholder'), 'aria-label': t('type.label'), enterkeyhint: 'send', autocomplete: 'off' });
  ta.value = S.draft ?? '';
  const follow = el('p', { class: 'follow', id: 'followLine', hidden: true, text: t('type.followUp') });
  const chips = el('ul', { class: 'chips', id: 'attached', 'aria-label': t('funds.memory') });
  const price = el('p', { class: 'price-line', id: 'priceLine' });
  const notice = el('div', { class: 'notice', id: 'typeNotice', role: 'status', hidden: true });
  const send = el('button', { type: 'button', class: 'btn primary block', id: 'sendBtn' }, icon('send', 20), el('span', { text: t('type.send') }));
  const search = searchSwitch({ t, state, actions, id: 'searchSwitch' });
  const main = el(
    'main',
    { class: 'screen sub type', 'data-screen': 'type' },
    backHeader(t('type.title'), back, t('common.back')),
    el('div', { class: 'type-body' }, follow, chips, el('label', { class: 'sr-only', for: 'question', text: t('type.label') }), ta, notice),
    el('div', { class: 'type-foot' }, search.node, price, send),
  );

  // "Use a free model instead" next to Add funds, while the engine has free models (screens/startfree.js).
  // With Private only on it asks first, in the notice; with no balance key it opens Start free, which asks.
  let asking = false;
  const freeInstead = () => {
    const v = state.view();
    if (!v.hasKey) return actions.openBalance();
    if (S.settings.privateOnly) {
      asking = true;
      update();
      notice.querySelector('#typeUseFree')?.focus();
      return;
    }
    useFree(false);
  };
  const useFree = (wasOn) => {
    asking = false;
    const m = actions.useFreeModels();
    toast(m ? t(wasOn ? 'startFree.using' : 'startFree.ready', { name: m.name ?? m.id }) : t('startFree.noModel'), 4000);
    update();
  };
  const keepPrivate = () => {
    asking = false;
    toast(t('startFree.kept'), 4000);
    update();
  };

  const blocker = (v) => {
    if (!v.online) return { key: 'type.offline' };
    if (!v.model) return v.noFunds ? { key: 'type.noFunds', btn: 'type.addFunds', go: () => nav('addFunds') } : { key: 'type.noModel', btn: 'type.chooseModel', go: () => nav('model') };
    // A free model costs nothing but needs a balance key: open one with an invite code.
    if (v.fundsBlock === 'needKey') return { key: 'type.needKey', btn: 'type.openBalance', go: () => actions.openBalance() };
    // No paid balance: free questions pay, if there are any left and the model is a free one.
    if (v.fundsBlock === 'addFunds') return { key: 'type.noFunds', btn: 'type.addFunds', go: () => nav('addFunds') };
    if (v.fundsBlock === 'freeOut') return { key: 'type.freeOut', btn: 'type.freeOutBtn', go: () => nav('freeOut') };
    if (v.fundsBlock === 'freeModel') return { key: 'type.freeModel', btn: 'type.useFreeModel', go: () => actions.useFreeModel() };
    return null;
  };
  const update = () => {
    const v = state.view();
    search.update();
    follow.hidden = !v.lastExchange;
    chips.replaceChildren(
      ...S.pending.map((a) =>
        el(
          'li',
          { class: 'chip' },
          icon(a.kind === 'image' ? 'image' : 'file', 16),
          el('span', { text: a.name }),
          el('button', { type: 'button', class: 'chip-x', 'aria-label': t('funds.remove', { name: a.name }), onclick: () => actions.removePending(a.id) }, icon('x', 14)),
        ),
      ),
    );
    chips.hidden = !S.pending.length;
    const est = actions.estimate(ta.value);
    // The funds left (less what other questions hold) do not cover this question's hold.
    const b = blocker(v) ?? (est.short ? { key: 'type.short', btn: 'type.addFunds', go: () => nav('addFunds') } : null);
    let problem = b ? null : est.reading ? 'type.reading' : est.overBody ? 'type.tooLarge' : est.overContext ? 'type.tooLong' : est.freeTooLong ? 'type.freeTooLong' : null;
    // Not enough funds for a paid model: a free model is the other way, on an engine that has them.
    const free = !!b && v.startFree && (b.key === 'type.noFunds' || b.key === 'type.short');
    if (!free) asking = false;
    if (b && asking) {
      notice.replaceChildren(
        el('p', { id: 'typeFreeAsk', text: t('startFree.ask') }),
        el('div', { class: 'row-btns' }, el('button', { type: 'button', class: 'btn primary', id: 'typeUseFree', onclick: () => useFree(true), text: t('startFree.use') }), el('button', { type: 'button', class: 'btn', id: 'typeKeepPrivate', onclick: keepPrivate, text: t('startFree.keep') })),
      );
      notice.hidden = false;
    } else if (b) {
      const btns = [b.btn ? el('button', { type: 'button', class: 'btn', id: 'noticeBtn', onclick: b.go, text: t(b.btn) }) : null, free ? el('button', { type: 'button', class: 'btn', id: 'noticeFreeBtn', onclick: freeInstead }, icon('gift', 20), el('span', { text: t('startFree.useModel') })) : null].filter(Boolean);
      notice.replaceChildren(el('p', { text: t(b.key) }), btns.length > 1 ? el('div', { class: 'row-btns' }, ...btns) : (btns[0] ?? ''));
      notice.hidden = false;
    } else if (problem) {
      notice.replaceChildren(el('p', { text: t(problem) }));
      notice.hidden = false;
    } else notice.hidden = true;
    const p = priceLine(est.costMsub, est.unit, est.free);
    price.replaceChildren(el('span', { class: 'cap', text: t('price.label') }), el('span', { class: 'amount', text: t(p.key, p) }));
    price.hidden = !v.model;
    // The exact hold in msub, the figure the engine holds (tests compare the two).
    price.dataset.msub = est.costMsub == null ? '' : String(est.costMsub);
    send.disabled = !!b || !!problem || (!ta.value.trim() && !S.pending.length);
  };
  const submit = () => {
    if (send.disabled) return;
    const text = ta.value.trim();
    ta.value = '';
    actions.saveDraft('');
    actions.ask(text);
  };
  send.addEventListener('click', submit);
  ta.addEventListener('input', () => {
    actions.saveDraft(ta.value);
    update();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  update();
  return { node: main, update, focus: ta };
}
