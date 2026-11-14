// The answer (XAnswerLight): the question, the streamed answer with Markdown, Stop while it streams,
// then Copy, Ask again and Burn, and Listen (or Stop) to hear it read aloud, with its price when it
// costs.
// Smaller rings below with the reply button (hold to talk), and the bottom row. Errors show in plain
// words with one next step. A voice question shows here as text once it has been heard.
// Markdown (js/markdown.js with marked and DOMPurify, about 80 KB) loads when an answer screen is first
// made, not with the app, so it does not hold up the first paint. Until it is in, the answer shows as
// plain text.
let md = null;
let mdLoading = null;
const loadMarkdown = () =>
  (mdLoading ??= import('../../js/markdown.js').then(
    (m) => (md = m),
    (e) => {
      mdLoading = null; // offline and not kept yet: try again on the next answer screen
      throw e;
    },
  ));
import { errorView } from '../core/errors.js';
import { priceLine } from '../core/price.js';
import { el, icon } from '../core/ui.js';
import { bottomRow, rings, statusBar } from './parts.js';
import { holdToTalk } from './talk.js';

export function answer({ t, state, nav, actions, format }) {
  const bar = statusBar({ t, state, nav });
  const asked = el('p', { class: 'asked' });
  const body = el('div', { class: 'answer-body md', id: 'answerText', 'aria-live': 'off' });
  const note = el('p', { class: 'answer-note', id: 'answerNote', role: 'status' });
  const speakWhat = el('span');
  const speakVia = el('small', { class: 'speak-via', id: 'speakVia', hidden: true });
  const speaking = el('p', { class: 'speak-state', id: 'speakState', hidden: true }, icon('speaker', 16), speakWhat, speakVia);
  const errBox = el('div', { class: 'error-box', id: 'answerError', role: 'alert', hidden: true });
  const tiles = el('div', { class: 'action-tiles' });
  const card = el('article', { class: 'answer-card', 'aria-labelledby': 'askedLabel' }, el('span', { class: 'sr-only', id: 'askedLabel', text: t('answer.asked') }), speaking, asked, body, errBox, note, tiles);
  const r = rings('answer');
  // Hold to talk (screens/talk.js). Where voice cannot be used here, the button opens Type.
  const reply = el('button', { type: 'button', class: 'talk small', id: 'replyBtn', 'aria-describedby': 'replyHint' });
  const hold = holdToTalk(reply, { t, state, actions, nav, hintId: 'replyHint', size: 'small' });
  const hint = hold.hint;
  const ringBtn = el('button', { type: 'button', class: 'ring-hit', onclick: () => nav('funds'), 'aria-label': t('funds.title') });
  const main = el('main', { class: 'screen answer', 'data-screen': 'answer' }, bar.node, card, el('div', { class: 'rings answer-rings' }, r.node, ringBtn, reply), hold.info, hint, bottomRow({ t, nav }));

  let shownText = null;
  let shownState = null;
  const tile = (id, ico, label, fn, sub = null) => el('button', { type: 'button', class: 'action-tile', id, onclick: fn }, icon(ico, 22), el('span', { text: label }), sub ? el('small', { class: 'tile-sub', text: sub }) : null);
  /** Burn: removes this conversation from the phone at once (the app then goes home). */
  const burnTile = () => {
    const b = tile('burnBtn', 'flame', t('answer.burn'), () => actions.burn());
    b.classList.add('danger');
    b.setAttribute('aria-label', t('answer.burnLabel'));
    return b;
  };
  /** Listen (with its price when it costs) or Stop while the answer is being read aloud. */
  const speakTile = (v) => {
    const sp = v.speak;
    if (!sp.available) return [];
    if (sp.current && sp.state !== 'idle') return [tile('speakStopBtn', 'stop', t('speak.stop'), () => actions.stopSpeaking())];
    const p = sp.priceMsub > 0 ? priceLine(sp.priceMsub, v.talk.unit) : null;
    return [tile('speakBtn', 'speaker', t('speak.listen'), () => actions.speak(), p ? t(p.key, p) : null)];
  };
  const showSpeaking = (v) => {
    const on = v.speak.current && v.speak.state !== 'idle';
    speaking.hidden = !on;
    speakWhat.textContent = on ? t(v.speak.state === 'loading' ? 'speak.loading' : 'speak.speaking') : '';
    // The engine's voice sees the answer on its way to the model: never let Private only imply otherwise.
    speakVia.hidden = !(on && v.speak.viaEngine);
    speakVia.textContent = speakVia.hidden ? '' : t('speak.viaEngine');
  };
  const update = () => {
    const v = state.view();
    bar.update();
    hold.update();
    r.set(v.fundsFraction, v.memory.free, v.memory.low, v.freeFraction);
    showSpeaking(v);
    const tk = v.talk;
    // A voice question on its way to being text, or one that could not be heard.
    if (tk.phase === 'sending' || tk.error) {
      shownText = null;
      shownState = null;
      asked.textContent = tk.phase === 'sending' ? t('talk.hearing') : t('talk.notHeard');
      body.replaceChildren(el('p', { class: 'thinking', text: tk.phase === 'sending' ? t('answer.thinking') : '' }));
      note.textContent = '';
      if (tk.phase === 'sending') {
        errBox.hidden = true;
        tiles.replaceChildren(tile('stopBtn', 'stop', t('answer.stop'), () => actions.talkCancel()));
        return;
      }
      tiles.replaceChildren();
      if (tk.error.key) {
        errBox.replaceChildren(el('p', { text: t(tk.error.key) }));
      } else {
        const ev = errorView(tk.error.code, tk.error.message, tk.error.charged);
        const go = { addFunds: () => nav('addFunds'), chooseModel: () => nav('model'), startFresh: () => (actions.startFresh(), nav('home')), takeOut: () => nav('takeOut') }[ev.next];
        // Trying again means holding the button again: the recording was not kept.
        errBox.replaceChildren(el('p', { text: t(ev.key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, tk.unit) : '' }) }), go ? el('button', { type: 'button', class: 'btn primary', id: 'nextStep', onclick: go, text: t(`next.${ev.next}`) }) : el('p', { class: 'hint', text: t('talk.holdAgain') }));
      }
      errBox.hidden = false;
      return;
    }
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
      if (a.content && md) {
        body.innerHTML = md.renderMarkdown(a.content);
        if (!streaming) md.enhance(body);
      } else if (a.content) body.replaceChildren(el('p', { class: 'plain', text: a.content })); else body.replaceChildren(el('p', { class: 'thinking', text: streaming ? t('answer.thinking') : '' }));
    }
    const stateKey = `${streaming}|${a.meta?.error ?? ''}|${a.meta?.stopped ?? ''}|${a.meta?.cost ?? ''}|${v.speak.available}|${v.speak.current}|${v.speak.state}|${v.speak.priceMsub}|${v.againMsub}|${JSON.stringify(v.free)}`;
    if (stateKey === shownState) return;
    shownState = stateKey;
    if (!streaming && a.content && md) md.enhance(body);
    body.setAttribute('aria-busy', String(streaming));
    if (streaming) {
      tiles.replaceChildren(tile('stopBtn', 'stop', t('answer.stop'), () => actions.stop()));
      note.textContent = '';
      errBox.hidden = true;
      return;
    }
    // Asking again is a new paid question: its price shows before it is pressed.
    const againPrice = (() => {
      const p = priceLine(v.againMsub, v.talk.unit, v.free);
      return t(p.key, p);
    })();
    tiles.replaceChildren(
      ...speakTile(v),
      ...(a.content ? [tile('copyBtn', 'copy', t('answer.copy'), () => actions.copyAnswer())] : []),
      tile('againBtn', 'again', t('answer.again'), () => actions.again(), againPrice),
      burnTile(),
    );
    if (a.meta?.error) {
      const ev = errorView(a.meta.error.code, a.meta.error.message, a.meta.error.charged);
      const go = { addFunds: () => nav('addFunds'), retry: () => actions.again(), chooseModel: () => nav('model'), startFresh: () => (actions.startFresh(), nav('home')), takeOut: () => nav('takeOut'), freeOut: () => nav('freeOut') }[ev.next];
      errBox.replaceChildren(
        el('p', { text: t(ev.key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, a.meta.unit) : '' }) }),
        el('button', { type: 'button', class: 'btn primary', id: 'nextStep', onclick: go, text: t(`next.${ev.next}`) }),
        // Trying again asks the model again: a paid question, with its price before the tap.
        ev.next === 'retry' ? el('p', { class: 'price-line', id: 'retryPrice' }, el('span', { class: 'cap', text: t('price.label') }), el('span', { class: 'amount', text: againPrice })) : null,
      );
      errBox.hidden = false;
      // Ask again is the next step already when the next step is a retry.
      if (ev.next === 'retry') tiles.querySelector('#againBtn')?.remove();
    } else errBox.hidden = true;
    const cost = a.meta?.cost != null ? format.cost(a.meta.cost, a.meta.unit) : null;
    // A free question says so, never an amount: a credit is not money.
    const freeNote = a.meta?.free && a.meta?.freeLeft != null ? (a.meta.freeLeft === 0 ? t('answer.freeLast') : t('answer.free', { left: a.meta.freeLeft })) : null;
    // A failed answer says its cost in the error box, so the note stays empty then.
    note.textContent = a.meta?.stopped ? t('answer.stopped') : a.meta?.partial ? (freeNote ? t('answer.partialFree') : cost ? t('answer.partialCost', { amount: cost }) : t('answer.partial')) : a.meta?.error ? '' : (freeNote ?? (cost ? t('answer.cost', { amount: cost }) : ''));
  };
  update();
  // Once markdown is in, the answer is drawn again with it.
  let gone = false;
  if (!md)
    loadMarkdown()
      .then(() => {
        if (gone) return;
        shownText = null;
        shownState = null;
        update();
      })
      .catch(() => {});
  return {
    node: main,
    update,
    destroy: () => {
      gone = true;
      hold.destroy?.();
    },
    focus: card,
  };
}
