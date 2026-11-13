// DOM helpers for the v2 screens. `el` and the storage helpers come from v1's ui.js; the icons are the
// canvas icons (24 px grid, stroke 2), drawn inline so nothing is fetched.
import { el, load, store } from '../../js/ui.js';

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

let toastTimer;
/** A short message at the bottom of the screen, also read out by screen readers. */
export function toast(text, ms = 2600) {
  let t = document.getElementById('toast');
  if (!t) {
    t = el('div', { id: 'toast', class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(t);
  }
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
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

/** A status line under a form: role=status, with a kind of '', 'err' or 'ok'. */
export function msgLine() {
  const p = el('p', { class: 'msg', role: 'status' });
  p.set = (text, kind = '') => {
    p.textContent = text;
    p.className = 'msg ' + kind;
  };
  return p;
}
