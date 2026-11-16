// Home: the two rings with the talk button, the status bar and the bottom row (ZHome1, ZHome2).
// Holding the talk button turns the home into Listening (XListenLight): see screens/talk.js.
// With no funds on a paid model, the gold ring breathes and one Add money button right under it opens
// the wallet cards (screens/wallet.js). On a free model at $0 the home says so instead: a small chip
// with the model's name and FREE, and Add money as a small icon button beside it (AddFunds-C4).
// Tapping the ring itself still opens Funds and memory.
// The Add and More sheets open over it (ZAdd, ZMore): the rings fade and a floating card sits above
// the bottom row, whose button turns dark and reads Close. The sheet covers the whole home, the talk
// button included, and the bottom row stays fixed in view, so Close never needs a scroll.
import { el, icon, say } from '../core/ui.js';
import { bottomRow, rings, searchSwitch, statusBar } from './parts.js';
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
  // No funds: Add money (the wallet cards). On a free model it is a small icon button beside the chip.
  const addWord = el('span', { text: t('home.addMoney') });
  const addMoney = el('button', { type: 'button', class: 'chip-add', id: 'addMoney', hidden: true, 'aria-label': t('home.addMoney'), onclick: () => nav('addFunds') }, icon('addMoney', 22), addWord);
  // The free model in use at $0: its name and FREE. Without a balance key it opens Start free, which
  // gives one; else Choose a model.
  const freeName = el('span', { class: 'chip-free-name', id: 'freeModelName' });
  const freeChip = el('button', { type: 'button', class: 'chip-free', id: 'freeModelChip', hidden: true, onclick: () => nav(state.view().fundsBlock === 'needKey' ? 'startFree' : 'model') }, icon('gift', 18), freeName, el('span', { class: 'chip-free-tag', text: t('home.free') }));
  // A paid model at $0 (a private one, say): which model is chosen still shows, with its lock, and opens
  // Choose a model (owner, 2026-11-15).
  const paidName = el('span', { class: 'chip-free-name', id: 'paidModelName' });
  const paidIco = el('span', { class: 'chip-model-ico' });
  const paidChip = el('button', { type: 'button', class: 'chip-model', id: 'modelChip', hidden: true, onclick: () => nav('model') }, paidIco, paidName);
  const empty = el('div', { class: 'home-empty', id: 'homeEmpty' }, freeChip, paidChip, addMoney);
  // Free questions used up: the ways forward (screens/free.js).
  const waysChip = el('button', { type: 'button', class: 'chip-ways', id: 'otherWays', hidden: true, onclick: () => nav('freeOut') }, icon('gift', 18), el('span', { text: t('home.freeOut') }));
  const held = el('p', { class: 'held-line', id: 'heldLine', hidden: true });
  // Search the web for the next question, asked by voice or typed (screens/parts.js).
  const search = searchSwitch({ t, state, actions, id: 'searchHome' });
  const ringBox = el('div', { class: 'rings home-rings' }, r.node, ringBtn, talk);
  const stage = el('div', { class: `stage${sheet ? ' faded' : ''}` }, ringBox, hold.info, empty, waysChip, search.node, chip, held, hint);
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
    // The ring breathes for money only on a paid model.
    ringBox.classList.toggle('invite', !!v.scanNote && !v.modelFree);
    const freeOut = v.fundsBlock === 'freeOut';
    const showEmpty = v.noFunds && !recording && !freeOut;
    waysChip.hidden = !v.noFunds || recording || !freeOut;
    freeChip.hidden = !(showEmpty && v.modelFree);
    freeName.textContent = v.model?.name ?? v.model?.id ?? '';
    freeChip.setAttribute('aria-label', t('home.freeChip', { name: freeName.textContent }));
    addMoney.hidden = !showEmpty;
    paidChip.hidden = !(showEmpty && !v.modelFree && v.model);
    if (!paidChip.hidden) {
      paidName.textContent = v.model.name ?? v.model.id;
      paidChip.dataset.kind = v.private ? 'private' : 'standard';
      paidIco.replaceChildren(icon(v.private ? 'lock' : 'unlock', 18));
      paidChip.setAttribute('aria-label', t('home.modelChip', { name: paidName.textContent }));
    }
    empty.classList.toggle('stacked', !paidChip.hidden);
    // Beside the free chip, Add money is its icon only.
    addMoney.classList.toggle('compact', !!v.modelFree);
    addWord.hidden = !!v.modelFree;
    chip.hidden = !v.memory.low || recording;
    held.hidden = !v.pendingCount || recording;
    search.update();
    // A search is paid from the balance (never a free question): with no funds the home keeps its empty state.
    if (recording || v.noFunds || v.fundsBlock) search.node.hidden = true;
    say(held, v.pendingCount ? t('home.attached', { count: v.pendingCount }) : '', '', 'file');
  };
  update();
  return { node: main, update, destroy: hold.destroy, focus: sheet ? sheet.querySelector('button') : talk };
}
