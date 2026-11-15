// Prices shown before a request is sent, from the model's listed price per million tokens. Pure.
// Amounts are in msub: thousandths of the balance unit (cent or sat), as the engine counts them.

/**
 * A free model (GET /v1/models `pricing.free`): it costs nothing and nothing is held, but the engine
 * serves it only on a balance key (one opened with an invite code, even with nothing on it). Not the
 * free questions (credits, core/free.js), which are a balance of their own and work on other models.
 */
export const isFreeModel = (model) => model?.pricing?.free === true;

/** The free model Start free chooses when there is no free one in use: a fast one when it is listed. */
export const PREFERRED_FREE = 'glm-5.3-flash';

/** The free model to use: PREFERRED_FREE when listed, else the first free one, never an uncensored one; or null. */
export function freeModelChoice(models) {
  const free = (models ?? []).filter((m) => !m.uncensored && isFreeModel(m));
  return free.find((m) => m.id === PREFERRED_FREE) ?? free[0] ?? null;
}

/** Tokens a typical question is assumed to use, for "enough for about N questions" and the likely price. */
export const TYPICAL = { input: 1000, output: 400 };

/** msub per token for input and output, or null when the model has no price in this unit. */
export function perToken(model, unit) {
  const p = model?.pricing;
  if (!p) return null;
  if (isFreeModel(model)) return { in: 0, out: 0 };
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
 * `free` is set when the request is paid with a free question instead of the balance: true, or
 * {left, total} to say how many are left. The line then reads "Free" or "Free, 2 of 3 left". The free
 * questions themselves (credits) come with the free tier; until then no caller passes `free`.
 * A question to a free model (isFreeModel) passes `free: true` too: its line reads "Free".
 */
export function priceLine(costMsub, unit, free = null) {
  if (free) {
    const ok = (n) => Number.isInteger(n) && n >= 0;
    if (typeof free === 'object' && ok(free.left) && ok(free.total) && free.total > 0 && free.left <= free.total) return { key: 'price.freeLeft', amount: '', left: free.left, total: free.total };
    return { key: 'price.free', amount: '' };
  }
  if (costMsub == null) return { key: 'price.unknown', amount: '' };
  if (costMsub < 1000) return { key: 'price.under', amount: unit === 'sat' ? '1 sat' : '$0.01' };
  const whole = Math.ceil(costMsub / 1000);
  return { key: 'price.upTo', amount: unit === 'sat' ? `${whole.toLocaleString('en-US')} sat` : `$${(whole / 100).toFixed(2)}` };
}

/**
 * Bytes of an EHBP-encrypted body for a plaintext body of `bytes`: the vendored Tinfoil SDK seals the body
 * in chunks of up to 64 KiB, each framed as a 4-byte length plus the ciphertext with its 16-byte tag
 * (the SDK's own size estimate, public/vendor/tinfoil.js). The engine holds funds on the bytes it receives.
 */
export function ehbpBytes(bytes) {
  return bytes + Math.max(1, Math.ceil(bytes / 65536)) * 20;
}

/**
 * The funds hold for one question, in msub: exactly what the engine holds before it sends the question
 * on (src/pricing.ts holdNanoUsd), from the model's `pricing.hold` in GET /v1/models. bodyBytes is the
 * request body as the engine receives it (ehbpBytes of the JSON for a private model). null when the
 * model has no hold figures, or a sat price has no rate. search: the Search the web switch is on (null
 * when the model cannot search).
 */
export function holdMsub(model, unit, { bodyBytes, maxOut, btcUsd = null, search = false }) {
  // A free model holds nothing (src/pricing.ts holdNanoUsd), and cannot search.
  if (isFreeModel(model)) return search ? null : 0;
  const h = model?.pricing?.hold;
  if (!h) return null;
  let nano;
  if (h.basis === 'flat') {
    const b = h.buckets.find((x) => x.max_bytes >= bodyBytes) ?? h.buckets.at(-1);
    nano = b.nano_usd + maxOut * h.output_nano_usd_per_token;
  } else {
    // With Search the web on: the search allowance (more input, more output) and the search fee.
    const ws = search ? h.web_search : null;
    if (search && !ws) return null;
    const input = Math.ceil(bodyBytes / h.bytes_per_token) + (ws ? ws.extra_input_tokens : 0);
    const output = maxOut * (ws ? ws.output_factor : 1);
    nano = input * h.input_nano_usd_per_token + output * h.output_nano_usd_per_token + (ws ? ws.nano_usd : 0);
  }
  let msub;
  if (nano <= 0) msub = 0;
  else if (unit === 'usd') msub = Math.ceil(nano / 10_000);
  else if (!(btcUsd > 0)) return null;
  else msub = Math.ceil((nano * 100) / btcUsd);
  return Math.max(1, msub);
}
