// The hold-to-talk button (ZHome1, XListenLight): press and hold to record, let go to send, slide off
// and let go to cancel. A tap explains it. While it records, the button shows level bars and "Let go to
// send", and a line under the rings gives the time, where the sound goes and the price before sending.
// With no way to turn voice into words here, the button opens Type, so it never leads nowhere.
// Works with a finger, a mouse, and the keyboard (hold Space or Enter; Escape cancels).
import { clock, inside } from '../core/talk.js';
import { priceLine } from '../core/price.js';
import { el, say } from '../core/ui.js';

const BARS = 9;
const SHAPE = [0.45, 0.7, 0.9, 0.6, 1, 0.65, 0.85, 0.55, 0.4];

let micN = 0;

/**
 * The microphone on the talk button, drawn with the button's light (a key light from the top left): a
 * rounded capsule shaded as a cylinder with its grille and a specular streak, the yoke and stand, and a
 * soft shadow under it on the button. Its colour is the button's ink (currentColor), so every look
 * keeps its own; the light and shade are white and black on top. Static markup from this file only.
 */
export function micGlyph(size) {
  const p = `mic${++micN}-`;
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 64 64', 'aria-hidden': 'true', class: 'ico talk-mic' })) s.setAttribute(k, String(v));
  const body = 'M32 5.5a10 10 0 0 1 10 10v16.5a10 10 0 0 1-20 0V15.5a10 10 0 0 1 10-10z';
  const stand = 'M15.5 29v3a16.5 16.5 0 0 0 33 0v-3M32 48.5v8M24 57.5h16';
  s.innerHTML = [
    `<defs><filter id="${p}sh" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.3"/></filter>`,
    `<linearGradient id="${p}cyl" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#000" stop-opacity="0.04"/><stop offset="0.3" stop-color="#fff" stop-opacity="0.1"/><stop offset="0.62" stop-color="#000" stop-opacity="0.12"/><stop offset="1" stop-color="#000" stop-opacity="0.38"/></linearGradient>`,
    `<linearGradient id="${p}top" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity="0.35"/><stop offset="0.35" stop-color="#fff" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.2"/></linearGradient>`,
    `<linearGradient id="${p}metal" gradientUnits="userSpaceOnUse" x1="14" y1="28" x2="50" y2="60"><stop offset="0" stop-color="#fff" stop-opacity="0.18"/><stop offset="0.5" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.32"/></linearGradient>`,
    `<linearGradient id="${p}rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0.55" stop-color="#3FCFB4" stop-opacity="0"/><stop offset="1" stop-color="#9FF5E2" stop-opacity="0.75"/></linearGradient></defs>`,
    // The shadow on the button, down and to the right of the light.
    `<g transform="translate(1.4 2.4)" opacity="0.55" filter="url(#${p}sh)"><path d="${body}" fill="#000"/><path d="${stand}" fill="none" stroke="#000" stroke-width="3.6" stroke-linecap="round"/></g>`,
    // The stand, lit along its top left.
    `<path d="${stand}" fill="none" stroke="currentColor" stroke-width="3.4" stroke-linecap="round"/>`,
    `<path d="${stand}" fill="none" stroke="url(#${p}metal)" stroke-width="3.4" stroke-linecap="round"/>`,
    `<path d="M16.6 33.5a15.6 15.6 0 0 0 5.4 10.9" fill="none" stroke="#fff" stroke-opacity="0.55" stroke-width="0.9" stroke-linecap="round"/>`,
    // The capsule: shaded as a cylinder, its grille, its specular streak and the rim light.
    `<path d="${body}" fill="currentColor"/>`,
    `<path d="${body}" fill="url(#${p}cyl)"/>`,
    `<path d="${body}" fill="url(#${p}top)"/>`,
    `<path d="M26 14.5h12M25 19.5h14M25 24.5h14" fill="none" stroke="#000" stroke-opacity="0.22" stroke-width="1.6" stroke-linecap="round"/>`,
    `<path d="M26 15.3h12M25 20.3h14M25 25.3h14" fill="none" stroke="#fff" stroke-opacity="0.22" stroke-width="0.7" stroke-linecap="round"/>`,
    `<path d="M26.6 12.5a6.6 6.6 0 0 1 3.4-4.4v0" fill="none" stroke="#fff" stroke-opacity="0.9" stroke-width="1.4" stroke-linecap="round"/>`,
    `<rect x="25.2" y="15" width="2.4" height="17" rx="1.2" fill="#fff" opacity="0.55"/>`,
    `<path d="${body}" fill="none" stroke="url(#${p}rim)" stroke-width="1.2"/>`,
  ].join('');
  return s;
}

/**
 * Makes `button` the talk button. size: 'big' (home) or 'small' (answer). Returns {info, update}:
 * `info` is the line shown under the rings while recording.
 */
export function holdToTalk(button, { t, state, actions, nav, hintId, size = 'big' }) {
  const mic = micGlyph(size === 'big' ? 70 : 36);
  const bars = el('span', { class: 'level-bars', 'aria-hidden': 'true', hidden: true }, ...Array.from({ length: BARS }, () => el('span', { class: 'bar' })));
  const label = el('span', { class: 'talk-label' });
  button.replaceChildren(mic, bars, label);
  const hint = el('p', { class: 'sr-only', id: hintId });

  const time = el('p', { class: 'listen-time', id: size === 'big' ? 'talkTime' : 'replyTime' });
  const heard = el('p', { class: 'listen-text', hidden: true });
  const route = el('span', { class: 'listen-route' });
  const price = el('span', { class: 'listen-price', id: size === 'big' ? 'talkPrice' : 'replyPrice' });
  const info = el('div', { class: 'listen-info', role: 'status', hidden: true }, heard, time, el('p', { class: 'listen-foot' }, route, price));

  let rect = null;
  let active = false; // this button started the recording
  const ok = () => state.view().talk.available;

  const begin = () => {
    rect = button.getBoundingClientRect();
    active = true;
    actions.talkDown();
  };
  const end = () => {
    if (!active) return;
    active = false;
    actions.talkUp();
  };

  button.addEventListener('pointerdown', (e) => {
    if (!ok() || e.button > 0 || active) return;
    e.preventDefault();
    try {
      button.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
    begin();
  });
  button.addEventListener('pointermove', (e) => {
    if (active && rect) actions.talkMove(inside(rect, e.clientX, e.clientY));
  });
  button.addEventListener('pointerup', (e) => {
    if (!active) return;
    if (rect) actions.talkMove(inside(rect, e.clientX, e.clientY));
    end();
  });
  button.addEventListener('pointercancel', () => {
    if (!active) return;
    active = false;
    actions.talkCancel();
  });
  // A long press must not open the text menu or select the label.
  button.addEventListener('contextmenu', (e) => ok() && e.preventDefault());
  button.addEventListener('keydown', (e) => {
    if (!ok()) return;
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      if (!active) {
        rect = null;
        active = true;
        actions.talkDown();
      }
    } else if (e.key === 'Escape' && active) {
      active = false;
      actions.talkCancel();
    }
  });
  button.addEventListener('keyup', (e) => {
    if (ok() && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault();
      end();
    }
  });
  button.addEventListener('blur', () => {
    if (active && !rect) {
      active = false;
      actions.talkCancel();
    }
  });
  button.addEventListener('click', (e) => {
    // With voice, the press does the work. Without it, a tap opens Type.
    if (ok()) e.preventDefault();
    else nav('type');
  });
  const onHide = () => {
    if (document.visibilityState === 'hidden' && active) {
      active = false;
      actions.talkCancel();
    }
  };
  document.addEventListener('visibilitychange', onHide);

  const update = () => {
    const v = state.view();
    const tk = v.talk;
    const recording = tk.phase === 'recording';
    if (!recording) active = false;
    button.classList.toggle('recording', recording);
    button.classList.toggle('leaving', recording && !tk.inside);
    button.classList.toggle('sending', tk.phase === 'sending');
    button.dataset.phase = tk.phase;
    mic.style.display = recording ? 'none' : '';
    bars.hidden = !recording;
    if (recording) [...bars.children].forEach((b, i) => b.style.setProperty('--h', String(Math.max(0.12, Math.min(1, tk.level * 1.6 * SHAPE[i])))));
    label.textContent = recording ? (tk.inside ? t('talk.letGo') : t('talk.letGoCancel')) : tk.phase === 'sending' ? t('talk.sending') : t('home.talk');
    hint.textContent = tk.available ? t('home.talkHintVoice') : t('home.talkHint');
    info.hidden = !recording;
    if (recording) {
      const ms = tk.seconds * 1000;
      time.textContent = tk.inside ? t('talk.recording', { time: clock(ms) }) : t('talk.leaving', { time: clock(ms) });
      heard.hidden = !tk.text;
      heard.textContent = tk.text;
      // Where the sound goes, headline first with its picture; the detail behind info (core/ui.js say).
      say(route, t({ phone: 'talk.routePhone', 'engine-private': 'talk.routePrivate', 'engine-standard': 'talk.routeStandard', device: 'talk.routeDevice' }[tk.route] ?? 'talk.routeStandard'), '', { phone: 'phone', device: 'globe' }[tk.route] ?? 'ear');
      route.dataset.route = tk.route ?? '';
      // The engine's speech to text is paid, so a voice question reads as free only when the phone (or the browser) hears it.
      const p = priceLine(tk.priceMsub, tk.unit, tk.freeOk ? v.free : null);
      price.textContent = t(p.key, p);
    }
  };
  update();
  const destroy = () => {
    document.removeEventListener('visibilitychange', onHide);
    // Leaving the screen while holding (the back button, say) cancels: nothing is sent unseen.
    if (active && state.view().talk.phase === 'recording') actions.talkCancel();
    active = false;
  };
  return { info, hint, update, destroy };
}
