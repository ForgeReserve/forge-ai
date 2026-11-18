// Playful answer (docs/PLAYFUL.md; the design's KidsChat): the top chips, a white card with a small Pip and
// a line that says what Pip is doing ("Pip is reading it to you" while the answer is read aloud), the
// answer's first sentence big and the rest under it, and the card's three actions: Again (hear it again),
// Share and Burn (held, screens/burn.js). Under the card the smaller rings round Hold to reply, the bar
// and a line that Pip can get things wrong.
// The Default answer's logic in another dress: the same streamed answer (Markdown once it is in), the same
// waiting mark's seconds and slow-model offer, the same errors with one next step (core/errors.js), the
// same read-aloud (actions.speak), the same Burn and the same reply button. Copy and Ask again sit behind
// Share, with the phone's own share sheet where it has one.
import { errorView } from '../../../core/errors.js';
import { priceLine } from '../../../core/price.js';
import { el, icon, say, sayEl, toast } from '../../../core/ui.js';
import { loadMarkdown, SLOW_MS } from '../../../screens/answer.js';
import { holdToBurn } from '../../../screens/burn.js';
import { rings } from '../../../screens/parts.js';
import { holdToTalk } from '../../../screens/talk.js';
import { answerLine, splitLead } from './logic.js';
import { bar, chips, mic, pipSays, playfulBar, sayShort } from './parts.js';
import { pip } from './pip.js';

let md = null;

/** The next step's button: its picture and its word (as on the Default answer). */
const NEXT_ICON = { addFunds: 'addMoney', retry: 'again', chooseModel: 'grid', startFresh: 'trash', takeOut: 'takeout', freeOut: 'gift' };
/** Messages that are good news: Pip smiles at these, and looks worried at the rest. */
const CALM = ['answer.copied', 'history.burned', 'history.burnedAll'];

export function answer({ t, ui, state, nav, actions, format }) {
  const top = chips({ t, state, nav, actions });
  const face = pip({ size: 52 });
  // What Pip is doing; the seconds waited sit beside it, kept out of the live region.
  const lineText = el('span', { class: 'pf-line-text' });
  const secs = el('span', { class: 'pf-secs', id: 'waitSecs', 'aria-hidden': 'true', hidden: true });
  const line = el('p', { class: 'pf-line', id: 'pipLine', role: 'status', 'aria-live': 'polite' }, lineText, secs);
  const asked = el('p', { class: 'pf-asked', id: 'pfAsked' });
  const lead = el('div', { class: 'pf-lead md', id: 'answerLead' });
  const rest = el('div', { class: 'pf-rest md' });
  const text = el('div', { class: 'pf-text', id: 'answerText', 'aria-live': 'off' }, lead, rest);
  const slowText = el('p', { class: 'slow-text', id: 'slowText', role: 'status' });
  const fastBtn = el('button', { type: 'button', class: 'btn primary slow-go', id: 'useFast', onclick: () => actions.useFastModel() });
  const slow = el('div', { class: 'slow-note pf-slow', id: 'slowNote', hidden: true }, slowText, fastBtn);
  const errBox = el('div', { class: 'error-box pf-error', id: 'answerError', role: 'alert', hidden: true });
  // The words sit in the middle of the card while they fit, and scroll from the top once they do not.
  const scroll = el('div', { class: 'pf-scroll' }, el('div', { class: 'pf-scroll-in' }, asked, slow, text, errBox));
  const acts = el('div', { class: 'pf-acts', id: 'pfActs' });
  const tray = el('div', { class: 'pf-acts pf-tray', id: 'shareTray', hidden: true });
  const card = el('article', { class: 'pf-card', 'aria-labelledby': 'askedLabel' }, el('span', { class: 'sr-only', id: 'askedLabel', text: t('answer.asked') }), el('div', { class: 'pf-card-head' }, face.node, line), scroll, acts, tray);
  const r = rings('playfulAnswer');
  // Hold to reply (screens/talk.js): the same button as the home's, smaller.
  const reply = el('button', { type: 'button', class: 'talk small', id: 'replyBtn', 'aria-describedby': 'replyHint' });
  const hold = holdToTalk(reply, { t, state, actions, nav, hintId: 'replyHint', size: 'small', glyph: mic, word: 'playful.reply' });
  const ringBtn = el('button', { type: 'button', class: 'ring-hit', onclick: () => nav('funds'), 'aria-label': t('funds.title') });
  const careful = el('p', { class: 'pf-careful', id: 'pipCareful', text: t('playful.careful') });
  const main = el(
    'main',
    { class: 'screen pf pf-answer', 'data-screen': 'answer', 'data-mode': 'playful' },
    top.node,
    card,
    // The recording's line lies over the card, above the rings (style.css): in the flow it took room
    // from the card and moved the reply button up under the finger.
    el('div', { class: 'rings pf-rings-small' }, r.node, ringBtn, reply, hold.info),
    hold.hint,
    bar({ t, nav }),
    careful,
  );

  const tile = (id, ico, label, fn, sub = null, attrs = {}) => el('button', { type: 'button', class: 'pf-act', id, onclick: fn, ...attrs }, icon(ico, 22, 2.2), el('span', { text: label }), sub ? el('small', { class: 'pf-act-sub', text: sub }) : null);
  const nextBtn = (next, go) => el('button', { type: 'button', class: 'btn primary pf-next', id: 'nextStep', onclick: go }, icon(NEXT_ICON[next] ?? 'next', 20), el('span', { text: t(`next.${next}`) }));

  // Burn: held, never one tap (screens/burn.js). The card burns as it is held.
  let burner = null;
  const burnTile = () => {
    const b = el('button', { type: 'button', class: 'pf-act pf-burn', id: 'burnBtn', 'aria-label': t('answer.burnLabel') }, icon('flame', 22, 2.2), el('span', { text: t('answer.burn') }));
    burner?.destroy();
    burner = holdToBurn(b, { target: () => card, onBurn: () => actions.burn(), onTap: (again) => toast(t(again ? 'burn.again' : 'burn.tap'), again ? 6000 : 2600) });
    return b;
  };

  // Share: the phone's share sheet where it has one, Copy, and Ask again (a new paid question, its
  // price shown first), in a row under the card's actions.
  const canShare = typeof navigator.share === 'function';
  const shareText = () => state.view().lastExchange?.answer?.content ?? '';
  const openTray = (on) => {
    tray.hidden = !on;
    acts.querySelector('#shareBtn')?.setAttribute('aria-expanded', String(on));
  };
  const drawTray = (v, retry) => {
    const p = priceLine(v.againMsub, v.againUnit ?? v.talk.unit, v.free);
    tray.replaceChildren(
      ...[
        canShare ? tile('shareSend', 'share', t('playful.send'), () => navigator.share({ text: shareText() }).catch(() => {}), null, { 'aria-label': t('playful.sendLabel') }) : null,
        tile('copyBtn', 'copy', t('answer.copy'), () => actions.copyAnswer()),
        // When the next step is already Try again, Ask again is not offered twice.
        retry ? null : tile('againBtn', 'again', t('answer.again'), () => actions.again(), t(p.key, p)),
      ].filter(Boolean),
    );
  };

  /** The card's actions now: Stop while the answer (or the voice question) is on its way, else Again, Share, Burn. */
  let shownActs = null;
  const drawActs = (v, busy, done, retry) => {
    const sp = v.speak;
    const speakingNow = sp.current && sp.state !== 'idle';
    const p = sp.priceMsub > 0 ? priceLine(sp.priceMsub, v.talk.unit) : null;
    const key = busy ? `busy|${v.talk.phase}` : !done ? 'none' : `${speakingNow}|${sp.available}|${p ? t(p.key, p) : ''}|${retry}|${v.againMsub}|${JSON.stringify(v.free)}`;
    if (key === shownActs) return;
    shownActs = key;
    if (busy) {
      openTray(false);
      acts.replaceChildren(tile('stopBtn', 'stop', t('answer.stop'), () => (v.talk.phase === 'sending' ? actions.talkCancel() : actions.stop())));
      return;
    }
    if (!done) {
      openTray(false);
      acts.replaceChildren();
      return;
    }
    const hear = !sp.available
      ? null
      : speakingNow
        ? tile('speakStopBtn', 'stop', t('speak.stop'), () => actions.stopSpeaking())
        : tile('speakBtn', 'speaker', t('playful.hearAgain'), () => actions.speak(), p ? t(p.key, p) : null, { 'aria-label': t('playful.hearAgainLabel') });
    const share = tile('shareBtn', 'share', t('playful.share'), () => openTray(tray.hidden), null, { 'aria-expanded': String(!tray.hidden), 'aria-controls': 'shareTray', 'aria-label': t('playful.shareLabel') });
    acts.replaceChildren(...[hear, share, burnTile()].filter(Boolean));
    drawTray(v, retry);
  };

  // Pip's line, or a message from the app (ui.toast) for its time.
  let note = null;
  let noteTimer = 0;
  const stopSays = pipSays(ui, (msg, ms) => {
    clearTimeout(noteTimer);
    note = msg ? { text: msg, calm: CALM.some((k) => t(k) === msg) } : null;
    if (note) noteTimer = setTimeout(() => ((note = null), update()), Math.max(ms, 3000));
    update();
  });

  // The seconds waited for the first words, and the slow-model offer after SLOW_MS (as on Default).
  let since = null;
  let timer = 0;
  const tickWait = () => {
    if (since == null) return;
    const ms = Date.now() - since;
    secs.textContent = t('answer.seconds', { n: Math.max(0, Math.floor(ms / 1000)) });
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
  const setWaiting = (from) => {
    if (from === since) return;
    since = from;
    secs.hidden = from == null;
    if (from == null) {
      clearInterval(timer);
      timer = 0;
      slow.hidden = true;
      return;
    }
    tickWait();
    timer ||= setInterval(tickWait, 250);
  };

  let shownText = null;
  let enhanced = null; // the text whose code blocks and links were finished (md.enhance), once it is in
  let shownErr = null;
  /** Draws the answer: the first sentence big, the rest under it (Markdown once it is in). */
  const drawText = (content, streaming) => {
    if (content === shownText) return;
    shownText = content;
    const { lead: l, rest: rs } = splitLead(content ?? '');
    const put = (node, s) => {
      if (!s) node.replaceChildren();
      else if (md) node.innerHTML = md.renderMarkdown(s);
      else node.replaceChildren(el('p', { class: 'plain', text: s }));
    };
    put(lead, l.trim());
    put(rest, rs.trim());
    enhanced = null;
    text.setAttribute('aria-busy', String(streaming));
  };
  const showError = (key, box) => {
    if (key === shownErr) return;
    shownErr = key;
    errBox.hidden = !box;
    if (box) errBox.replaceChildren(...box);
  };

  let hearingSince = null;
  let shownLine = null;
  const update = () => {
    const v = state.view();
    top.update();
    hold.update();
    r.set(v.fundsFraction, v.memory.free, v.memory.low, v.freeFraction);
    const recording = v.talk.phase === 'recording';
    // Out of sight while recording, its room kept: the reply button must not move under the finger.
    careful.style.visibility = recording ? 'hidden' : '';
    const ln = answerLine(v);
    face.set(note ? (note.calm ? 'idle' : 'oops') : ln.mood);
    line.dataset.reading = String(!note && !!ln.reading);
    // Written only when it changes: the line is a live region, and the answer redraws as it streams.
    const said = note ? `n|${note.text}` : t(ln.key);
    if (said !== shownLine) {
      shownLine = said;
      if (note) sayShort(lineText, note.text);
      else lineText.textContent = said;
    }
    const tk = v.talk;
    // A voice question on its way to being text, or one that could not be heard.
    if (tk.phase === 'sending' || tk.error) {
      drawText('', false);
      asked.textContent = tk.phase === 'sending' ? t('talk.hearing') : t('talk.notHeard');
      if (tk.phase === 'sending') {
        hearingSince ??= Date.now();
        setWaiting(hearingSince);
        showError(null, null);
        drawActs(v, true, false, false);
        return;
      }
      hearingSince = null;
      setWaiting(null);
      drawActs(v, false, false, false);
      if (tk.error.key) showError(`k|${tk.error.key}`, [sayEl('p', { id: 'answerErrorText' }, t(tk.error.key), 'err'), sayEl('p', { class: 'hint' }, t('talk.holdAgain'), '', 'mic')]);
      else {
        const ev = errorView(tk.error.code, tk.error.message, tk.error.charged);
        const go = { addFunds: () => nav('addFunds'), chooseModel: () => nav('model'), startFresh: () => (actions.startFresh(), nav('home')), takeOut: () => nav('takeOut') }[ev.next];
        // Trying again means holding the button again: the recording was not kept.
        showError(`c|${tk.error.code}|${tk.error.message}`, [sayEl('p', { id: 'answerErrorText' }, t(ev.key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, tk.unit) : '' }), 'err'), go ? nextBtn(ev.next, go) : sayEl('p', { class: 'hint' }, t('talk.holdAgain'), '', 'mic')]);
      }
      return;
    }
    hearingSince = null;
    const ex = v.lastExchange;
    if (!ex) {
      asked.textContent = '';
      setWaiting(null);
      drawText('', false);
      showError(null, null);
      drawActs(v, false, false, false);
      return;
    }
    asked.textContent = ex.question;
    const a = ex.answer;
    const streaming = v.streaming;
    setWaiting(streaming && !a.content ? (v.waitSince ?? Date.now()) : null);
    drawText(a.content, streaming);
    if (streaming) {
      showError(null, null);
      drawActs(v, true, false, false);
      return;
    }
    let retry = false;
    if (a.meta?.error) {
      const ev = errorView(a.meta.error.code, a.meta.error.message, a.meta.error.charged);
      retry = ev.next === 'retry';
      const go = { addFunds: () => nav('addFunds'), retry: () => actions.again(), chooseModel: () => nav('model'), startFresh: () => (actions.startFresh(), nav('home')), takeOut: () => nav('takeOut'), freeOut: () => nav('freeOut') }[ev.next];
      const p = priceLine(v.againMsub, v.againUnit ?? v.talk.unit, v.free);
      showError(`a|${a.meta.error.code}|${a.meta.error.message}|${t(p.key, p)}`, [
        sayEl('p', { id: 'answerErrorText' }, t(ev.key, { message: ev.message ?? '', amount: ev.charged > 0 ? format.cost(ev.charged, a.meta.unit) : '' }), 'err'),
        nextBtn(ev.next, go),
        // Trying again asks the model again: a paid question, with its price before the tap.
        retry ? el('p', { class: 'price-line', id: 'retryPrice' }, el('span', { class: 'cap', text: t('price.label') }), el('span', { class: 'amount', text: t(p.key, p) })) : null,
      ]);
    } else showError(null, null);
    drawActs(v, false, true, retry);
    if (md && enhanced !== shownText) {
      enhanced = shownText;
      md.enhance(lead);
      md.enhance(rest);
    }
  };

  update();
  const unbar = playfulBar();
  // Once Markdown is in, the answer is drawn again with it.
  let gone = false;
  if (!md)
    loadMarkdown()
      .then((m) => {
        md = m;
        if (gone) return;
        shownText = null;
        update();
      })
      .catch(() => {});
  return {
    node: main,
    update,
    destroy: () => {
      gone = true;
      clearInterval(timer);
      clearTimeout(noteTimer);
      stopSays();
      burner?.destroy();
      hold.destroy?.();
      unbar();
    },
    focus: card,
  };
}
