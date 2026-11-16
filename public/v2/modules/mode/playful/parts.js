// Parts shared by Playful mode's home and answer (docs/PLAYFUL.md): the top chips (Private and the star),
// the bottom bar, Pip's messages in place of the toasts, and the phone's bar colour.
import { el, headOf, icon } from '../../../core/ui.js';
import { bottomRow } from '../../../screens/parts.js';
import { starLevel } from './logic.js';

/** The ground of the Playful screens, also the phone's bar colour while they show. */
export const GROUND = '#4B3FC9';

const NS = 'http://www.w3.org/2000/svg';

/** The design's gold star, filled. */
function star(size) {
  const s = document.createElementNS(NS, 'svg');
  for (const [k, v] of Object.entries({ width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', class: 'ico pf-star' })) s.setAttribute(k, String(v));
  s.innerHTML = '<path d="M12 3l2.7 5.6 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 2.9 1.2-6.2L3 9.4l6.3-.8z" fill="#FFC21A" stroke="#B8860B" stroke-width="0.8" stroke-linejoin="round"/>';
  return s;
}

/**
 * The top row: Private (or Standard) on the left, as the Default status bar says it, and the star chip on
 * the right in place of the money chip: how much is left in a few words, never a price (logic.js
 * starLevel). The star opens Funds and memory, as the money chip does; with no balance key on a free
 * model it opens Start free.
 */
export function chips({ t, state, nav }) {
  const pill = el('div', { class: 'pf-chip pf-private', id: 'privacyPill' });
  const words = el('span', { id: 'starWords' });
  const go = () => {
    const v = state.view();
    if (v.fundsBlock === 'needKey') nav(v.startFree ? 'startFree' : 'addFunds');
    else nav('funds');
  };
  const starBtn = el('button', { type: 'button', class: 'pf-chip pf-stars', id: 'starChip', onclick: go }, star(20), words);
  const update = () => {
    const v = state.view();
    pill.replaceChildren(icon(v.private ? 'lock' : 'unlock', 18, 2.4), el('span', { text: v.private ? t('status.private') : t('status.standard') }));
    pill.dataset.kind = v.private ? 'private' : 'standard';
    pill.setAttribute('title', v.private ? t('status.privateLabel') : t('status.standardLabel'));
    pill.setAttribute('aria-label', v.private ? t('status.privateLabel') : t('status.standardLabel'));
    const level = v.online || v.balanceText ? starLevel({ model: v.model, unit: v.talk.unit, balanceMsub: v.balanceMsub, freeLeft: v.freeLeft, fundsBlock: v.fundsBlock }) : 'offline';
    starBtn.dataset.level = level;
    words.textContent = level === 'offline' ? t('status.offline') : t(`playful.star.${level}`);
    starBtn.setAttribute('aria-label', t('playful.starLabel', { words: words.textContent }));
  };
  update();
  return { node: el('div', { class: 'pf-top' }, pill, starBtn), update };
}

/** The bottom bar: the app's Type, Add and More (screens/parts.js), as the design's three coloured buttons. */
export const bar = ({ t, nav, open = null }) => bottomRow({ t, nav, open, ico: { add: 'plus' } });

/** The design's plain microphone on the white talk button. */
export const mic = (px) => icon('mic', px, 2);

/**
 * Pip says the app's short messages (ui.toast) while a Playful screen shows: show(text, ms) gets each
 * one, and show(null) when it is over. A message sent just before the screen goes (a blocker's toast,
 * then Add money opens) is passed on: to the next Playful screen, or as the ordinary toast. Returns stop().
 */
export function pipSays(ui, show) {
  let alive = true;
  ui.catchToasts?.((text, ms) => {
    if (text == null) return (show(null, 0), true);
    // Navigation happens in the same task as the toast that asks for it: decide once it is done.
    setTimeout(() => (alive ? show(text, ms) : ui.toast(text, ms)), 0);
    return true;
  });
  return () => {
    alive = false;
    ui.catchToasts?.(null);
  };
}

/** A message in Pip's words: the first sentence in view, the rest for screen readers (as the toast does). */
export function sayShort(node, text) {
  const [head, rest] = headOf(text);
  node.replaceChildren(el('span', { text: head }), rest ? el('span', { class: 'sr-only', text: rest }) : '');
}

/**
 * The phone's bar and the page's ground in the Playful colour while a Playful screen shows. Returns the
 * undo, which gives the bar back to the look (its --bg).
 */
export function playfulBar() {
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute('content', GROUND);
  return () => {
    const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
    if (bg) meta?.setAttribute('content', bg);
  };
}
