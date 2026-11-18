// Two balances on the phone (docs/PAYMENTS.md, Two balances): one in dollars and one in sats, each with
// its own balance key, as the engine keeps a balance in one unit for life. Money goes to the balance of
// its own unit, a question is paid in full from one of them (dollars first), and the home shows one
// total. Pure, tested in Node.

/** The order the balances pay in, and are shown in: dollars first. */
export const UNITS = Object.freeze(['usd', 'sat']);
export const OTHER = Object.freeze({ usd: 'sat', sat: 'usd' });

/**
 * Where the second balance key is stored. The first stays where it always was (core/state.js keyName,
 * the Classic page's own name), so a key kept before two balances is never moved or rewritten: each
 * name holds one key, whatever its unit, and the engine says which unit it is.
 */
export const KEY2_STORE = 'forge2.balanceKey2';
export const key2Name = (base, origin) => (!base || base === origin ? KEY2_STORE : `${KEY2_STORE}@${base}`);

/**
 * The two key names as a list, after a new key: it goes into the first empty one, and a key already
 * kept stays where it is. Returns null when both hold another key (nothing is ever written over).
 */
export function withKey(slots, key) {
  if (!key || slots.includes(key)) return slots;
  const i = slots.findIndex((k) => !k);
  if (i < 0) return null;
  const next = [...slots];
  next[i] = key;
  return next;
}

/** The two key names without one key (the engine no longer knows it), the other left where it is. */
export const withoutKey = (slots, key) => slots.map((k) => (k === key ? null : k));

/**
 * Which key is which: each key's unit as the engine said it (units, key to unit), first come first, so a
 * second key in a unit already held is left aside (kept and never used). Returns {usd, sat}, a key or null.
 */
export function keysByUnit(slots, units) {
  const out = { usd: null, sat: null };
  for (const k of slots) {
    const u = k ? units[k] : null;
    if (u in out && !out[u]) out[u] = k;
  }
  return out;
}

/** True while a kept key's unit is not known yet: the engine has not answered for it. */
export const unitsPending = (slots, units) => slots.some((k) => k && !units[k]);

/**
 * msub of a sat balance (millisatoshi) in usd msub (thousandths of a cent), at btcUsd dollars per
 * bitcoin, rounded down so the total is never more than the balances hold. null without a rate.
 */
export function satToUsdMsub(satMsub, btcUsd) {
  if (!(btcUsd > 0) || !Number.isFinite(satMsub)) return null;
  return Math.floor((satMsub * btcUsd) / 1e6);
}

/**
 * The balance that pays a question: dollars first; sats when the dollars cannot cover the question's
 * hold. A question is paid in full from one balance, never split, so when neither covers it alone the
 * answer is null (the question is short), even when the two together would. A sat hold is null when
 * there is no BTC/USD rate, and a sat balance cannot pay then.
 *   available: {usd, sat}, the funds not held already, null for a balance the phone does not have.
 *   hold: {usd, sat}, the question's hold in each unit (0 for a free model), null when unpriced.
 */
export function payUnit({ available, hold }) {
  for (const u of UNITS) {
    const a = available[u];
    const h = hold[u];
    if (a != null && h != null && a >= h) return u;
  }
  return null;
}

/**
 * The home's one total and its unit. With money in one balance only, it is that balance in its own
 * unit. With money in both, it is dollars: the sats at the BTC/USD rate the app has, or, with no rate,
 * the dollar balance alone (Funds still shows the sats). With no money, the empty balance kept first.
 *   usd, sat: {balanceMsub, peakMsub} for a balance the phone has, else null.
 * Returns {unit, balanceMsub, peakMsub, both, approx}, or null with no balance at all: both when the
 * total counts the two balances, approx when it left the sats out for want of a rate.
 */
export function homeTotal({ usd, sat, btcUsd = null }) {
  const has = (b) => !!b && b.balanceMsub != null;
  const money = (b) => has(b) && b.balanceMsub > 0;
  const peak = (b) => (b.peakMsub != null && b.peakMsub > b.balanceMsub ? b.peakMsub : b.balanceMsub);
  if (money(usd) && money(sat)) {
    const s = satToUsdMsub(sat.balanceMsub, btcUsd);
    if (s == null) return { unit: 'usd', balanceMsub: usd.balanceMsub, peakMsub: peak(usd), both: false, approx: true };
    return { unit: 'usd', balanceMsub: usd.balanceMsub + s, peakMsub: peak(usd) + satToUsdMsub(peak(sat), btcUsd), both: true, approx: false };
  }
  for (const [unit, b] of [['usd', usd], ['sat', sat]]) if (money(b)) return { unit, balanceMsub: b.balanceMsub, peakMsub: peak(b), both: false, approx: false };
  for (const [unit, b] of [['usd', usd], ['sat', sat]]) if (has(b)) return { unit, balanceMsub: b.balanceMsub, peakMsub: b.peakMsub ?? null, both: false, approx: false };
  return null;
}

/**
 * The unit money in `unit` is added to. Its own balance when the phone has one; when it has none, a new
 * balance in that unit: the first one needs an invite while the engine is invite-only, a second one is
 * opened with the first one's key (siblings: the engine offers that, methods.sibling). Only on an engine
 * that does not, the balance the phone has, where the engine changes units (the price is shown first).
 *   held: {usd, sat}, whether the phone has a balance in each unit.
 */
export function landsIn(unit, { held, siblings = false, inviteOnly = true }) {
  const other = OTHER[unit];
  if (!other || held[unit] || !held[other]) return unit;
  return siblings || !inviteOnly ? unit : other;
}

/**
 * The questions a typical question's price leaves, counted over both balances: each balance pays whole
 * questions on its own. perQuestion: {usd, sat} in msub, null when unpriced; a sat balance counts only
 * with a rate (rateOk).
 */
export function questionsOver({ usd, sat }, perQuestion, rateOk) {
  let n = 0;
  for (const [u, b] of [['usd', usd], ['sat', sat]]) {
    const p = perQuestion[u];
    if (!(b > 0) || !(p > 0) || (u === 'sat' && !rateOk)) continue;
    n += Math.floor(b / p);
  }
  return n;
}
