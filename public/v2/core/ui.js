// DOM helpers for the v2 screens. `el` and the storage helpers come from v1's ui.js; the icons are the
// canvas icons (24 px grid, stroke 2), drawn inline so nothing is fetched.
import { el, load, store } from '../../js/ui.js';
import { t as tr } from './i18n.js';

export { el, load, store };

const PATHS = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  unlock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>',
  mic: '<path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/>',
  keyboard: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M8 14h8"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  dots: '<circle cx="5" cy="12" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="19" cy="12" r="1.5"/>',
  back: '<path d="M15 6l-6 6 6 6"/>',
  next: '<path d="M9 6l6 6-6 6"/>',
  x: '<path d="M6 6l12 12"/><path d="M18 6L6 18"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2z"/><path d="M9 8h6M9 12h6"/>',
  takeout: '<path d="M12 15V4"/><path d="M8 8l4-4 4 4"/><path d="M5 13v6h14v-6"/>',
  book: '<path d="M5 4h10a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z"/><path d="M5 17a3 3 0 0 1 3-3h10"/>',
  image: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 16l5-5 4 4 3-3 6 5"/>',
  chat: '<path d="M4 5h16v11H9l-5 4z"/>',
  flame: '<path d="M12 3c.9 3.3 5 5.4 5 10.2a5 5 0 0 1-10 0c0-2.3 1-3.9 2.1-4.8.3 1.7 1.2 2.7 2.3 3C10.7 9 11 6 12 3z"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  sun: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  camera: '<path d="M4 8h3l2-3h6l2 3h3v11H4z"/><circle cx="12" cy="13" r="3.5"/>',
  file: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  grid: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><circle cx="16.5" cy="16.5" r="3.5"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
  nfc: '<path d="M7 9a4.5 4.5 0 0 1 0 6"/><path d="M10.5 6.5a8 8 0 0 1 0 11"/><path d="M14 4a11.5 11.5 0 0 1 0 16"/>',
  qr: '<rect x="4" y="4" width="6" height="6"/><rect x="14" y="4" width="6" height="6"/><rect x="4" y="14" width="6" height="6"/><path d="M14 14h2v2M20 14v6h-6"/>',
  coins: '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M5 12v5c0 1.7 3.1 3 7 3s7-1.3 7-3v-5"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  chain: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  swap: '<path d="M4 8h14l-3-3M20 16H6l3 3"/>',
  gauge: '<path d="M5 17a8 8 0 1 1 14 0"/><path d="M12 13l4-4"/>',
  bulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-4 10.5c.7.7 1 1.5 1 2.5h6c0-1 .3-1.8 1-2.5A6 6 0 0 0 12 3z"/>',
  layers: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  again: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9"/><path d="M20 4v5h-5"/><path d="M20 12a8 8 0 0 1-14 5.3L4 15"/><path d="M4 20v-5h5"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2"/>',
  send: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  external: '<path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  download: '<path d="M12 4v11"/><path d="M8 11l4 4 4-4"/><path d="M5 19h14"/>',
  speaker: '<path d="M4 9h4l5-4v14l-5-4H4z"/><path d="M16.5 9a4 4 0 0 1 0 6"/><path d="M19 6.5a8 8 0 0 1 0 11"/>',
  gift: '<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M3 9h18v3H3z"/><path d="M12 9v11"/><path d="M12 9c-1.5-3-5-3-5-1s3 1 5 1c2 0 5 1 5-1s-3.5-2-5 1z"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  phone: '<rect x="7" y="3" width="10" height="18" rx="2"/><path d="M11 18h2"/>',
  shield: '<path d="M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z"/>',
  server: '<rect x="4" y="4" width="16" height="7" rx="2"/><rect x="4" y="13" width="16" height="7" rx="2"/><path d="M8 7.5h.01M8 16.5h.01"/>',
  eye: '<path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7.5h.01"/>',
  hand: '<path d="M9 11V5a1.5 1.5 0 0 1 3 0v5M12 10V4a1.5 1.5 0 0 1 3 0v6M15 10V6a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-.5A6.5 6.5 0 0 1 5 16l-1.6-3a1.5 1.5 0 0 1 2.5-1.6L9 14"/>',
  paste: '<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h4"/>',
  noName: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/><path d="M3 3l18 18"/>',
  noEmail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/><path d="M3 3l18 18"/>',
  noMoney: '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v5c0 1.7 3.1 3 7 3s7-1.3 7-3V7"/><path d="M3 3l18 18"/>',
  alert: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v5.5"/><path d="M12 16.5h.01"/>',
  wait: '<path d="M7 3h10M7 21h10"/><path d="M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9"/>',
  ear: '<path d="M7 9a5 5 0 0 1 10 0c0 3-3 4-3 7a3 3 0 0 1-5.5 1.6"/><path d="M10 9.5a2 2 0 0 1 4 0"/>',
  pin: '<rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 15h.01M12 15h.01M16 15h.01"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
  // Speed marks (owner, 2026-11-15): a hare sitting up, ears back, for a fast model; a tortoise for a slow one.
  rabbit: '<path d="M14.4 10.6c-1.3-.7-2.8-1.1-4.5-1.1C5.8 9.5 3 12 3 14.8c0 1.2.5 2.3 1.4 3.1"/><path d="M14.4 10.6c.9-.5 2-.8 3.1-.8 2.2 0 4 1.4 4 3.2 0 1.1-.9 2-2 2h-1.3"/><path d="M18.2 15c-.7 1.3-2 2.1-3.6 2.3l1.1 1.9h2"/><path d="M4.4 17.9l-.9 1.3h4.2c1.3 0 2.3-.6 2.9-1.6"/><path d="M15.4 10.1C14.2 7.6 12.4 5.7 10.2 5c.5 2.5 2 4.4 3.9 5.4"/><path d="M17.9 9.8c-.1-2.6-1-4.9-2.6-6.2-.6 2.3-.3 4.6 1 6.4"/><path d="M3.2 13.4c-.9.1-1.6-.5-1.6-1.4"/><circle cx="18.8" cy="12.1" r=".8" fill="currentColor" stroke="none"/>',
  turtle: '<path d="M3 15.5a7.5 7 0 0 1 15 0z"/><path d="M6.6 15.5l1.6-3.8h4.6l1.6 3.8"/><path d="M8.2 11.7L7 9.1M12.8 11.7l1.2-2.6"/><path d="M17.7 13.6c.7-1.2 1.7-1.9 2.9-1.9a1.65 1.65 0 0 1 0 3.3H18"/><path d="M5.2 15.5l-.5 2.4h2M15.6 15.5l.5 2.4h2"/><path d="M3 15.5l-1.4.8"/><circle cx="20.5" cy="13.2" r=".6" fill="currentColor" stroke="none"/>',
  // Add (a photo or a file to the question) is a paper clip; Add money is a bank note with a plus, so the
  // two never share one plus (owner, 2026-11-15).
  clip: '<path d="M20 11.5l-7.8 7.8a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8"/>',
  addMoney: '<rect x="1.5" y="11" width="16" height="9" rx="2"/><circle cx="9.5" cy="15.5" r="2"/><path d="M4.8 15.5h.01M14.2 15.5h.01"/><path d="M19.5 3v6.5M16.25 6.25h6.5"/>',
  ticket: '<path d="M4 6h16a1 1 0 0 1 1 1v3a2 2 0 0 0 0 4v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-4V7a1 1 0 0 1 1-1z"/><path d="M14.5 7.5v1.5M14.5 11.25v1.5M14.5 15v1.5"/>',
  scan: '<path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"/><rect x="8" y="8" width="3" height="3"/><rect x="13" y="13" width="3" height="3"/><path d="M13 8h3v2M8 13v3h2"/>',
  newChat: '<path d="M4 5h16v11H9l-5 4z"/><path d="M12 7.5v6M9 10.5h6"/>',
  share: '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  star: '<path d="M12 3l2.7 5.6 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 2.9 1.2-6.2L3 9.4l6.3-.8z"/>',
};

export const ICONS = Object.keys(PATHS);

/** An inline SVG icon. The markup is static and from this file only. */
export function icon(name, size = 20, stroke = 2) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('width', String(size));
  s.setAttribute('height', String(size));
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', String(stroke));
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('ico');
  s.innerHTML = PATHS[name] ?? '';
  return s;
}

/**
 * Reading load (owner, 2026-11-15): a message is written headline first. The first sentence says what
 * happened in a few words; the rest is the detail. headOf splits the two: [head, rest], where rest keeps
 * the space before it, so head + rest is the text as written.
 */
export function headOf(text) {
  const s = String(text ?? '');
  const m = s.match(/^(.+?[.?!])(\s+\S[\s\S]*)$/);
  return m ? [m[1], m[2]] : [s, ''];
}

const SAY_ICON = { err: 'alert', ok: 'check', wait: 'wait' };
let sayN = 0;

/**
 * Writes `text` into `node` headline first: an icon (by kind: 'err', 'ok', 'wait', or `ico`), the first
 * sentence in view, and the rest behind a round info button, which shows it under the line. Screen
 * readers and Listen read the whole text in place (it sits in the line, visually hidden until the info
 * button opens it), and node.textContent stays the text as written. An empty text empties the node.
 */
export function say(node, text, kind = '', ico = null) {
  // Screens redraw many times a second (a recording's level): the same words keep their open info.
  node.classList.add('say');
  node.classList.toggle('has-ico', !!(text && (ico ?? SAY_ICON[kind])));
  const key = `${kind}|${ico}|${text}`;
  if (node._said === key && node.isConnected) return node;
  node._said = key;
  if (!text) return (node.replaceChildren(), node);
  const [head, rest] = headOf(text);
  const name = ico ?? SAY_ICON[kind];
  const kids = [name ? icon(name, 18) : null, el('span', { class: 'say-head', text: head })];
  if (rest) {
    const id = node.id ? `${node.id}More` : `sayMore${++sayN}`;
    const more = el('span', { class: 'say-rest sr-only', id, text: rest });
    const btn = el('button', { type: 'button', class: 'info-btn', 'aria-label': tr('common.info'), 'aria-expanded': 'false', 'aria-controls': id }, icon('info', 20));
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const open = more.classList.contains('sr-only');
      more.className = open ? 'say-rest info-more' : 'say-rest sr-only';
      btn.setAttribute('aria-expanded', String(open));
    });
    kids.push(more, btn);
  }
  node.replaceChildren(...kids.filter(Boolean));
  return node;
}

/** An element holding `text` headline first (say). */
export const sayEl = (tag, attrs, text, kind = '', ico = null) => say(el(tag, attrs), text, kind, ico);

/**
 * A round info button that shows and hides `panel` (its words, which then count as opened detail).
 * label: what the button is about, for screen readers.
 */
export function infoToggle(panel, label, id = null) {
  panel.hidden = true;
  panel.classList.add('info-more');
  if (!panel.id) panel.id = `infoPanel${++sayN}`;
  const btn = el('button', { type: 'button', class: 'info-btn', id, 'aria-label': label, 'aria-expanded': 'false', 'aria-controls': panel.id }, icon('info', 20));
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    panel.hidden = !panel.hidden;
    btn.setAttribute('aria-expanded', String(!panel.hidden));
  });
  return btn;
}

let toastTimer;
let toastCatcher = null;

/**
 * A screen that says short messages in its own place (Playful mode's Pip, docs/PLAYFUL.md) takes the
 * toasts while it is shown: fn(text, ms) returns true when it took the message, and is called with null
 * when hideToast() runs. Pass null to give the toasts back. Default never sets one.
 */
export function catchToasts(fn) {
  toastCatcher = fn;
}

/** A short message at the bottom of the screen: its first sentence in view, the whole read out by screen readers. */
export function toast(text, ms = 2600) {
  if (toastCatcher?.(text, ms)) return;
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  const [head, rest] = headOf(text);
  t.replaceChildren(el('span', { text: head }), rest ? el('span', { class: 'sr-only', text: rest }) : '');
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

/**
 * Says `text` to screen readers only (a polite live region), where a toast would cover what the screen
 * shows: the answer screen says "Answer ready." this way, under the words it is about.
 */
export function announce(text) {
  let n = document.getElementById('announce');
  if (!n) {
    n = el('div', { id: 'announce', class: 'sr-only', role: 'status', 'aria-live': 'polite' });
    document.body.append(n);
  }
  n.textContent = '';
  setTimeout(() => (n.textContent = String(text ?? '')), 30);
}

/** Hides the toast now (a wait it said is over, and the screen says what came of it). */
export function hideToast() {
  toastCatcher?.(null, 0);
  clearTimeout(toastTimer);
  document.getElementById('toast')?.classList.remove('show');
}

export async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** A bottom row button: icon over a label, or icon beside it. */
export function tileButton({ ico, label, onclick, cls = 'tile', id, attrs = {} }) {
  return el('button', { type: 'button', class: cls, id, onclick, ...attrs }, icon(ico, 20), el('span', { text: label }));
}

/** The 48 px round back button, the centred title and a spacer (sub screens). */
export function backHeader(title, onBack, backLabel) {
  return el(
    'header',
    { class: 'back-head' },
    el('button', { type: 'button', class: 'round', 'aria-label': backLabel, onclick: onBack }, icon('back', 22)),
    el('h1', { text: title, tabindex: '-1' }),
    el('span', { class: 'spacer', 'aria-hidden': 'true' }),
  );
}

/** A list row: tinted icon tile, title, subtitle and a chevron. */
export function listRow({ ico, tint = 'gold', title, sub, onclick, id, cls = '' }) {
  return el(
    'button',
    { type: 'button', class: `row ${cls}`.trim(), id, onclick },
    el('span', { class: `tile-ico tint-${tint}` }, icon(ico, 22)),
    el('span', { class: 'row-text' }, el('b', { text: title }), sub ? el('small', { text: sub }) : null),
    icon('next', 18),
  );
}

/**
 * A download bar: a progressbar with what is done and the phase in words under it. set({fraction, text,
 * phase}) moves the bar (fraction 0 to 1, or null to leave it) and writes the two lines.
 */
export function meterBar({ id, label }) {
  const fill = el('span');
  fill.style.width = '0%';
  const bar = el('div', { class: 'bar meter-bar', role: 'progressbar', 'aria-label': label, 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, fill);
  const amount = el('p', { class: 'meter-amount' });
  const phase = el('p', { class: 'meter-phase', 'aria-live': 'polite' });
  const node = el('div', { class: 'meter', id }, bar, amount, phase);
  node.set = ({ fraction = null, text, phase: words } = {}) => {
    if (fraction != null) {
      const pct = Math.max(0, Math.min(100, Math.floor(fraction * 100)));
      fill.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
    }
    if (text != null) amount.textContent = text;
    if (words != null) phase.textContent = words;
  };
  return node;
}

/**
 * A status line under a form: role=status, with a kind of '', 'err', 'ok' or 'wait'. The words go in
 * headline first, with the kind's icon (say). A message without a kind that ends in no full stop is a
 * step under way ("Adding your eCash"): it shows the wait icon.
 */
export function msgLine() {
  const p = el('p', { class: 'msg', role: 'status' });
  p.set = (text, kind = '') => {
    p.className = 'msg ' + kind;
    say(p, text, kind || (text && !/[.?!]$/.test(text) ? 'wait' : ''));
  };
  return p;
}
