// An event pass (docs/ANDROID.md, Event links): the one QR code on an event's slide reads /j#<pass>. The
// /j page sends the website to /v2/#join=<pass>; the Android app hands over the pass from the link it was
// opened with (ForgeJoin, JoinRules.kt, which takes the same shape). Either way the web app opens a free
// balance with it (app.js joinWith). Pure, tested in Node.

/** What a pass looks like: the letters base64url uses, as `pnpm admin passes:create` makes them. */
const PASS = /^[A-Za-z0-9_-]{8,128}$/;

/** The pass in a fragment ('#pass-...', or '#join=pass-...' as the web app takes it), or null. */
export function passFrom(hash) {
  const raw = String(hash ?? '')
    .replace(/^#/, '')
    .replace(/^join=/, '');
  let v;
  try {
    v = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return PASS.test(v) ? v : null;
}

/** Whether the web app's address carries an event pass (#join=...), valid or not: it is removed either way. */
export const isJoinHash = (hash) => /^#join=/.test(String(hash ?? ''));

/** The web app's address for a pass: it opens a free balance with it. */
export const webJoin = (pass) => `/v2/#join=${pass}`;

/**
 * What the app does with a pass: 'open' a free balance with it, or 'keep' what it has. A phone that
 * already holds a balance key keeps it: the pass is not spent, and nothing is replaced.
 */
export const joinPlan = ({ pass, hasKey }) => (!pass ? 'none' : hasKey ? 'keep' : 'open');
