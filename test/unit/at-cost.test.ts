import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

// The hosted gateway charges the suppliers' cost with no margin (FORGE_MARKUP=1, docs/PAYMENTS.md, What a
// request costs). Anyone can check that by comparing its GET /v1/models with config/models.json. This pins
// the comparison: at markup 1 the price list a client gets is the shipped catalog's cost, figure for figure.

const RATE = 100_000;
const raw = JSON.parse(readFileSync('config/models.json', 'utf8'));

async function listing(markup: string) {
  const env = {
    FORGE_DB_PATH: ':memory:',
    FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1',
    FORGE_FOREIGN_DISCOVERY_RELAYS: '',
    FORGE_MARKUP: markup,
    TOKENFACTORY_API_KEY: 'x',
    TINFOIL_API_KEY: 'x',
  } as NodeJS.ProcessEnv;
  const config = loadConfig(env, raw);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', RATE)], env });
  const body = (await (await createApp(deps).request('http://gw.test/v1/models')).json()) as any;
  return { config, body };
}

describe('the price list at markup 1', () => {
  it('lists every chat model at its catalog cost per million tokens, in usd and in sat', async () => {
    const { config, body } = await listing('1');
    expect(body.data.map((m: any) => m.id).sort()).toEqual(raw.models.map((m: any) => m.id).sort());
    for (const m of config.catalog.models) {
      const listed = body.data.find((x: any) => x.id === m.id);
      // cached_input only on a model with a cached price (docs/PAYMENTS.md, Cached input), else left out.
      const cached = m.cached_input_usd_per_mtok === undefined ? {} : { cached_input: m.cached_input_usd_per_mtok };
      expect(listed.pricing.usd_per_mtok, m.id).toEqual({ input: m.input_usd_per_mtok, output: m.output_usd_per_mtok, ...cached });
      expect(listed.pricing.sat_per_mtok.input, m.id).toBeCloseTo((m.input_usd_per_mtok / RATE) * 1e8, 4);
      expect(listed.pricing.sat_per_mtok.output, m.id).toBeCloseTo((m.output_usd_per_mtok / RATE) * 1e8, 4);
      if (m.cached_input_usd_per_mtok === undefined) {
        expect(listed.pricing.usd_per_mtok, m.id).not.toHaveProperty('cached_input');
        expect(listed.pricing.sat_per_mtok, m.id).not.toHaveProperty('cached_input');
      } else {
        expect(listed.pricing.sat_per_mtok.cached_input, m.id).toBeCloseTo((m.cached_input_usd_per_mtok / RATE) * 1e8, 4);
      }
    }
    // Free models are listed at 0 (docs/PAYMENTS.md, Free models); the paid ones at their supplier's price.
    expect(config.catalog.models.filter((m) => m.input_usd_per_mtok > 0).length).toBeGreaterThan(0);
  });

  it('lists the cached input price on exactly the models whose catalog entry has one', async () => {
    const { config, body } = await listing('1');
    const withCached = config.catalog.models.filter((m) => m.cached_input_usd_per_mtok !== undefined).map((m) => m.id);
    expect(withCached.sort()).toEqual(['tinfoil/deepseek-v4-1-flash', 'tinfoil/glm-5-3', 'tinfoil/kimi-k3-1-pro']);
    const listed = body.data.filter((x: any) => 'cached_input' in x.pricing.usd_per_mtok).map((x: any) => x.id);
    expect(listed.sort()).toEqual(withCached);
    const listedSat = body.data.filter((x: any) => 'cached_input' in x.pricing.sat_per_mtok).map((x: any) => x.id);
    expect(listedSat.sort()).toEqual(withCached);
  });

  it('holds at the catalog cost per token, with nothing rounded: every shipped price is a whole nano-USD per token', async () => {
    const { config, body } = await listing('1');
    for (const m of config.catalog.models) {
      const hold = body.data.find((x: any) => x.id === m.id).pricing.hold;
      expect(hold.basis).toBe('metered');
      expect(hold.input_nano_usd_per_token, m.id).toBe(m.input_usd_per_mtok * 1000);
      expect(hold.output_nano_usd_per_token, m.id).toBe(m.output_usd_per_mtok * 1000);
      expect(Number.isInteger(m.input_usd_per_mtok * 1000) && Number.isInteger(m.output_usd_per_mtok * 1000), m.id).toBe(true);
      if (m.cached_input_usd_per_mtok !== undefined) expect(Number.isInteger(m.cached_input_usd_per_mtok * 1000), m.id).toBe(true);
    }
  });

  it("lists the web search fee at the supplier's price", async () => {
    const { config, body } = await listing('1');
    const searching = config.catalog.models.filter((m) => m.web_search);
    expect(searching.length).toBeGreaterThan(0);
    for (const m of searching) {
      const fee = config.catalog.suppliers[m.supplier]!.web_search!.request_usd;
      expect(body.data.find((x: any) => x.id === m.id).pricing.hold.web_search.nano_usd, m.id).toBe(Math.round(fee * 1e9));
    }
  });

  it('lists every audio model at its catalog cost per request, second and 1,000 characters', async () => {
    const { config, body } = await listing('1');
    expect(body.audio.map((a: any) => a.id).sort()).toEqual(raw.audio.map((a: any) => a.id).sort());
    for (const a of config.catalog.audio) {
      const listed = body.audio.find((x: any) => x.id === a.id);
      expect(listed.pricing.usd, a.id).toEqual({ request: a.request_usd, second: a.usd_per_second, kchar: a.usd_per_kchar });
    }
  });

  it('lists the markup on top at any other setting, so the comparison tells the two apart', async () => {
    const { config, body } = await listing('1.25');
    const m = config.catalog.models.find((x) => x.id === 'tinfoil/gpt-oss-120b')!;
    expect(body.data.find((x: any) => x.id === m.id).pricing.usd_per_mtok.input).toBeCloseTo(m.input_usd_per_mtok * 1.25, 4);
  });
});
