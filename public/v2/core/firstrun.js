// The first run: Welcome, How you pay, What it can and cannot hide, Private only, then the home. Shown
// once on a phone that has not seen it (skipped or finished both count), and always reachable again
// from More. Pure rules, tested in Node; the screens are in screens/firstrun.js.

/** The steps, in order. */
export const STEPS = ['welcome', 'pay', 'limits', 'private'];

/** The route of each step (core/router.js). */
export const STEP_ROUTES = { welcome: 'intro', pay: 'introPay', limits: 'introLimits', private: 'introPrivate' };

/** The step a route shows, or null when the route is not a first run step. */
export const stepOfRoute = (name) => Object.keys(STEP_ROUTES).find((k) => STEP_ROUTES[k] === name) ?? null;

/** Where the app remembers that the first run was seen. Erase everything removes it with the rest. */
export const SEEN_KEY = 'forge2.firstRun';
export const SEEN_VALUE = 'done';

/**
 * What Listen reads on each step: its heading and its one sentence, the same words on every phone. The
 * recorded clips (public/v2/voice/en/, scripts/record-voice) are made from exactly these strings.
 */
export const SPOKEN = {
  welcome: ['intro.welcome.title', 'intro.welcome.lead'],
  pay: ['intro.pay.title', 'intro.pay.lead'],
  limits: ['intro.limits.title', 'intro.limits.lead'],
  private: ['intro.private.title', 'intro.private.lead'],
};

/** The step for an id: an unknown one is the first step. */
export const stepOf = (id) => (STEPS.includes(id) ? id : STEPS[0]);

/** 1-based number of a step, for "Step 2 of 4". */
export const stepNumber = (id) => STEPS.indexOf(stepOf(id)) + 1;

/** The step after this one, or null on the last step (which leads to the home). */
export function nextStep(id) {
  const i = STEPS.indexOf(stepOf(id));
  return i < STEPS.length - 1 ? STEPS[i + 1] : null;
}

/** The step before this one, or null on the first step. */
export function prevStep(id) {
  const i = STEPS.indexOf(stepOf(id));
  return i > 0 ? STEPS[i - 1] : null;
}

/**
 * Whether the app opens on the first run instead of the screen the address names. Only a plain open on
 * the home does: a photo shared in from another app, or an address that names a screen, opens that
 * screen, so the first run never stands between a person and what they came to do.
 */
export const shouldShow = ({ seen, route }) => !seen && route === 'home';

/**
 * The ways to pay that How you pay shows, as icons, in this order. A way is shown only when a fund
 * module for it is loaded and usable on this engine, so the screen never promises what is not there.
 * `card` shows only where a card can be read (the Android app): its module says usable() false on
 * the website.
 */
export const PAY_WAYS = [
  { id: 'note', icon: 'qr', key: 'intro.pay.note' },
  { id: 'free', icon: 'gift', key: 'intro.pay.free' },
  { id: 'card', icon: 'card', key: 'intro.pay.card' },
  { id: 'lightning', icon: 'bolt', key: 'intro.pay.lightning' },
];

/** The ways to show, given the ids of the fund modules usable here. */
export function payWays(available) {
  const ids = new Set(available);
  return PAY_WAYS.filter((w) => ids.has(w.id));
}
