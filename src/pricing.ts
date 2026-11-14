import type { FlatPricing, ModelConfig, Unit } from './config.ts';

/**
 * Money is tracked in "msub": one thousandth of the unit's smallest denomination.
 * usd: 1 cent = 1000 msub (milli-cents). sat: 1 sat = 1000 msub (msat).
 * Upstream prices are USD per million tokens. Internally we work in nano-USD (1e-9 USD),
 * so a price of $X per million tokens is X * 1000 nano-USD per token.
 */
export const MSUB_PER_UNIT = 1000;

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** What the supplier says this request cost us, in USD, when it reports it. */
  costUsd?: number;
}

/** Sale price per token in nano-USD, after markup. Rounded up so we never undercharge. */
export function nanoUsdPerToken(usdPerMtok: number, markup: number): number {
  return Math.ceil(usdPerMtok * markup * 1000 - 1e-9);
}

export function costNanoUsd(model: Pick<ModelConfig, 'input_usd_per_mtok' | 'output_usd_per_mtok'>, usage: Usage, markup: number): number {
  return (
    usage.inputTokens * nanoUsdPerToken(model.input_usd_per_mtok, markup) +
    usage.outputTokens * nanoUsdPerToken(model.output_usd_per_mtok, markup)
  );
}

export function flatCostNanoUsd(flat: FlatPricing, bodyBytes: number, maxOutputTokens: number, markup: number): number {
  const bucket = flat.buckets.find((b) => b.maxBytes >= bodyBytes) ?? flat.buckets[flat.buckets.length - 1]!;
  const base = Math.ceil(bucket.usd * markup * 1e9);
  return base + maxOutputTokens * nanoUsdPerToken(flat.output_usd_per_mtok, markup);
}

/**
 * The funds hold of a chat request in nano-USD: the most it can be charged.
 * - pricing "flat": the flat schedule (request-size bucket plus declared max output at its output price).
 * - pricing "metered": the model's own metered worst case, the input estimated from the body
 *   (bytes / bytesPerToken, rounded up) plus maxOut, at the model's prices with markup. A flat schedule on
 *   a metered supplier does not drive the hold (owner decision, 2026-11-14).
 * The app computes the same figure from GET /v1/models (`pricing.hold`, public/v2/core/price.js holdMsub).
 */
export function holdNanoUsd(
  supplier: { pricing: 'metered' | 'flat'; flat?: FlatPricing },
  model: Pick<ModelConfig, 'input_usd_per_mtok' | 'output_usd_per_mtok'>,
  bodyBytes: number,
  maxOut: number,
  markup: number,
  bytesPerToken: number,
): number {
  if (supplier.pricing === 'flat') return flatCostNanoUsd(supplier.flat!, bodyBytes, maxOut, markup);
  return costNanoUsd(model, worstUsage(bodyBytes, maxOut, bytesPerToken), markup);
}

/**
 * The hold figures GET /v1/models lists under `pricing.hold`, so a client computes the same hold exactly
 * (public/v2/core/price.js holdMsub). Integers in nano-USD, markup applied, rounded as the gateway rounds.
 */
export function holdInfo(
  supplier: { pricing: 'metered' | 'flat'; flat?: FlatPricing },
  model: Pick<ModelConfig, 'input_usd_per_mtok' | 'output_usd_per_mtok'>,
  markup: number,
  bytesPerToken: number,
) {
  if (supplier.pricing === 'flat') {
    return {
      basis: 'flat' as const,
      buckets: supplier.flat!.buckets.map((b) => ({ max_bytes: b.maxBytes, nano_usd: Math.ceil(b.usd * markup * 1e9) })),
      output_nano_usd_per_token: nanoUsdPerToken(supplier.flat!.output_usd_per_mtok, markup),
    };
  }
  return {
    basis: 'metered' as const,
    bytes_per_token: bytesPerToken,
    input_nano_usd_per_token: nanoUsdPerToken(model.input_usd_per_mtok, markup),
    output_nano_usd_per_token: nanoUsdPerToken(model.output_usd_per_mtok, markup),
  };
}

/** The usage a metered hold assumes: the whole body as input at bytesPerToken, and the whole output limit. */
export function worstUsage(bodyBytes: number, maxOut: number, bytesPerToken: number): Usage {
  return { inputTokens: estimateTokensFromBytes(bodyBytes, bytesPerToken), outputTokens: maxOut };
}

/**
 * Converts nano-USD to msub of the given unit, rounding up.
 * usd: 1 msub = 1e-5 USD = 10_000 nano-USD.
 * sat: 1 msub = 1 msat = 1e-11 BTC; nanoUsd / 1e9 / rate * 1e11 = nanoUsd * 100 / rate.
 */
export function nanoUsdToMsub(nanoUsd: number, unit: Unit, btcUsd?: number): number {
  if (nanoUsd <= 0) return 0;
  if (unit === 'usd') return Math.ceil(nanoUsd / 10_000);
  if (!btcUsd || !(btcUsd > 0)) throw new Error('BTC/USD rate unavailable');
  return Math.ceil((nanoUsd * 100) / btcUsd);
}

/** Whole units needed to cover an msub amount (round up). */
export function msubToUnitsCeil(msub: number): number {
  return Math.ceil(msub / MSUB_PER_UNIT);
}

export function formatMsub(msub: number, unit: Unit): string {
  const units = msub / MSUB_PER_UNIT;
  return unit === 'usd' ? `${(units / 100).toFixed(5)} USD` : `${units.toFixed(3)} sat`;
}

/** Per-million-token price in the requested unit, for display. */
export function displayPrice(usdPerMtok: number, markup: number, unit: Unit, btcUsd?: number): number | null {
  const usd = usdPerMtok * markup;
  if (unit === 'usd') return usd;
  if (!btcUsd) return null;
  return (usd / btcUsd) * 1e8;
}

/** Conservative token estimate for reservation: bytes / bytesPerToken, rounded up. */
export function estimateTokensFromBytes(bytes: number, bytesPerToken: number): number {
  return Math.ceil(bytes / bytesPerToken);
}

/** What one audio request is measured by: seconds of audio in (transcription) or characters of text (speech). */
export interface AudioUsage {
  seconds?: number;
  chars?: number;
}

/**
 * Price of one audio request in nano-USD: the per-request cost, plus per second of audio or per 1,000
 * characters, times the markup. Rounded up so we never undercharge. Markup 1 gives our own cost.
 */
export function audioCostNanoUsd(
  model: { request_usd: number; usd_per_second: number; usd_per_kchar: number },
  usage: AudioUsage,
  markup: number,
): number {
  const usd = model.request_usd + (usage.seconds ?? 0) * model.usd_per_second + ((usage.chars ?? 0) / 1000) * model.usd_per_kchar;
  return Math.ceil(usd * markup * 1e9 - 1e-6);
}
