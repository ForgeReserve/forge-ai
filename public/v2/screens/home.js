// Home: the two rings with the talk button, the status bar and the bottom row (ZHome1, ZHome2).
// Holding the talk button turns the home into Listening (XListenLight): see screens/talk.js.
// With no funds, the gold ring invites a paper note scan: its track breathes and a chip right under it
// opens the scanner in one tap. A second chip under it opens Add funds, for every other way in. Tapping the ring itself still opens Funds and memory, where Scan a note
// is the first button while there are no funds.
// The Add and More sheets open over it (ZAdd, ZMore): the rings fade and a floating card sits above
// the bottom row, whose button turns dark and reads Close. The sheet covers the whole home, the talk
// button included, and the bottom row stays fixed in view, so Close never needs a scroll.
import { el, icon } from '../core/ui.js';
import { bottomRow, rings, statusBar } from './parts.js';
import { holdToTalk } from './talk.js';

export function home({ t, state, nav, actions }, { sheet = null, open = null } = {}) {
  const bar = statusBar({ t, state, nav });
  const r = rings('home');
  const ringBtn = el('button', { type: 'button', class: 'ring-hit', id: 'ringsBtn', onclick: () => nav('funds') });
  // Hold to talk (screens/talk.js). Where voice cannot be used here, the button opens Type.
  const talk = el('button', { type: 'button', class: 'talk', id: 'talkBtn', 'aria-describedby': 'talkHint' });
  const hold = holdToTalk(talk, { t, state, actions, nav, hintId: 'talkHint', size: 'big' });
  const hint = hold.hint;
  const chip = el('button', { type: 'button', class: 'chip-low', id: 'memoryLow', hidden: true, onclick: () => nav('funds') }, icon('layers', 18), el('span', { text: t('home.memoryLow') }));
  const scanChip = el('button', { type: 'button', class: 'chip-scan', id: 'scanNote', hidden: true, onclick: () => nav('fund', { id: 'note' }) }, icon('qr', 18), el('span', { text: t('home.scanNote') }));
  // The rest of the empty state: every other way in, one tap away.
  // Once free questions are used up, it opens the ways forward instead (screens/free.js).
  const waysLabel = el('span', { text: t('home.otherWays') });
  const waysChip = el('button', { type: 'button', class: 'chip-ways', id: 'otherWays', hidden: true, onclick: () => nav(state.view().fundsBlock === 'freeOut' ? 'freeOut' : 'addFunds') }, icon('plus', 18), waysLabel);
  const held = el('p', { class: 'held-line', id: 'heldLine', hidden: true });
  const ringBox = el('div', { class: 'rings home-rings' }, r.node, ringBtn, talk);
  const stage = el('div', { class: `stage${sheet ? ' faded' : ''}` }, ringBox, hold.info, scanChip, waysChip, chip, held, hint);
  const main = el('main', { class: `screen home${sheet ? ' with-sheet' : ''}`, 'data-screen': 'home' }, bar.node, stage);
  // The sheet is a layer over the whole home (the talk button included), with the bottom row above it so
  // Close is always in view. A tap on the layer outside the card closes it, as Close does.
  if (sheet) main.append(el('div', { class: 'float-wrap', onclick: (e) => e.target === e.currentTarget && nav('home') }, sheet));
  main.append(bottomRow({ t, nav, open }));

  const update = () => {
    const v = state.view();
    bar.update();
    hold.update();
    const recording = v.talk.phase === 'recording';
    r.set(v.fundsFraction, v.memory.free, v.memory.low, v.freeFraction);
    ringBtn.setAttribute('aria-label', v.balanceText ? t('home.rings', { funds: v.balanceText, memory: v.memory.percentFree }) : t('home.ringsEmpty', { memory: v.memory.percentFree }));
    ringBox.classList.toggle('invite', !!v.scanNote);
    scanChip.hidden = !v.scanNote || recording;
    waysChip.hidden = !v.noFunds || recording;
    waysLabel.textContent = v.fundsBlock === 'freeOut' ? t('home.freeOut') : t('home.otherWays');
    chip.hidden = !v.memory.low || recording;
    held.hidden = !v.pendingCount || recording;
    held.textContent = v.pendingCount ? t('home.attached', { count: v.pendingCount }) : '';
  };
  update();
  return { node: main, update, destroy: hold.destroy, focus: sheet ? sheet.querySelector('button') : talk };
}
