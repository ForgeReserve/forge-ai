// Playful home (docs/PLAYFUL.md; the design's KidsHome): the Private and star chips, Pip with a speech
// bubble, the two rings round a white Hold to talk button, and a bar of three chunky buttons.
// It is the Default home's logic in another dress: the same talk button (screens/talk.js: hold, slide off
// to cancel, haptics, the blockers), the same rings (screens/parts.js), the same Add and More sheets
// (handed in by the app) and the same places to go. What the Default home shows as chips and toasts, Pip's
// bubble says (logic.js homeMessage): no funds and the one way forward, memory nearly full, files added,
// offline, and any short message (a cancelled recording, a blocked microphone). While a question is
// recorded the bubble holds the recording's line: the time, where the sound goes and the price.
import { el, icon } from '../../../core/ui.js';
import { rings } from '../../../screens/parts.js';
import { holdToTalk } from '../../../screens/talk.js';
import { homeMessage } from './logic.js';
import { bar, chips, mic, pipSays, playfulBar, sayShort } from './parts.js';
import { pip } from './pip.js';

/** The bubble's one button: where it goes, its picture and its word. */
const GO = { startFree: ['gift', 'playful.startFree'], addFunds: ['addMoney', 'home.addMoney'], freeOut: ['gift', 'playful.otherWays'], funds: ['layers', 'playful.openMemory'] };
/** Messages that are good news: Pip smiles at these, and looks worried at the rest. */
const CALM = ['answer.copied', 'history.burned', 'history.burnedAll'];

export function home({ t, ui, state, nav, actions }, { sheet = null, open = null } = {}) {
  const top = chips({ t, state, nav, actions });
  const helper = pip({ size: 84, label: t('playful.pip') });
  const words = el('p', { class: 'pf-say', id: 'pipSays' });
  const go = el('div', { class: 'pf-say-go' });
  const r = rings('playful');
  const ringBtn = el('button', { type: 'button', class: 'ring-hit', id: 'ringsBtn', onclick: () => nav('funds') });
  // Hold to talk (screens/talk.js). Where voice cannot be used here, the button opens Type.
  const talk = el('button', { type: 'button', class: 'talk', id: 'talkBtn', 'aria-describedby': 'talkHint' });
  const hold = holdToTalk(talk, { t, state, actions, nav, hintId: 'talkHint', size: 'big', glyph: mic });
  const bubble = el('div', { class: 'pf-bubble', id: 'pipBubble', role: 'status', 'aria-live': 'polite' }, words, go, hold.info);
  const ringBox = el('div', { class: 'rings pf-rings' }, r.node, ringBtn, talk);
  const stage = el('div', { class: `stage pf-stage${sheet ? ' faded' : ''}` }, el('div', { class: 'pf-helper' }, helper.node, bubble), ringBox, hold.hint);
  const main = el('main', { class: `screen home pf pf-home${sheet ? ' with-sheet' : ''}`, 'data-screen': 'home', 'data-mode': 'playful' }, top.node, stage);
  // Add and More: the app's sheet over the whole home, the bar above it so Close stays in view.
  if (sheet) main.append(el('div', { class: 'float-wrap', onclick: (e) => e.target === e.currentTarget && nav('home') }, sheet));
  main.append(bar({ t, nav, open }));

  // A message from the app (ui.toast) shows in the bubble for its time, over what Pip would say.
  let note = null;
  let noteTimer = 0;
  const stopSays = pipSays(ui, (text, ms) => {
    clearTimeout(noteTimer);
    note = text ? { text, calm: CALM.some((k) => t(k) === text) } : null;
    if (note) noteTimer = setTimeout(() => ((note = null), update()), Math.max(ms, 3000));
    update();
  });

  let shownGo = '';
  let shownSaid = null;
  const update = () => {
    const v = state.view();
    top.update();
    hold.update();
    const recording = v.talk.phase === 'recording';
    r.set(v.fundsFraction, v.memory.free, v.memory.low, v.freeFraction);
    ringBtn.setAttribute('aria-label', v.balanceText ? t('home.rings', { funds: v.balanceText, memory: v.memory.percentFree }) : t('home.ringsEmpty', { memory: v.memory.percentFree }));
    const m = recording ? homeMessage(v) : note ? { key: null, mood: note.calm ? 'idle' : 'oops' } : homeMessage(v);
    helper.set(m.mood);
    bubble.dataset.state = recording ? 'recording' : note ? 'note' : (m.key ?? '');
    words.hidden = recording;
    // Pip says his own words whole; a message from the app shows its first sentence, as the toast does.
    // Written only when they change: the bubble is a live region, and the home redraws many times a second.
    const said = recording ? '' : note ? `n|${note.text}` : t(m.key, { count: m.count ?? 0 });
    if (said !== shownSaid) {
      shownSaid = said;
      if (note) sayShort(words, note.text);
      else if (!recording) words.textContent = said;
    }
    // The way forward, when there is one: Start free, Add money, the other ways, or Funds and memory.
    const way = !recording && !note && m.go ? m.go : '';
    if (way !== shownGo) {
      shownGo = way;
      go.replaceChildren(...(way ? [el('button', { type: 'button', class: 'pf-go', id: 'pipGo', 'data-go': way, onclick: () => nav(way) }, icon(GO[way][0], 22), el('span', { text: t(GO[way][1]) }))] : []));
    }
    go.hidden = !way;
  };
  update();
  const unbar = playfulBar();
  return {
    node: main,
    update,
    destroy: () => {
      clearTimeout(noteTimer);
      stopSays();
      hold.destroy();
      unbar();
    },
    focus: sheet ? sheet.querySelector('button') : talk,
  };
}
