import { describe, expect, it } from 'vitest';
import { costNanoUsd, displayPrice, estimateTokensFromBytes, flatCostNanoUsd, holdInfo, holdNanoUsd, msubToUnitsCeil, nanoUsdPerToken, nanoUsdToMsub } from '../../src/pricing.ts';

const model = { input_usd_per_mtok: 0.6, output_usd_per_mtok: 1.45 };

describe('pricing', () => {
  it('converts USD per million tokens to nano-USD per token', () => {
    expect(nanoUsdPerToken(1, 1)).toBe(1000);
    expect(nanoUsdPerToken(0.15, 1)).toBe(150);
    expect(nanoUsdPerToken(1.45, 1.25)).toBe(1813); // 1812.5 rounded up
  });

  it('computes request cost', () => {
    expect(costNanoUsd(model, { inputTokens: 1000, outputTokens: 500 }, 1)).toBe(1000 * 600 + 500 * 1450);
  });

  it('converts to milli-cents and msat, rounding up', () => {
    expect(nanoUsdToMsub(10_000, 'usd')).toBe(1); // 1 milli-cent
    expect(nanoUsdToMsub(10_001, 'usd')).toBe(2);
    expect(nanoUsdToMsub(0, 'usd')).toBe(0);
    // $1 at $100k/BTC = 1000 sat = 1_000_000 msat
    expect(nanoUsdToMsub(1e9, 'sat', 100_000)).toBe(1_000_000);
    expect(() => nanoUsdToMsub(1, 'sat')).toThrow();
  });

  it('accumulates sub-unit charges without loss', () => {
    // 100 tiny requests of 0.3 milli-cents each = 30 milli-cents, not 100 cents
    const per = nanoUsdToMsub(costNanoUsd({ input_usd_per_mtok: 0.15, output_usd_per_mtok: 0 }, { inputTokens: 20, outputTokens: 0 }, 1), 'usd');
    expect(per).toBe(1);
    expect(msubToUnitsCeil(per * 100)).toBe(1);
  });

  it('flat pricing picks the size bucket plus declared output', () => {
    const flat = { buckets: [{ maxBytes: 100, usd: 0.01 }, { maxBytes: 1000, usd: 0.02 }], output_usd_per_mtok: 10 };
    expect(flatCostNanoUsd(flat, 50, 0, 1)).toBe(1e7);
    expect(flatCostNanoUsd(flat, 500, 100, 1)).toBe(2e7 + 100 * 10_000);
    expect(flatCostNanoUsd(flat, 5000, 0, 1)).toBe(2e7); // larger than last bucket: last bucket
  });

  it('display prices and estimates', () => {
    expect(displayPrice(2, 1.5, 'usd')).toBe(3);
    expect(displayPrice(100, 1, 'sat', 100_000)).toBe(100_000);
    expect(displayPrice(1, 1, 'sat')).toBeNull();
    expect(estimateTokensFromBytes(101, 2)).toBe(51);
  });
});

const CLIENT: any = await import('../../public/v2/core/price.js' as string);

describe('the funds hold (owner decision, 2026-11-14)', () => {
  // The production Tinfoil supplier: metered, with the flat schedule that used to drive the hold.
  const tinfoil = {
    pricing: 'metered' as const,
    flat: { buckets: [{ maxBytes: 8192, usd: 0.002 }, { maxBytes: 65536, usd: 0.01 }, { maxBytes: 1000000, usd: 0.05 }], output_usd_per_mtok: 20 },
  };
  const gptOss = { input_usd_per_mtok: 0.15, output_usd_per_mtok: 0.6 };

  it('a metered supplier holds the metered worst case; its flat schedule does not drive the hold', () => {
    const hold = holdNanoUsd(tinfoil, gptOss, 1000, 4096, 1.25, 2);
    expect(hold).toBe(costNanoUsd(gptOss, { inputTokens: 500, outputTokens: 4096 }, 1.25));
    expect(hold).toBeLessThan(flatCostNanoUsd(tinfoil.flat, 1000, 4096, 1.25));
  });

  it('a flat supplier still holds its schedule', () => {
    const flat = { pricing: 'flat' as const, flat: tinfoil.flat };
    expect(holdNanoUsd(flat, gptOss, 1000, 4096, 1.25, 2)).toBe(flatCostNanoUsd(tinfoil.flat, 1000, 4096, 1.25));
  });

  it("the app's hold (from /v1/models) equals the gateway's to the msub, in usd and sat", () => {
    const models = [gptOss, { input_usd_per_mtok: 4, output_usd_per_mtok: 20 }, { input_usd_per_mtok: 1.8, output_usd_per_mtok: 5.75 }, { input_usd_per_mtok: 0.6, output_usd_per_mtok: 1.45 }];
    const suppliers = [tinfoil, { pricing: 'flat' as const, flat: tinfoil.flat }];
    for (const markup of [1, 1.25, 1.37]) {
      for (const bpt of [2, 3.5]) {
        for (const s of suppliers) {
          for (const m of models) {
            const info = { pricing: { hold: JSON.parse(JSON.stringify(holdInfo(s, m, markup, bpt))) } };
            for (const bytes of [1, 333, 8192, 8193, 70_001, 999_999]) {
              for (const maxOut of [1, 777, 4096, 8192]) {
                const nano = holdNanoUsd(s, m, bytes, maxOut, markup, bpt);
                expect(CLIENT.holdMsub(info, 'usd', { bodyBytes: bytes, maxOut })).toBe(Math.max(1, nanoUsdToMsub(nano, 'usd')));
                for (const rate of [100_000, 64_321.17]) {
                  expect(CLIENT.holdMsub(info, 'sat', { bodyBytes: bytes, maxOut, btcUsd: rate })).toBe(Math.max(1, nanoUsdToMsub(nano, 'sat', rate)));
                }
              }
            }
          }
        }
      }
    }
  });

  it('an encrypted body is the plaintext plus 20 bytes for each 64 KiB chunk', () => {
    expect(CLIENT.ehbpBytes(0)).toBe(20);
    expect(CLIENT.ehbpBytes(100)).toBe(120);
    expect(CLIENT.ehbpBytes(65536)).toBe(65556);
    expect(CLIENT.ehbpBytes(65537)).toBe(65577);
  });
});
