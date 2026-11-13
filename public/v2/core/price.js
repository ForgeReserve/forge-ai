// Prices shown before a request is sent, from the model's listed price per million tokens. Pure.
// Amounts are in msub: thousandths of the balance unit (cent or sat), as the engine counts them.

/** Tokens a typical question is assumed to use, for "enough for about N questions" and the likely price. */
export const TYPICAL = { input: 1000, output: 400 };

/** msub per token for input and output, or null when the model has no price in this unit. */
export function perToken(model, unit) {
  const p = model?.pricing;
  if (!p) return null;
  if (unit === 'sat') return p.sat_per_mtok ? { in: p.sat_per_mtok.input / 1000, out: p.sat_per_mtok.output / 1000 } : null;
  if (!p.usd_per_mtok) return null;
  return { in: p.usd_per_mtok.input / 10, out: p.usd_per_mtok.output / 10 };
}

/** Cost of a request: `max` if the whole output limit is used, `likely` for a typical answer length. */
export function estimate(model, unit, inputTokens, maxOut) {
  const p = perToken(model, unit);
  if (!p) return null;
  const likelyOut = Math.min(maxOut, TYPICAL.output);
  return { max: Math.ceil(inputTokens * p.in + maxOut * p.out), likely: Math.ceil(inputTokens * p.in + likelyOut * p.out) };
}

/** msub for one typical question on this model. */
export function perQuestion(model, unit) {
  const p = perToken(model, unit);
  return p ? Math.ceil(TYPICAL.input * p.in + TYPICAL.output * p.out) : null;
}

/**
 * The price line: {key, amount} for the string table. Under one cent (or one sat) reads "Under $0.01";
 * otherwise the most it can cost, rounded up to a whole cent or sat.
 */
export function priceLine(costMsub, unit) {
  if (costMsub == null) return { key: 'price.unknown', amount: '' };
  if (costMsub < 1000) return { key: 'price.under', amount: unit === 'sat' ? '1 sat' : '$0.01' };
  const whole = Math.ceil(costMsub / 1000);
  return { key: 'price.upTo', amount: unit === 'sat' ? `${whole.toLocaleString('en-US')} sat` : `$${(whole / 100).toFixed(2)}` };
}
