// The answer (XAnswerLight): the question, the streamed answer with Markdown, Stop while it streams,
// then Copy and Ask again. Smaller rings below with the reply button, and the bottom row. Errors show
// in plain words with one next step.
import { renderMarkdown, enhance } from '../../js/markdown.js';
import { errorView } from '../core/errors.js';
import { el, icon } from '../core/ui.js';
import { bottomRow, rings, statusBar } from './parts.js';

export function answer({ t, state, nav, actions, format }) {
  const bar = statusBar({ t, state, nav });
  const asked = el('p', { class: 'asked' });
  const body = el('div', { class: 'answer-body md', id: 'answerText', 'aria-live': 'off' });
  const note = el('p', { class: 'answer-note', id: 'answerNote', role: 'status' });
  const errBox = el('div', { class: 'error-box', id: 'answerError', role: 'alert', hidden: true });
  const tiles = el('div', { class: 'action-tiles' });
  const card = el('article', { class: 'answer-card', 'aria-labelledby': 'askedLabel' }, el('span', { class: 'sr-only', id: 'askedLabel', text: t('answer.asked') }), asked, body, errBox, note, tiles);
  const r = rings('answer');
  const reply = el('button', { type: 'button', class: 'talk small', id: 'replyBtn', onclick: () => nav('type') }, icon('mic', 34, 1.6), el('span', { text: t('home.reply') }));
  const ringBtn = el('button', { type: 'button', class: 'ring-hit', onclick: () => nav('funds'), 'aria-label': t('funds.title') });
  const main = el('main', { class: 'screen answer', 'data-screen': 'answer' }, bar.node, card, el('div', { class: 'rings answer-rings' }, r.node, ringBtn, reply), bottomRow({ t, nav }));

  let shownText = null;
  let shownState = null;
  const tile = (id, ico, label, fn) => el('button', { type: 'button', class: 'action-tile', id, onclick: fn }, icon(ico, 22), el('span', { text: label }));
  const update = () => {
    const v = state.view();
    bar.update();
    r.set(v.fundsFraction, v.memory.free, v.memory.low);
    const ex = v.lastExchange;
    if (!ex) {
      asked.textContent = '';
      body.replaceChildren(el('p', { text: t('answer.none') }));
      tiles.replaceChildren();
      note.textContent = '';
      errBox.hidden = true;
      return;
    }
    asked.textContent = ex.question;
    const a = ex.answer;
    const streaming = v.streaming;
    if (a.content !== shownText) {
      shownText = a.content;
      if (a.content) {
        body.innerHTML = renderMarkdown(a.content);
        if (!streaming) enhance(body);
      } else body.replaceChildren(el('p', { class: 'thinking', text: streaming ? t('answer.thinking') : '' }));
    }
    const stateKey = `${streaming}|${a.meta?.error ?? ''}|${a.meta?.stopped ?? ''}|${a.meta?.cost ?? ''}`;
    if (stateKey === shownState) return;
    shownState = stateKey;
    if (!streaming && a.content) enhance(body);
    body.setAttribute('aria-busy', String(streaming));
    if (streaming) {
      tiles.replaceChildren(tile('stopBtn', 'stop', t('answer.stop'), () => actions.stop()));
      note.textContent = '';
      errBox.hidden = true;
      return;
    }
    tiles.replaceChildren(
      ...(a.content ? [tile('copyBtn', 'copy', t('answer.copy'), () => actions.copyAnswer())] : []),
      tile('againBtn', 'again', t('answer.again'), () => actions.again()),
    );
    if (a.meta?.error) {
      const ev = errorView(a.meta.error.code, a.meta.error.message);
      const go = { addFunds: () => nav('addFunds'), retry: () => actions.again(), chooseModel: () => nav('model'), startFresh: () => (actions.startFresh(), nav('home')), takeOut: () => nav('takeOut') }[ev.next];
      errBox.replaceChildren(el('p', { text: t(ev.key, { message: ev.message ?? '' }) }), el('button', { type: 'button', class: 'btn primary', id: 'nextStep', onclick: go, text: t(`next.${ev.next}`) }));
      errBox.hidden = false;
      // Ask again is the next step already when the next step is a retry.
      if (ev.next === 'retry') tiles.querySelector('#againBtn')?.remove();
    } else errBox.hidden = true;
    note.textContent = a.meta?.stopped ? t('answer.stopped') : a.meta?.partial ? t('answer.partial') : a.meta?.cost != null ? t('answer.cost', { amount: format.cost(a.meta.cost, a.meta.unit) }) : '';
  };
  update();
  return { node: main, update, focus: card };
}
