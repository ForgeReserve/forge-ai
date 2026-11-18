// The answer (XAnswerLight): the question, the model that answers it (small, with its kind and speed),
// the streamed answer with Markdown, then Copy, Ask again and Burn (held, screens/burn.js).
// Smaller rings below with the reply button (hold to talk). Errors show in plain words with one next
// step. A voice question shows here as text once it has been heard.
//
// While the first words are awaited the card shows that it is working: turning rings and the seconds
// waited; after SLOW_MS a "Slow model" note offers a fast model in one tap (owner, 2026-11-15).
// The screen is one screen high whatever the answer's length (owner, 2026-11-18: a long answer pushed the
// reply button down under Listen). The card gives way: the rings with the reply button, then the dock
// (Stop while the answer is being made, Listen or Stop once it is in, the natural voice offered under it
// after the phone's own voice read an answer, and the bottom row: Type, Add, More) keep their room, and
// the question and the answer scroll inside the card, faded at its lower edge while there is more below
// (moreBelow). Copy, Ask again and Burn stay pinned at the card's foot, always in view.
//
// Markdown (js/markdown.js with marked and DOMPurify, about 80 KB) loads when an answer screen is first
// made, not with the app, so it does not hold up the first paint. Until it is in, the answer shows as
// plain text.
let md = null;
let mdLoading = null;
/** Loads the Markdown module once (Playful mode's answer uses it too); resolves the module. */
export const loadMarkdown = () =>
  (mdLoading ??= import('../../js/markdown.js').then(
    (m) => (md = m),
    (e) => {
      mdLoading = null; // offline and not kept yet: try again on the next answer screen
      throw e;
    },
  ));
import { errorView } from '../core/errors.js';
import { priceLine } from '../core/price.js';
import { el, icon, say, sayEl, toast } from '../core/ui.js';
import { holdToBurn } from './burn.js';
import { bottomRow, rings, statusBar } from './parts.js';
import { holdToTalk } from './talk.js';

/** How long the first words may take before the Slow model note shows. */
export const SLOW_MS = 20_000;

/**
 * Marks `box` (an answer's scrolling text, in any mode) with data-more while there is more of it below
 * what shows: the CSS fades its lower edge then, a cue that needs no words. Checked as it scrolls and as
 * it or what it holds (`inner`) changes size. Returns {check, destroy}.
 */
export function moreBelow(box, ...inner) {
  const check = () => box.toggleAttribute('data-more', box.scrollTop + box.clientHeight < box.scrollHeight - 4);
  const sized = new ResizeObserver(check);
  for (const n of [box, ...inner]) sized.observe(n);
  box.addEventListener('scroll', check, { passive: true });
  return { check, destroy: () => sized.disconnect() };
}

const NS = 'http://www.w3.org/2000/svg';
/** The waiting mark: the home's two rings, turning in opposite ways, with a light running round each. */
function waitArt() {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 64 64');
  s.setAttribute('width', '56');
  s.setAttribute('height', '56');
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('wait-art');
  s.innerHTML =
    '<circle cx="32" cy="32" r="27" fill="none" stroke="var(--gold-track)" stroke-width="5"/>' +
    '<circle cx="32" cy="32" r="17" fill="none" stroke="var(--memory-track)" stroke-width="5"/>' +
    '<g class="wait-spin wait-gold"><circle cx="32" cy="32" r="27" fill="none" stroke="var(--gold)" stroke-width="5" stroke-linecap="round" stroke-dasharray="44 126"/><circle cx="32" cy="5" r="2.2" fill="#FFF6DC"/></g>' +
    '<g class="wait-spin wait-teal"><circle cx="32" cy="32" r="17" fill="none" stroke="var(--memory)" stroke-width="5" stroke-linecap="round" stroke-dasharray="30 77"/><circle cx="32" cy="15" r="2" fill="#E6FFF9"/></g>' +
    '<circle class="wait-core" cx="32" cy="32" r="5" fill="var(--memory)"/>';
  return s;
}

export function answer({ t, state, nav, actions, format }) {
  const bar = statusBar({ t, state, nav, actions });
  const asked = el('p', { class: 'asked' });
  // role note: a plain paragraph's aria-label is never read, and the label says what the name is.
  const modelLine = el('p', { class: 'answer-model', id: 'answerModel', role: 'note', hidden: true });
  const body = el('div', { class: 'answer-body md', id: 'answerText', 'aria-live': 'off' });
  // Waiting for the first words: the turning rings, Thinking and the seconds; then the Slow model note.
  // The seconds change every second: kept out of the live region, or a screen reader says each one.
  const secs = el('span', { class: 'wait-secs', id: 'waitSecs', 'aria-hidden': 'true' });
  const waitWord = el('b', { text: t('answer.thinking') });
  const wait = el('div', { class: 'wait', id: 'answerWait', role: 'status', hidden: true }, waitArt(), el('span', { class: 'wait-text' }, waitWord, secs));
  const slowText = el('p', { class: 'slow-text', id: 'slowText', role: 'status' });
  const fastBtn = el('button', { type: 'button', class: 'btn primary slow-go', id: 'useFast', onclick: () => actions.useFastModel() });
  const slow = el('div', { class: 'slow-note', id: 'slowNote', hidden: true }, slowText, fastBtn);
  const note = el('p', { class: 'answer-note', id: 'answerNote', role: 'status' });
  const speakWhat = el('span');
  const speakVia = el('small', { class: 'speak-via', id: 'speakVia', hidden: true });
  // While a slow phone makes sound ahead before reading: "Getting the voice ready" and a small bar.
  const readyBar = el('span', { class: 'speak-ready', id: 'speakReady', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', hidden: true }, el('span', { class: 'speak-ready-fill' }));
  const speaking = el('p', { class: 'speak-state', id: 'speakState', hidden: true }, icon('speaker', 16), speakWhat, readyBar, speakVia);
  const errBox = el('div', { class: 'error-box', id: 'answerError', role: 'alert', hidden: true });
  const tiles = el('div', { class: 'action-tiles' });
  // The part that scrolls: by touch, and by the keyboard once it has the focus (a screen reader moves through it).
  const scroll = el('div', { class: 'answer-scroll', id: 'answerScroll', tabindex: '0', role: 'region', 'aria-label': t('answer.text') }, asked, modelLine, wait, slow, body, errBox, note);
  const more = moreBelow(scroll, body);
  const card = el('article', { class: 'answer-card', 'aria-labelledby': 'askedLabel' }, el('span', { class: 'sr-only', id: 'askedLabel', text: t('answer.asked') }), speaking, scroll, tiles);
  const r = rings('answer');
  // Hold to talk (screens/talk.js). Where voice cannot be used here, the button opens Type.
  const reply = el('button', { type: 'button', class: 'talk small', id: 'replyBtn', 'aria-describedby': 'replyHint' });
  const hold = holdToTalk(reply, { t, state, actions, nav, hintId: 'replyHint', size: 'small' });
  const hint = hold.hint;
  const ringBtn = el('button', { type: 'button', class: 'ring-hit', onclick: () => nav('funds'), 'aria-label': t('funds.title') });
  // The dock: Listen and the bottom row, at the foot of the screen.
  const offer = el('div', { class: 'voice-offer', id: 'voiceOffer', hidden: true });
  const act = el('div', { class: 'dock-act' });
  const dock = el('div', { class: 'answer-dock', id: 'answerDock' }, offer, act, bottomRow({ t, nav }));
  // The recording's line lies over the card, above the rings (style.css): in the flow it took room from
  // the card and moved the reply button up under the finger (owner, 2026-11-18).
  const main = el('main', { class: 'screen answer', 'data-screen': 'answer' }, bar.node, card, el('div', { class: 'rings answer-rings' }, r.node, ringBtn, reply, hold.info), hint, dock);

  /** The next step's button: its picture and its word. */
  const NEXT_ICON = { addFunds: 'addMoney', retry: 'again', chooseModel: 'grid', startFresh: 'trash', takeOut: 'takeout', freeOut: 'gift' };
  const nextBtn = (next, go) => el('button', { type: 'button', class: 'btn primary', id: 'nextStep', onclick: go }, icon(NEXT_ICON[next] ?? 'next', 20), el('span', { text: t(`next.${next}`) }));
  let shownText = null;
  let shownState = null;
  let shownAct = null;
  const tile = (id, ico, label, fn, sub = null) => el('button', { type: 'button', class: 'action-tile', id, onclick: fn }, icon(ico, 22), el('span', { text: label }), sub ? el('small', { class: 'tile-sub', text: sub }) : null);
  /** The dock's one wide button: its icon, its word and, when reading aloud costs, the price. */
  const dockBtn = (id, ico, label, fn, sub = null, cls = '') => el('button', { type: 'button', class: `dock-btn ${cls}`.trim(), id, onclick: fn }, icon(ico, 22), el('span', { text: label }), sub ? el('small', { class: 'tile-sub', text: sub }) : null);

  // Burn: held, never one tap (screens/burn.js). The conversation card burns as it is held.
  let burner = null;
  const burnTile = () => {
    const b = el('button', { type: 'button', class: 'action-tile danger', id: 'burnBtn', 'aria-label': t('answer.burnLabel') }, icon('flame', 22), el('span', { text: t('answer.burn') }), el('small', { class: 'tile-sub hold-sub', text: t('burn.hold') }));
    burner?.destroy();
    burner = holdToBurn(b, { target: () => card, onBurn: () => actions.burn(), onTap: (again) => toast(t(again ? 'burn.again' : 'burn.tap'), again ? 6000 : 2600) });
    return b;
  };

  /** The dock's button now: Stop while the answer (or the voice question) is on its way, else Listen or Stop. */
  const drawAct = (v, busy) => {
    const sp = v.speak;
    const speakingNow = sp.current && sp.state !== 'idle';
    const p = sp.priceMsub > 0 ? priceLine(sp.priceMsub, v.talk.unit) : null;
    const key = busy ? `busy|${v.talk.phase}` : speakingNow ? 'speaking' : sp.available ? `listen|${p ? t(p.key, p) : ''}` : 'none';
    if (key === shownAct) return;
    shownAct = key;
    if (busy) act.replaceChildren(dockBtn('stopBtn', 'stop', t('answer.stop'), () => (v.talk.phase === 'sending' ? actions.talkCancel() : actions.stop()), null, 'stop'));
    else if (speakingNow) act.replaceChildren(dockBtn('speakStopBtn', 'stop', t('speak.stop'), () => actions.stopSpeaking()));
    else if (sp.available) act.replaceChildren(dockBtn('speakBtn', 'speaker', t('speak.listen'), () => actions.speak(), p ? t(p.key, p) : null, 'listen'));
    else act.replaceChildren();
    act.hidden = !act.childElementCount;
  };

  /** The natural voice's offer, after the phone's own voice read an answer: Get (its size) or Not now. */
  let shownOffer = '';
  const drawOffer = (v) => {
    const o = v.speak.offer;
    const key = o ? String(o.mb) : '';
    if (key === shownOffer) return;
    shownOffer = key;
    offer.hidden = !o;
    if (!o) return offer.replaceChildren();
    offer.replaceChildren(
      el('span', { class: 'offer-ico', 'aria-hidden': 'true' }, icon('speaker', 20)),
      el('span', { class: 'offer-text' }, el('b', { text: t('speak.offer') }), el('small', { class: 'offer-size' }, icon('download', 14), el('span', { text: t('speak.offerSize', { mb: o.mb }) }))),
      el('button', { type: 'button', class: 'btn primary offer-get', id: 'voiceOfferGet', 'aria-label': t('speak.offerGetLabel', { mb: o.mb }), onclick: () => actions.getNaturalVoice() }, icon('download', 18), el('span', { text: t('speak.offerGet') })),
      el('button', { type: 'button', class: 'info-btn offer-no', id: 'voiceOfferNo', 'aria-label': t('speak.offerNo'), onclick: () => actions.naturalNotNow() }, icon('x', 20)),
    );
  };

  /** The model that wrote this answer, small: its kind (lock or open lock), its name, and its speed. */
  let shownModel = '';
  const drawModel = (m) => {
    const key = m ? `${m.id}|${m.private}|${m.speed}` : '';
    if (key === shownModel) return;
    shownModel = key;
    modelLine.hidden = !m;
    if (!m) return modelLine.replaceChildren();
    modelLine.dataset.kind = m.private ? 'private' : 'standard';
    modelLine.setAttribute('aria-label', t('answer.model', { name: m.name }));
    modelLine.replaceChildren(...[icon(m.private ? 'lock' : 'unlock', 14), el('span', { text: m.name }), m.speed === 'fast' ? icon('rabbit', 16) : m.speed === 'slow' ? icon('turtle', 16) : null].filter(Boolean));
  };

  // The seconds waited, counted while the first words are awaited.
  let since = null;
  let timer = 0;
  const tickWait = () => {
    if (since == null) return;
    const ms = Date.now() - since;
    const n = Math.max(0, Math.floor(ms / 1000));
    secs.textContent = t('answer.seconds', { n });
    const v = state.view();
    const isSlow = ms >= SLOW_MS && v.waitSince != null;
    if (isSlow !== !slow.hidden) {
      slow.hidden = !isSlow;
      if (isSlow) {
        say(slowText, t('answer.slow'), '', 'turtle');
        const f = v.fastModel;
        fastBtn.replaceChildren(icon(f ? 'rabbit' : 'grid', 22), el('span', { text: f ? t('answer.useFast', { name: f.name }) : t('answer.chooseModel') }));
      }
    }
  };
  /** Shows the waiting mark from `from` (ms since 1970), or hides it with null. */
  const setWaiting = (from, word) => {
    waitWord.textContent = word;
    if (from === since) return;
    since = from;
    wait.hidden = from == null;
    if (from == null) {
      clearInterval(timer);
      timer = 0;
      slow.hidden = true;
      return;
    }
    tickWait();
    timer ||= setInterval(tickWait, 250);
  };

  let hearingSince = null;
  // Drawn, then the fade at the card's foot set for what it holds now.
  const update = () => {
    draw();
    more.check();
  };
  const draw = () => {
    const v = state.view();
    bar.update();
    hold.update();
    r.set(v.fundsFraction, v.memory.free, v.memory.low, v.freeFraction);
    showSpeaking(v);
    drawOffer(v);
    const tk = v.talk;
    // A voice question on its way to being text, or one that could not be heard.
    if (tk.phase === 'sending' || tk.error) {
      shownText = null;
      shownState = null;
      drawModel(null);
      asked.textContent = tk.phase === 'sending' ? t('talk.hearing') : t('talk.notHeard');
      body.replaceChildren();
      say(note, '');
      if (tk.phase === 'sending') {
        hearingSince ??= Date.now();
        setWaiting(hearingSince, t('talk.hearing'));
        errBox.hidden = true;
        tiles.replaceChildren();
        drawAct(v, true);
        return;
      }
      hearingSince = null;
      setWaiting(null, '');
      tiles.replaceChildren();
      drawAct(v, false);
      if (tk.error.key) {
        errBox.replaceChildren(sayEl('p', { id: 'answerErrorText' }, t(tk.error.key), 'err'), sayEl('p', { class: 'hint' }, t('talk.holdAgain'), '', 'mic'));
      } else {
        const ev = errorView(tk.error.code, tk.error.message, tk.error.charged);
        const go = { addFunds: () => nav('addFunds'), chooseModel: () => nav('model'), startFresh: () => (actions.startFresh(), nav('home')), takeOut: () => nav('takeOut') }[ev.next];
        // Trying again means holding the button again: the recording was not kept.
        errBox.replaceChildren(sayEl('p', { id: 'answerErrorText' }, t(ev.key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, tk.unit) : '' }), 'err'), go ? nextBtn(ev.next, go) : sayEl('p', { class: 'hint' }, t('talk.holdAgain'), '', 'mic'));
      }
      errBox.hidden = false;
      return;
    }
    hearingSince = null;
    const ex = v.lastExchange;
    if (!ex) {
      asked.textContent = '';
      drawModel(null);
      setWaiting(null, '');
      body.replaceChildren(sayEl('p', {}, t('answer.none')));
      tiles.replaceChildren();
      drawAct(v, false);
      say(note, '');
      errBox.hidden = true;
      return;
    }
    asked.textContent = ex.question;
    const a = ex.answer;
    const streaming = v.streaming;
    drawModel(v.answerModel);
    // No words yet: the waiting mark, from when the question was sent (it shows on every redraw, so the
    // first question's empty card is never left blank).
    setWaiting(streaming && !a.content ? (v.waitSince ?? Date.now()) : null, t('answer.thinking'));
    drawAct(v, streaming);
    if (a.content !== shownText) {
      // A new answer shows from its top; one that grows as it streams stays where the reader is.
      if (shownText && !a.content?.startsWith(shownText)) scroll.scrollTop = 0;
      shownText = a.content;
      if (a.content && md) {
        body.innerHTML = md.renderMarkdown(a.content);
        if (!streaming) md.enhance(body);
      } else if (a.content) body.replaceChildren(el('p', { class: 'plain', text: a.content }));
      else body.replaceChildren();
    }
    const stateKey = `${streaming}|${a.meta?.error ?? ''}|${a.meta?.stopped ?? ''}|${a.meta?.cost ?? ''}|${v.againMsub}|${JSON.stringify(v.free)}|${!!a.content}`;
    if (stateKey === shownState) return;
    shownState = stateKey;
    if (!streaming && a.content && md) md.enhance(body);
    body.setAttribute('aria-busy', String(streaming));
    if (streaming) {
      tiles.replaceChildren();
      say(note, '');
      errBox.hidden = true;
      return;
    }
    // Asking again is a new paid question: its price shows before it is pressed.
    const againPrice = (() => {
      const p = priceLine(v.againMsub, v.againUnit ?? v.talk.unit, v.free);
      return t(p.key, p);
    })();
    tiles.replaceChildren(...(a.content ? [tile('copyBtn', 'copy', t('answer.copy'), () => actions.copyAnswer())] : []), tile('againBtn', 'again', t('answer.again'), () => actions.again(), againPrice), burnTile());
    if (a.meta?.error) {
      const ev = errorView(a.meta.error.code, a.meta.error.message, a.meta.error.charged);
      const go = { addFunds: () => nav('addFunds'), retry: () => actions.again(), chooseModel: () => nav('model'), startFresh: () => (actions.startFresh(), nav('home')), takeOut: () => nav('takeOut'), freeOut: () => nav('freeOut') }[ev.next];
      errBox.replaceChildren(
        sayEl('p', { id: 'answerErrorText' }, t(ev.key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, a.meta.unit) : '' }), 'err'),
        nextBtn(ev.next, go),
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
    // A free model's answer says it was free (the engine charged it 0).
    const modelFree = !!a.meta?.freeModel && !(a.meta?.cost > 0);
    // A failed answer says its cost in the error box, so the note stays empty then.
    const noteText = a.meta?.stopped
      ? t('answer.stopped')
      : a.meta?.partial
        ? freeNote
          ? t('answer.partialFree')
          : cost && !modelFree
            ? t('answer.partialCost', { amount: cost })
            : t('answer.partial')
        : a.meta?.error
          ? ''
          : (freeNote ?? (modelFree ? t('answer.freeModel') : cost ? t('answer.cost', { amount: cost }) : ''));
    // A stopped answer shows the stop mark, whatever it cost.
    say(note, noteText, '', a.meta?.stopped ? 'stop' : a.meta?.free || modelFree ? 'gift' : cost ? 'coins' : null);
  };
  const showSpeaking = (v) => {
    const on = v.speak.current && v.speak.state !== 'idle';
    speaking.hidden = !on;
    const loading = v.speak.state === 'loading';
    const buffering = on && v.speak.state === 'buffering';
    speakWhat.textContent = !on ? '' : buffering ? t('speak.buffering') : loading && v.speak.progress != null ? t('speak.loadingPct', { pct: v.speak.progress }) : t(loading ? 'speak.loading' : 'speak.speaking');
    readyBar.hidden = !buffering;
    if (buffering) {
      const pct = v.speak.progress ?? 0;
      readyBar.setAttribute('aria-valuenow', String(pct));
      readyBar.setAttribute('aria-label', t('speak.buffering'));
      readyBar.firstChild.style.width = `${pct}%`;
    }
    // The engine's voice sees the answer on its way to the model: never let Private only imply otherwise.
    speakVia.hidden = !(on && v.speak.viaEngine);
    say(speakVia, speakVia.hidden ? '' : t('speak.viaEngine'), '', 'eye');
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
      clearInterval(timer);
      more.destroy();
      burner?.destroy();
      hold.destroy?.();
    },
    focus: card,
  };
}
