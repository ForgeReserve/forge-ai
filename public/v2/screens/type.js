// Type: a text field, what is attached, the price before sending, and Send. The canvas draws no typing
// screen (Decision 5), so this one is built from its tokens: back header, one field, one primary button.
import { priceLine } from '../core/price.js';
import { backHeader, el, icon } from '../core/ui.js';

export function typeScreen({ t, state, nav, back, actions }) {
  const S = state.S;
  const ta = el('textarea', { id: 'question', class: 'field-input', rows: '4', placeholder: t('type.placeholder'), 'aria-label': t('type.label'), enterkeyhint: 'send', autocomplete: 'off' });
  ta.value = S.draft ?? '';
  const follow = el('p', { class: 'follow', id: 'followLine', hidden: true, text: t('type.followUp') });
  const chips = el('ul', { class: 'chips', id: 'attached', 'aria-label': t('funds.memory') });
  const price = el('p', { class: 'price-line', id: 'priceLine' });
  const notice = el('div', { class: 'notice', id: 'typeNotice', role: 'status', hidden: true });
  const send = el('button', { type: 'button', class: 'btn primary block', id: 'sendBtn' }, icon('send', 20), el('span', { text: t('type.send') }));
  const main = el(
    'main',
    { class: 'screen sub type', 'data-screen': 'type' },
    backHeader(t('type.title'), back, t('common.back')),
    el('div', { class: 'type-body' }, follow, chips, el('label', { class: 'sr-only', for: 'question', text: t('type.label') }), ta, notice),
    el('div', { class: 'type-foot' }, price, send),
  );

  const blocker = (v) => {
    if (!v.online) return { key: 'type.offline' };
    if (!v.hasKey || v.balanceMsub === 0) return { key: 'type.noFunds', btn: 'type.addFunds', go: () => nav('addFunds') };
    if (!v.model) return { key: 'type.noModel', btn: 'type.chooseModel', go: () => nav('model') };
    return null;
  };
  const update = () => {
    const v = state.view();
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
    const b = blocker(v);
    const est = actions.estimate(ta.value);
    let problem = b ? null : est.reading ? 'type.reading' : est.overBody ? 'type.tooLarge' : est.overContext ? 'type.tooLong' : null;
    if (b) {
      notice.replaceChildren(el('p', { text: t(b.key) }), b.btn ? el('button', { type: 'button', class: 'btn', id: 'noticeBtn', onclick: b.go, text: t(b.btn) }) : '');
      notice.hidden = false;
    } else if (problem) {
      notice.replaceChildren(el('p', { text: t(problem) }));
      notice.hidden = false;
    } else notice.hidden = true;
    const p = priceLine(est.costMsub, est.unit);
    price.replaceChildren(el('span', { class: 'cap', text: t('price.label') }), el('span', { class: 'amount', text: t(p.key, { amount: p.amount }) }));
    price.hidden = !v.model;
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
