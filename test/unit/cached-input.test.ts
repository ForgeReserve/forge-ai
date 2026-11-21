// Cached input (docs/PAYMENTS.md, Cached input): input tokens the supplier served from its prompt cache are
// charged at the model's cached_input_usd_per_mtok, the rest of the input at the input price. The hold
// stays at the full input price. A missing or wrong cached count charges as before.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { supplierCosts } from '../../src/admin-api.ts';
import { CatalogSchema, loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { usageFromJson } from '../../src/meter.ts';
import { cachedInputTokens, costNanoUsd, holdInfo, holdNanoUsd, nanoUsdToMsub, type Usage, usageNanoUsd } from '../../src/pricing.ts';
import { parseUsageMetrics } from '../../src/suppliers/tinfoil.ts';

// DeepSeek V4.1 Flash on Tinfoil's rate card, 2026-11-20: 0.60 in, 0.01 cached in, 1.45 out per million.
const flash = { input_usd_per_mtok: 0.6, cached_input_usd_per_mtok: 0.01, output_usd_per_mtok: 1.45 };
const noCache = { input_usd_per_mtok: 0.6, output_usd_per_mtok: 1.45 };

describe('cached input: the charge', () => {
  it('with no cached tokens, charges exactly as before, whether or not the model has a cached price', () => {
    for (const markup of [1, 1.25]) {
      const before = 1000 * Math.ceil(0.6 * markup * 1000 - 1e-9) + 500 * Math.ceil(1.45 * markup * 1000 - 1e-9);
      for (const u of [{ inputTokens: 1000, outputTokens: 500 }, { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 }]) {
        expect(costNanoUsd(flash, u, markup)).toBe(before);
        expect(costNanoUsd(noCache, u, markup)).toBe(before);
      }
    }
  });

  it('charges cached tokens at the cached price and the rest at the input price', () => {
    // markup 1: 600 and 10 nano-USD per input token, 1450 per output token.
    expect(costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1)).toBe(200 * 600 + 800 * 10 + 500 * 1450);
    // all cached
    expect(costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 0 }, 1)).toBe(1000 * 10);
    // markup 1.25: 750, 12.5 rounded up to 13, and 1812.5 rounded up to 1813.
    expect(costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1.25)).toBe(200 * 750 + 800 * 13 + 500 * 1813);
  });

  it('a model with no cached price charges cached tokens at the input price', () => {
    expect(costNanoUsd(noCache, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1)).toBe(1000 * 600 + 500 * 1450);
  });

  it('bounds the cached count: a wrong or hostile figure never lowers the charge below the cached price, nor raises it above the full price', () => {
    const full = costNanoUsd(flash, { inputTokens: 1000, outputTokens: 500 }, 1);
    const allCached = costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 1000, outputTokens: 500 }, 1);
    for (const bad of [-1, -1e9, 0.5, 799.5, NaN, Infinity, -Infinity, Number.MAX_VALUE, '800', null, {}, true]) {
      const u = { inputTokens: 1000, outputTokens: 500, cachedInputTokens: bad as unknown as number };
      expect(cachedInputTokens(u), String(bad)).toBe(0);
      expect(costNanoUsd(flash, u, 1)).toBe(full);
    }
    // Above the input tokens: all of them, never more.
    for (const above of [1001, 5000, Number.MAX_SAFE_INTEGER]) {
      expect(cachedInputTokens({ inputTokens: 1000, cachedInputTokens: above })).toBe(1000);
      expect(costNanoUsd(flash, { inputTokens: 1000, outputTokens: 500, cachedInputTokens: above }, 1)).toBe(allCached);
    }
    expect(cachedInputTokens({ inputTokens: 0, cachedInputTokens: 10 })).toBe(0);
    expect(cachedInputTokens({ inputTokens: -5, cachedInputTokens: 10 })).toBe(0);
    expect(cachedInputTokens({ inputTokens: 10 })).toBe(0);
  });

  it('never charges more than without the cache, and never a negative amount', () => {
    for (const markup of [1, 1.1, 1.25, 2]) {
      for (const input of [0, 1, 7, 1000, 123_457]) {
        for (const cached of [0, 1, Math.floor(input / 3), input, input + 10, -3]) {
          const u: Usage = { inputTokens: input, cachedInputTokens: cached, outputTokens: 33 };
          const n = costNanoUsd(flash, u, markup);
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThanOrEqual(costNanoUsd(flash, { inputTokens: input, outputTokens: 33 }, markup));
          // Never below every input token at the cached price.
          expect(n).toBeGreaterThanOrEqual(costNanoUsd(flash, { inputTokens: input, cachedInputTokens: input, outputTokens: 33 }, markup));
        }
      }
    }
  });

  it('adds the search and auxiliary fees on top, as before', () => {
    const u = { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500, webSearchCalls: 2, otherCostUsd: 0.0002 };
    expect(usageNanoUsd(flash, u, 1, { request_usd: 0.05 })).toBe(200 * 600 + 800 * 10 + 500 * 1450 + 50_000_000 + 200_000);
  });

  it('converts to usd and sat msub, rounding up once', () => {
    const n = costNanoUsd(flash, { inputTokens: 1000, cachedInputTokens: 800, outputTokens: 500 }, 1); // 853,000 nano-USD
    expect(n).toBe(853_000);
    expect(nanoUsdToMsub(n, 'usd')).toBe(86); // 85.3 milli-cents, rounded up
    expect(nanoUsdToMsub(n, 'sat', 100_000)).toBe(853); // 853 msat at 100,000 USD per bitcoin
    expect(nanoUsdToMsub(n, 'sat', 65_008.12)).toBe(Math.ceil((853_000 * 100) / 65_008.12));
  });

  it('holds the full input price, with or without a cached price', () => {
    const supplier = { pricing: 'metered' as const };
    for (const markup of [1, 1.25]) {
      expect(holdNanoUsd(supplier, flash, 4000, 64, markup, 2)).toBe(holdNanoUsd(supplier, noCache, 4000, 64, markup, 2));
      expect(holdInfo(supplier, flash, markup, 2)).toEqual(holdInfo(supplier, noCache, markup, 2));
    }
  });
});

describe('cached input: what the supplier reports', () => {
  it('reads usage.prompt_tokens_details.cached_tokens (and input_tokens_details on the Responses API)', () => {
    expect(usageFromJson({ usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 800 } } })).toEqual({
      inputTokens: 1000,
      outputTokens: 20,
      cachedInputTokens: 800,
    });
    expect(usageFromJson({ usage: { input_tokens: 1000, output_tokens: 20, input_tokens_details: { cached_tokens: 64 } } })!.cachedInputTokens).toBe(64);
    // The final chunk of a stream has the same usage object.
    expect(usageFromJson({ choices: [], usage: { prompt_tokens: 69, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 64 } } })!.cachedInputTokens).toBe(64);
  });

  it('a missing or unreadable cached count is no cached tokens, never a failure', () => {
    for (const details of [undefined, null, {}, { cached_tokens: null }, { cached_tokens: '800' }, { cached_tokens: NaN }, 'x', 5]) {
      const u = usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: details } });
      expect(u).toEqual({ inputTokens: 10, outputTokens: 2 });
      expect(cachedInputTokens(u!)).toBe(0);
    }
    // A negative or oversized one is kept as sent and bounded where it is charged.
    expect(cachedInputTokens(usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: -4 } } })!)).toBe(0);
    expect(cachedInputTokens(usageFromJson({ usage: { prompt_tokens: 10, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 99 } } })!)).toBe(10);
  });

  it("reads cached_prompt_tokens from Tinfoil's usage metrics (header or trailer)", () => {
    // The shapes in Tinfoil's router tests (confidential-model-router manager/usage_writer_test.go).
    expect(parseUsageMetrics('prompt=69,completion=20,total=89,cached_prompt_tokens=64,uncached_prompt_tokens=5,model=kimi-k2-6')).toEqual({
      inputTokens: 69,
      outputTokens: 20,
      costUsd: undefined,
      cachedInputTokens: 64,
    });
    expect(parseUsageMetrics('prompt=100,completion=50,total=150,cached_prompt_tokens=40,uncached_prompt_tokens=60,model=priced-model,cost_usd=0.000045')).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      costUsd: 0.000045,
      cachedInputTokens: 40,
    });
    // Without caching, or with a value that is not a number: no cached tokens, the rest as before.
    expect(parseUsageMetrics('prompt=67,completion=42,total=109,model=gpt-oss-120b,cost_usd=0.000042')!.cachedInputTokens).toBeUndefined();
    expect(parseUsageMetrics('prompt=67,completion=42,cached_prompt_tokens=abc')).toEqual({ inputTokens: 67, outputTokens: 42, costUsd: undefined });
    expect(parseUsageMetrics('prompt=67,completion=42,cached_prompt_tokens=-1')!.cachedInputTokens).toBeUndefined();
  });
});

describe('cached input: the catalog', () => {
  const cat = (extra: object, pricing: object = {}) => ({
    suppliers: { s: { type: 'mock', tier: 'standard' } },
    models: [{ id: 'x', supplier: 's', upstream: 'x', input_usd_per_mtok: 1, output_usd_per_mtok: 2, ...pricing, ...extra }],
  });

  it('takes an optional cached price, not negative and not above the input price', () => {
    expect(loadConfig({}, cat({})).catalog.models[0]!.cached_input_usd_per_mtok).toBeUndefined();
    expect(loadConfig({}, cat({ cached_input_usd_per_mtok: 0.25 })).catalog.models[0]!.cached_input_usd_per_mtok).toBe(0.25);
    expect(loadConfig({}, cat({ cached_input_usd_per_mtok: 1 })).catalog.models[0]!.cached_input_usd_per_mtok).toBe(1);
    expect(loadConfig({}, cat({ cached_input_usd_per_mtok: 0 })).catalog.models[0]!.cached_input_usd_per_mtok).toBe(0);
    expect(() => loadConfig({}, cat({ cached_input_usd_per_mtok: 1.01 }))).toThrow(/cached_input_usd_per_mtok must not be above input_usd_per_mtok/);
    expect(() => loadConfig({}, cat({ cached_input_usd_per_mtok: -0.1 }))).toThrow();
    expect(() => loadConfig({}, cat({ cached_input_usd_per_mtok: '0.1' }))).toThrow();
    expect(() => loadConfig({}, cat({ pricing: 'free', free_reason: 'test', input_usd_per_mtok: undefined, output_usd_per_mtok: undefined, cached_input_usd_per_mtok: 0 }))).toThrow(/cached input price/);
  });

  it("the shipped catalog sets it for exactly the models whose cached price Tinfoil's rate card listed on 2026-11-20", () => {
    const raw = JSON.parse(readFileSync(new URL('../../config/models.json', import.meta.url), 'utf8'));
    const set = Object.fromEntries(CatalogSchema.parse(raw).models.filter((m) => m.cached_input_usd_per_mtok !== undefined).map((m) => [m.id, [m.cached_input_usd_per_mtok, m.input_usd_per_mtok]]));
    expect(set).toEqual({ 'tinfoil/deepseek-v4-1-flash': [0.01, 0.6], 'tinfoil/glm-5-3': [0.45, 1.8], 'tinfoil/kimi-k3-1-pro': [0.4, 4] });
    expect(raw._comment).toContain('cachedInputTokenPricePer1M');
    expect(raw._comment).toContain('2026-11-20');
  });
});

describe('cached input: admin costs', () => {
  const catalog = {
    suppliers: { tf: { type: 'mock', tier: 'standard' } },
    models: [{ id: 'm1', supplier: 'tf', upstream: 'm1', input_usd_per_mtok: 1, cached_input_usd_per_mtok: 0.1, output_usd_per_mtok: 2 }],
  };

  it('fits prices with the cached input taken out at the cached price, so cache hits are no drift', () => {
    const config = loadConfig({}, catalog);
    const db = openDb(':memory:');
    const ins = db.prepare(
      "INSERT INTO requests (id, payment, unit, model, supplier, status, input_tokens, cached_input_tokens, output_tokens, price_nusd, supplier_cost_nusd, cost_source, created_at) VALUES (?, 'balance', 'usd', 'm1', 'tf', 'settled', ?, ?, ?, ?, ?, 'supplier', ?)",
    );
    // 1,000 nano-USD per uncached input token, 100 per cached one, 2,000 per output token: the supplier's figure.
    const mix = [[1000, 800, 100], [2000, 0, 800], [5000, 4000, 50], [300, 300, 10]] as const;
    mix.forEach(([i, k, o], n) => {
      const cost = (i - k) * 1000 + k * 100 + o * 2000;
      ins.run('r' + n, i, k, o, cost, cost, Date.now());
    });
    const m = supplierCosts(db, config, 30).models[0]!;
    expect(m.cached_input_tokens).toBe(5100);
    expect(m.catalog.cached_input).toBe(0.1);
    expect(m.derived!.input).toBeCloseTo(1, 6);
    expect(m.derived!.output).toBeCloseTo(2, 6);
    expect(m.drift).toBe(false);
    expect(m.cost_nusd).toBe(m.price_nusd);
  });

  it('reads rows from before the column (no cached count) as no cached tokens', () => {
    const config = loadConfig({}, catalog);
    const db = openDb(':memory:');
    const ins = db.prepare(
      "INSERT INTO requests (id, payment, unit, model, supplier, status, input_tokens, output_tokens, price_nusd, supplier_cost_nusd, cost_source, created_at) VALUES (?, 'balance', 'usd', 'm1', 'tf', 'settled', ?, ?, ?, ?, 'supplier', ?)",
    );
    const mix = [[1000, 100], [200, 800]] as const;
    mix.forEach(([i, o], n) => ins.run('r' + n, i, o, 1, i * 1000 + o * 2000, Date.now()));
    const m = supplierCosts(db, config, 30).models[0]!;
    expect(m.cached_input_tokens).toBe(0);
    expect(m.derived!.input).toBeCloseTo(1, 6);
  });
});

describe('cached input: the database', () => {
  it('adds requests.cached_input_tokens to a database from before it; old rows read as NULL', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'forge-cached-')), 'forge.db');
    // A database as the previous release left it: the requests table without the column, with a row.
    let db = openDb(path);
    db.exec('ALTER TABLE requests DROP COLUMN cached_input_tokens');
    db.prepare(
      "INSERT INTO requests (id, payment, unit, model, supplier, status, input_tokens, output_tokens, price_nusd, created_at) VALUES ('old', 'balance', 'usd', 'm1', 'tf', 'settled', 10, 2, 5, ?)",
    ).run(Date.now());
    expect((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name)).not.toContain('cached_input_tokens');
    db.close();
    db = openDb(path);
    expect((db.prepare('PRAGMA table_info(requests)').all() as Array<{ name: string }>).map((c) => c.name)).toContain('cached_input_tokens');
    expect(db.prepare("SELECT input_tokens, cached_input_tokens FROM requests WHERE id = 'old'").get()).toEqual({ input_tokens: 10, cached_input_tokens: null });
    // Opening it again changes nothing.
    db.close();
    db = openDb(path);
    expect(db.prepare("SELECT cached_input_tokens FROM requests WHERE id = 'old'").get()).toEqual({ cached_input_tokens: null });
    db.close();
  });
});
