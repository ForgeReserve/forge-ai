import { describe, expect, it } from 'vitest';
import { supplierCosts } from '../../src/admin-api.ts';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { costFromHeaders, usageFromJson } from '../../src/meter.ts';

describe('supplier cost capture', () => {
  it('reads LiteLLM usage.cost and the cost header', () => {
    expect(usageFromJson({ usage: { prompt_tokens: 18, completion_tokens: 10, cost: 2.88e-6 } })).toEqual({ inputTokens: 18, outputTokens: 10, costUsd: 2.88e-6 });
    expect(usageFromJson({ usage: { prompt_tokens: 1, completion_tokens: 1 } })).toEqual({ inputTokens: 1, outputTokens: 1 });
    expect(costFromHeaders(new Headers({ 'x-litellm-response-cost': '0.0000042' }))).toBe(4.2e-6);
    expect(costFromHeaders(new Headers())).toBeUndefined();
  });
});

describe('supplierCosts', () => {
  const catalog = {
    suppliers: { tf: { type: 'mock', tier: 'standard' } },
    models: [{ id: 'm1', supplier: 'tf', upstream: 'm1', input_usd_per_mtok: 1, output_usd_per_mtok: 1 }],
  };
  it('fits per-million prices from reported costs and flags drift', () => {
    const config = loadConfig({}, catalog);
    const db = openDb(':memory:');
    const ins = db.prepare(
      "INSERT INTO requests (id, payment, unit, model, supplier, status, input_tokens, output_tokens, price_nusd, supplier_cost_nusd, cost_source, created_at) VALUES (?, 'balance', 'usd', 'm1', 'tf', 'settled', ?, ?, ?, ?, 'supplier', ?)",
    );
    // $0.06/M input is 60 nano-USD per token; $0.18/M output is 180.
    const mix = [[1000, 100], [200, 800], [5000, 50]] as const;
    mix.forEach(([i, o], n) => ins.run('r' + n, i, o, 1000, i * 60 + o * 180, Date.now()));
    const r = supplierCosts(db, config, 30);
    const m = r.models[0]!;
    expect(m.requests).toBe(3);
    expect(m.supplier_reported).toBe(3);
    expect(m.derived!.input).toBeCloseTo(0.06, 3);
    expect(m.derived!.output).toBeCloseTo(0.18, 3);
    expect(m.drift).toBe(true);
    expect(r.total.price_nusd).toBe(3000);
  });

  it('gives no fit when every request has the same input/output mix', () => {
    const config = loadConfig({}, catalog);
    const db = openDb(':memory:');
    const ins = db.prepare(
      "INSERT INTO requests (id, payment, unit, model, supplier, status, input_tokens, output_tokens, price_nusd, supplier_cost_nusd, cost_source, created_at) VALUES (?, 'balance', 'usd', 'm1', 'tf', 'settled', 10, 10, 5, 2, 'supplier', ?)",
    );
    ins.run('a', Date.now());
    ins.run('b', Date.now());
    expect(supplierCosts(db, config, 30).models[0]!.derived).toBeNull();
  });
});
