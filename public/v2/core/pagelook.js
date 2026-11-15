// The look of the website's own pages (/free and /download): the look this phone keeps from the app
// (app.js LOOK_CACHE), else Midnight, the app's default look. A light look kept from before Midnight
// became the default (no `look` in it) is not used, as in the app (core/state.js loadedSettings).
import { tokens as midnight } from '../modules/look/midnight/index.js';

/** The tokens and scheme to use, from what the app kept under 'forge2.look' (a JSON string or null). */
export function pageLook(kept) {
  try {
    const c = JSON.parse(kept ?? 'null');
    if (c?.tokens && (c.look || c.scheme === 'dark')) {
      // Only the tokens a look has, and only as plain strings.
      const tokens = Object.fromEntries(Object.keys(midnight).map((k) => [k, typeof c.tokens[k] === 'string' ? c.tokens[k] : midnight[k]]));
      return { tokens, scheme: c.scheme === 'light' ? 'light' : 'dark' };
    }
  } catch {
    /* nothing kept, or not readable */
  }
  return { tokens: midnight, scheme: 'dark' };
}

/** Applies that look to the page: its tokens, its colour scheme and the browser's bar colour. */
export function applyPageLook(doc = globalThis.document) {
  let kept = null;
  try {
    kept = localStorage.getItem('forge2.look');
  } catch {
    /* no storage */
  }
  const { tokens, scheme } = pageLook(kept);
  const root = doc.documentElement;
  for (const [k, v] of Object.entries(tokens)) root.style.setProperty(`--${k}`, v);
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
  doc.querySelector('meta[name="theme-color"]')?.setAttribute('content', tokens.bg);
}
