// Ring maths for the home and the Funds and memory screen. Pure, tested in Node.
// Gold (outer) is funds: the fill is the balance as a share of the balance right after the last time
// money came in (the "peak"), so a full ring means "as much as you added" and it shrinks as questions
// are paid. Green (inner) is memory: the fill is how much of the model's context is still free.

// The home and answer rings are as thin as the first run's (owner, 2026-11-15): there a 10 wide stroke on
// a 236 wide ring, so the stroke is 0.0424 of the outer ring's diameter. Radii are the design's.
export const GEOMETRY = {
  home: { box: 336, outer: { r: 150, w: 12.7 }, inner: { r: 121, w: 12.7 }, button: 204 },
  answer: { box: 200, outer: { r: 87.5, w: 7.4 }, inner: { r: 69.5, w: 7.4 }, button: 112 },
  card: { box: 92, r: 37, w: 16 },
};

/** Context assumed when the engine does not say how much a model can hold. */
export const DEFAULT_CONTEXT = 32_768;
/** Memory below this share free turns the ring orange and shows the clear chip. */
export const LOW_MEMORY = 0.2;

export const clamp01 = (x) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);

export const circumference = (r) => 2 * Math.PI * r;

/** SVG stroke-dasharray for a ring filled to `fraction`, starting at 12 o'clock. */
export function dash(fraction, r) {
  const c = circumference(r);
  const len = clamp01(fraction) * c;
  return { length: len, circumference: c, dasharray: `${Math.round(len)} ${Math.round(c)}` };
}

/** The new peak after a balance reading: it rises with the balance and never falls on its own. */
export function nextPeak(peakMsub, balanceMsub) {
  if (balanceMsub == null || !Number.isFinite(balanceMsub)) return peakMsub ?? null;
  return peakMsub == null || balanceMsub > peakMsub ? balanceMsub : peakMsub;
}

/** Share of the gold ring to fill. */
export function fundsFraction(balanceMsub, peakMsub) {
  if (!balanceMsub || balanceMsub <= 0) return 0;
  if (!peakMsub || peakMsub <= balanceMsub) return 1;
  return balanceMsub / peakMsub;
}

/** How much of the model's memory this conversation uses, and how much is free. */
export function memory(usedTokens, contextLength) {
  const ctx = contextLength && contextLength > 0 ? contextLength : DEFAULT_CONTEXT;
  const used = clamp01((usedTokens ?? 0) / ctx);
  const free = 1 - used;
  return { used, free, percentFree: Math.floor(free * 100 + 1e-9), low: free < LOW_MEMORY };
}

/** Rough number of typical questions a balance pays for, at a model's listed price (msub per question). */
export function questionsLeft(balanceMsub, perQuestionMsub) {
  if (!balanceMsub || balanceMsub <= 0 || !perQuestionMsub || perQuestionMsub <= 0) return 0;
  return Math.floor(balanceMsub / perQuestionMsub);
}

/**
 * The gold ring with free questions (docs/FREE-TIER.md): a lighter segment for free questions first,
 * then the paid balance after it. Both are measured in questions: free questions left out of those
 * added, and the paid balance in typical questions at the model's price. Without a price the two share
 * the ring half and half. Returns {free, paid}, shares of the ring that add up to at most 1.
 */
export function fundsSegments({ balanceMsub, peakMsub, freeLeft = 0, freeTotal = 0, perQuestionMsub = null }) {
  const paid = fundsFraction(balanceMsub, peakMsub);
  const left = Number.isFinite(freeLeft) && freeLeft > 0 ? freeLeft : 0;
  const total = Math.max(left, Number.isFinite(freeTotal) ? freeTotal : 0);
  if (!left) return { free: 0, paid };
  if (!(balanceMsub > 0)) return { free: clamp01(left / total), paid: 0 };
  if (!(perQuestionMsub > 0)) return { free: clamp01(left / total) / 2, paid: paid / 2 };
  const paidNow = balanceMsub / perQuestionMsub;
  const paidFull = Math.max(paidNow, (peakMsub ?? balanceMsub) / perQuestionMsub);
  const whole = total + paidFull;
  return { free: clamp01(left / whole), paid: clamp01(paidNow / whole) };
}

/** SVG dash for the paid part of the gold ring, drawn after the free part (which starts at 12 o'clock). */
export function dashAfter(fraction, offsetFraction, r) {
  const d = dash(fraction, r);
  return { ...d, dashoffset: String(-Math.round(clamp01(offsetFraction) * d.circumference)) };
}
