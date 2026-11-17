// The cover (docs/PLAYFUL.md, The cover game; the design's KidsCover): with "Open as a game first" on,
// Playful opens on a game, Pip's Garden, and the helper is behind it. Hold Pip three seconds and the
// helper opens; nothing on the screen fills, counts or hints while Pip is held. A short tap makes Pip say a
// game line. With the keyboard, Enter or Space held three seconds on Pip does the same. A screen reader's
// activation cannot hold: its first makes Pip say a line, and a second within six seconds opens the
// helper, the two-step Burn uses (screens/burn.js holdToBurn).
// While the game shows, the page's title and icon are the game's, the phone's bar is the Playful ground,
// and the app's short messages (ui.toast) wait until the game goes, so none gives the app away.
// The game itself is a folder under games/ with a small interface (games/garden/index.js mount): it gets
// the string table, the element helper, Pip, and its own record on the phone, and nothing of the app.
import { el, reduced } from '../../../core/ui.js';
import * as garden from './games/garden/index.js';
import { playfulBar } from './parts.js';
import { pip } from './pip.js';

/** How long Pip is held to open the helper, in ms. */
export const HOLD_MS = 3000;
/** A screen reader's second activation of Pip within this long opens the helper. */
const AGAIN_MS = 6000;
/** The game the cover shows. Another game is a folder in games/ named here (docs/PLAYFUL.md). */
export const GAME = garden;

/**
 * Hold `btn` for `ms` and onHold() runs; let go sooner and onTap() runs. The same presses as Burn's
 * hold (pointer, Enter or Space, and a screen reader's two activations), with nothing drawn while it is
 * held. Returns {destroy()}.
 */
export function holdPip(btn, { ms = HOLD_MS, onTap, onHold }) {
  let timer = 0;
  let armedAt = 0;
  const holding = () => timer !== 0;
  const start = () => {
    if (holding()) return;
    armedAt = 0;
    timer = setTimeout(() => {
      timer = 0;
      onHold();
    }, ms);
  };
  const stop = () => {
    clearTimeout(timer);
    timer = 0;
  };
  const release = () => {
    if (!holding()) return;
    stop();
    onTap();
  };
  const off = new AbortController();
  const on = (target, type, fn) => target.addEventListener(type, fn, { signal: off.signal });
  on(btn, 'pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    btn.setPointerCapture?.(e.pointerId);
    start();
  });
  on(btn, 'pointerup', release);
  on(btn, 'pointercancel', stop);
  on(btn, 'lostpointercapture', release);
  const onKey = (e) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) {
      e.preventDefault();
      if (e.type === 'keydown') start();
      else release();
    }
  };
  on(btn, 'keydown', onKey);
  on(btn, 'keyup', onKey);
  // Focus taken away while Space or Enter is held: its keyup goes elsewhere, so the hold ends here.
  on(btn, 'blur', stop);
  // A click with no press before it is a screen reader's activation, which cannot hold.
  on(btn, 'click', (e) => {
    if (e.detail !== 0 || holding()) return;
    const now = performance.now();
    if (armedAt && now - armedAt < AGAIN_MS) {
      armedAt = 0;
      onHold();
      return;
    }
    armedAt = now;
    onTap();
  });
  on(btn, 'contextmenu', (e) => e.preventDefault());
  // The phone put the app away while Pip was held: no hold carries on into the background.
  on(document, 'visibilitychange', () => document.visibilityState === 'hidden' && stop());
  return {
    destroy() {
      off.abort();
      stop();
    },
  };
}

/**
 * Holds the app's short messages while the game shows, and sends them on when it goes (to the helper,
 * where Pip says them). hideToast() drops what is held: the wait it said is over. Returns release().
 */
function holdToasts(ui) {
  const held = [];
  ui.catchToasts?.((text, ms) => {
    if (text == null) held.length = 0;
    else held.push([text, ms]);
    return true;
  });
  return () => {
    ui.catchToasts?.(null);
    const out = held.splice(0);
    // After the next screen is drawn, so the helper's Pip is the one that says them.
    if (out.length) setTimeout(() => out.forEach(([text, ms]) => ui.toast(text, ms)), 0);
  };
}

/** The page dressed as the game: its title, its icon and the Playful bar colour. Returns the undo. */
function dress(name, href, appName) {
  document.title = name;
  // The app's own icon, kept on the link (index.html may have put the game's in its place already).
  const link = document.querySelector('link[rel="icon"]');
  if (link) link.dataset.appIcon ??= link.getAttribute('href') ?? '';
  link?.setAttribute('href', href);
  const unbar = playfulBar();
  return () => {
    document.title = appName;
    if (link?.dataset.appIcon) link.setAttribute('href', link.dataset.appIcon);
    unbar();
  };
}

/** The cover screen: the game, with Pip's hold as the way to the helper (the home). */
export function cover({ t, ui, nav, actions }) {
  const face = pip({ size: 56 });
  const btn = el('button', { type: 'button', class: 'gd-pip', id: 'pipBtn', 'aria-label': t('garden.pip') }, face.node);
  const main = el('main', { class: 'screen pf pf-cover', 'data-screen': 'game', 'data-mode': 'playful' });
  const game = GAME.mount(main, {
    t,
    el,
    reduced,
    pip: { node: btn, set: face.set },
    progress: { load: () => actions.coverProgress(), save: (data) => actions.saveCoverProgress(data) },
  });
  const hold = holdPip(btn, {
    onTap: () => game.tap(),
    onHold: () => {
      game.held();
      nav('home');
    },
  });
  const release = holdToasts(ui);
  const undress = dress(t(GAME.title), GAME.icon, t('app.name'));
  return {
    node: main,
    destroy: () => {
      hold.destroy();
      game.destroy();
      release();
      undress();
    },
  };
}
