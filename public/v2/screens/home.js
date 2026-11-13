// Home: the two rings with the talk button, the status bar and the bottom row (ZHome1, ZHome2).
// The Add and More sheets open over it (ZAdd, ZMore): the rings fade and a floating card sits above
// the bottom row, whose button turns dark and reads Close.
import { el, icon } from '../core/ui.js';
import { bottomRow, rings, statusBar } from './parts.js';

export function home({ t, state, nav }, { sheet = null, open = null } = {}) {
  const bar = statusBar({ t, state, nav });
  const r = rings('home');
  const ringBtn = el('button', { type: 'button', class: 'ring-hit', id: 'ringsBtn', onclick: () => nav('funds') });
  // Hold to talk arrives with slice A3. Until then the button opens Type, so it never leads nowhere.
  const talk = el('button', { type: 'button', class: 'talk', id: 'talkBtn', 'aria-describedby': 'talkHint', onclick: () => nav('type') }, icon('mic', 69, 1.6), el('span', { text: t('home.talk') }));
  const hint = el('p', { class: 'sr-only', id: 'talkHint', text: t('home.talkHint') });
  const chip = el('button', { type: 'button', class: 'chip-low', id: 'memoryLow', hidden: true, onclick: () => nav('funds') }, icon('layers', 18), el('span', { text: t('home.memoryLow') }));
  const held = el('p', { class: 'held-line', id: 'heldLine', hidden: true });
  const stage = el('div', { class: `stage${sheet ? ' faded' : ''}` }, el('div', { class: 'rings home-rings' }, r.node, ringBtn, talk), chip, held, hint);
  const main = el('main', { class: 'screen home', 'data-screen': 'home' }, bar.node, stage);
  if (sheet) main.append(el('div', { class: 'float-wrap' }, sheet));
  main.append(bottomRow({ t, nav, open }));

  const update = () => {
    const v = state.view();
    bar.update();
    r.set(v.fundsFraction, v.memory.free, v.memory.low);
    ringBtn.setAttribute('aria-label', v.balanceText ? t('home.rings', { funds: v.balanceText, memory: v.memory.percentFree }) : t('home.ringsEmpty', { memory: v.memory.percentFree }));
    chip.hidden = !v.memory.low;
    held.hidden = !v.pendingCount;
    held.textContent = v.pendingCount ? t('home.attached', { count: v.pendingCount }) : '';
  };
  update();
  return { node: main, update, focus: sheet ? sheet.querySelector('button') : talk };
}
