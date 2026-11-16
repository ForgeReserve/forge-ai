import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

// Free models (owner decision, 2026-11-15): Token Factory charges Forge nothing during its beta, so its
// models cost users nothing. A request needs a balance key (even at $0) and is never held or charged;
// without one it is refused before any payment is looked at. Paid models behave exactly as before.

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' }, freebie: { type: 'mock', tier: 'standard' } },
  models: [
    { id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 100, output_usd_per_mtok: 1000, max_output_tokens: 256, price_verified: true },
    { id: 'free-echo', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'test: no charge to Forge', max_output_tokens: 256 },
    { id: 'free-nousage', supplier: 'freebie', upstream: 'mock-nousage', pricing: 'free', free_reason: 'test', max_output_tokens: 256 },
    { id: 'free-fail', supplier: 'freebie', upstream: 'mock-fail', pricing: 'free', free_reason: 'test', max_output_tokens: 256 },
  ],
};

function gateway(extra: Record<string, string> = {}) {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_RATE_LIMIT_RPM: '100000', FORGE_MARKUP: '1.25', FORGE_FOREIGN_DISCOVERY_RELAYS: '', ...extra };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp(deps);
  const chat = (body: object, headers: Record<string, string> = {}) =>
    app.request('http://gw.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  /** A balance opened the way an invite opens one, holding `msub`. */
  const balance = (msub = 0, unit: 'usd' | 'sat' = 'usd', free = false) => {
    const key = newApiKey();
    const a = deps.ledger.createAccountRaw(key, unit, null, free);
    if (msub) deps.ledger.creditRaw(a.id, msub, 'topup', null);
    return { key, id: a.id };
  };
  const reservations = (accountId: string) => (deps.db.prepare('SELECT COUNT(*) AS n FROM reservations WHERE account_id = ?').get(accountId) as { n: number }).n;
  const ledgerRows = (accountId: string) => deps.db.prepare('SELECT kind, amount_msub FROM ledger WHERE account_id = ?').all(accountId);
  const request = (id: string) => deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as any;
  return { app, deps, chat, balance, reservations, ledgerRows, request };
}

const ask = (model: string, extra: object = {}) => ({ model, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 64, ...extra });
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

afterEach(() => vi.restoreAllMocks());

describe('a free model with a balance key', () => {
  it('is answered at a $0 balance: nothing held, nothing charged, the balance unchanged', async () => {
    const g = gateway();
    const b = g.balance(0);
    const r = await g.chat(ask('free-echo'), auth(b.key));
    expect(r.status).toBe(200);
    expect((await r.json()).choices[0].message.content).toContain('Forge');
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    expect(r.headers.get('x-forge-balance-msub')).toBe('0');
    expect(g.deps.ledger.get(b.id)!.balance_msub).toBe(0);
    expect(g.reservations(b.id)).toBe(0);
    expect(g.ledgerRows(b.id)).toEqual([]);
    // Usage is still recorded: charged 0, priced 0, cost 0, cost_source free.
    const row = g.request(r.headers.get('x-forge-request-id')!);
    expect(row).toMatchObject({ status: 'settled', payment: 'balance', charged_msub: 0, reserved_msub: 0, price_nusd: 0, supplier_cost_nusd: 0, cost_source: 'free' });
    expect(row.input_tokens).toBeGreaterThan(0);
    expect(row.output_tokens).toBe(12);
  });

  it('leaves a funded balance untouched, in usd and in sat, streamed or not', async () => {
    const g = gateway();
    for (const unit of ['usd', 'sat'] as const) {
      const b = g.balance(50_000, unit);
      const plain = await g.chat(ask('free-echo'), auth(b.key));
      expect(plain.status).toBe(200);
      await plain.text();
      const streamed = await g.chat(ask('free-echo', { stream: true }), auth(b.key));
      expect(streamed.status).toBe(200);
      const raw = await streamed.text();
      const forge = JSON.parse(raw.split('event: forge\ndata: ')[1]!.split('\n')[0]!);
      expect(forge).toMatchObject({ charged_msub: 0, balance_msub: 50_000 });
      // A response with no usage count is not charged the worst case either.
      const nousage = await g.chat(ask('free-nousage', { stream: true }), auth(b.key));
      expect(nousage.status).toBe(200);
      await nousage.text();
      expect(g.deps.ledger.get(b.id)!.balance_msub).toBe(50_000);
      expect(g.reservations(b.id)).toBe(0);
      expect(g.ledgerRows(b.id)).toEqual([{ kind: 'topup', amount_msub: 50_000 }]);
    }
  });

  it('records a failed upstream call as failed, still with nothing charged', async () => {
    const g = gateway();
    const b = g.balance(0);
    const r = await g.chat(ask('free-fail'), auth(b.key));
    expect(r.status).toBe(502);
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    expect(g.request(r.headers.get('x-forge-request-id')!)).toMatchObject({ status: 'failed', charged_msub: 0 });
    expect(g.reservations(b.id)).toBe(0);
  });

  it('works while the BTC/USD rate is down: nothing is priced in sat', async () => {
    const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '' };
    const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
    const deps = buildDeps(config, { rateSources: [], env: e as NodeJS.ProcessEnv });
    const app = createApp(deps);
    const key = newApiKey();
    deps.ledger.createAccountRaw(key, 'sat', null);
    const r = await app.request('http://gw.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...auth(key) }, body: JSON.stringify(ask('free-echo')) });
    expect(r.status).toBe(200);
  });

  it('is refused on a frozen balance', async () => {
    const g = gateway();
    const b = g.balance(0);
    g.deps.ledger.setFrozen(b.id, true);
    const r = await g.chat(ask('free-echo'), auth(b.key));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('account_frozen');
  });

  it('still answers an unknown key 401 invalid_key', async () => {
    const g = gateway();
    const r = await g.chat(ask('free-echo'), auth(newApiKey()));
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('invalid_key');
  });
});

describe('a free model without a balance key', () => {
  it('is refused 401 balance_key_required, with no payment request to pay', async () => {
    const g = gateway();
    const r = await g.chat(ask('free-echo'));
    expect(r.status).toBe(401);
    expect(r.headers.get('x-cashu')).toBeNull();
    const body = await r.json();
    expect(body.error.code).toBe('balance_key_required');
    expect(body.error.message).toMatch(/balance key/);
    expect(body.error.message).toMatch(/invite/);
    expect(body.payment_request).toBeUndefined();
  });

  it('never looks at or takes a NUT-24 token', async () => {
    const g = gateway();
    const inspect = vi.spyOn(g.deps.wallet, 'inspect');
    const receive = vi.spyOn(g.deps.wallet, 'receive');
    const r = await g.chat(ask('free-echo'), { 'x-cashu': 'cashuBnotarealtoken' });
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('balance_key_required');
    expect(inspect).not.toHaveBeenCalled();
    expect(receive).not.toHaveBeenCalled();
    expect(g.deps.db.prepare('SELECT COUNT(*) AS n FROM requests').get()).toEqual({ n: 0 });
  });

  it('is refused 403 balance_key_required on a free-question (credit) balance', async () => {
    const g = gateway({ FORGE_CREDIT_MINT: 'http://127.0.0.1:2', FORGE_FREE_MODELS: 'mock-echo' });
    const b = g.balance(3000, 'usd', true);
    const r = await g.chat(ask('free-echo'), auth(b.key));
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('balance_key_required');
    expect(g.deps.ledger.get(b.id)!.balance_msub).toBe(3000);
    expect(g.reservations(b.id)).toBe(0);
  });
});

describe('a paid model, unchanged', () => {
  it('is still refused at a $0 balance', async () => {
    const g = gateway();
    const b = g.balance(0);
    const r = await g.chat(ask('mock-echo'), auth(b.key));
    expect(r.status).toBe(402);
    expect((await r.json()).error.code).toBe('insufficient_balance');
  });

  it('still holds and charges a funded balance at its price with markup', async () => {
    const g = gateway();
    const b = g.balance(10_000_000);
    const r = await g.chat(ask('mock-echo'), auth(b.key));
    expect(r.status).toBe(200);
    const row = g.request(r.headers.get('x-forge-request-id')!);
    // 12 output tokens at $1000/M and the input at $100/M, times 1.25, in milli-cents (rounded up).
    const nano = row.input_tokens * 125 * 1000 + 12 * 1250 * 1000;
    expect(row.charged_msub).toBe(Math.ceil(nano / 10_000));
    expect(row.charged_msub).toBeGreaterThan(0);
    expect(row.cost_source).toBe('catalog');
    expect(g.deps.ledger.get(b.id)!.balance_msub).toBe(10_000_000 - row.charged_msub);
    expect(g.reservations(b.id)).toBe(1);
  });

  it('still answers a request without a key with a 402 payment request', async () => {
    const g = gateway({ FORGE_INVITE_ONLY: 'false' });
    const r = await g.chat(ask('mock-echo'));
    expect(r.status).toBe(402);
    expect(r.headers.get('x-cashu')).toMatch(/^creq/);
  });
});

describe('GET /v1/models', () => {
  it('marks free models free, with a hold of 0, and keeps the old fields', async () => {
    const g = gateway();
    const body = await (await g.app.request('http://gw.test/v1/models')).json();
    const free = body.data.find((m: any) => m.id === 'free-echo');
    expect(free.pricing).toMatchObject({
      free: true,
      free_reason: 'test: no charge to Forge',
      mode: 'metered',
      usd_per_mtok: { input: 0, output: 0 },
      sat_per_mtok: { input: 0, output: 0 },
      hold: { basis: 'metered', input_nano_usd_per_token: 0, output_nano_usd_per_token: 0, web_search: null },
    });
    const paid = body.data.find((m: any) => m.id === 'mock-echo');
    expect(paid.pricing.free).toBe(false);
    expect(paid.pricing.usd_per_mtok).toEqual({ input: 125, output: 1250 });
    expect(paid.pricing.hold.input_nano_usd_per_token).toBe(125_000);
  });
});

describe('POST /v1/wallet/open', () => {
  const open = (g: ReturnType<typeof gateway>, body: object, headers: Record<string, string> = {}) =>
    g.app.request('http://gw.test/v1/wallet/open', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  it('opens a balance at 0 with an invite, whose key uses a free model at once', async () => {
    const g = gateway({ FORGE_INVITE_ONLY: 'true' });
    const code = g.deps.invites.create('t').code;
    const r = await open(g, { invite: code });
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toMatchObject({ unit: 'usd', created: true, balance_msub: 0, free_models: ['free-echo', 'free-nousage', 'free-fail'] });
    expect(body.key).toMatch(/^sk-forge-/);
    expect(g.deps.invites.lookup(code)!.status).toBe('redeemed');
    const chat = await g.chat(ask('free-echo'), auth(body.key));
    expect(chat.status).toBe(200);
    expect(chat.headers.get('x-forge-charged-msub')).toBe('0');
    // The same invite opens nothing more, and a paid model still needs funds.
    expect((await open(g, { invite: code })).status).toBe(403);
    expect((await g.chat(ask('mock-echo'), auth(body.key))).status).toBe(402);
  });

  it('always takes an invite, even when FORGE_INVITE_ONLY is off', async () => {
    const g = gateway({ FORGE_INVITE_ONLY: 'false' });
    const r = await open(g, {});
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('invite_required');
    expect((await open(g, { invite: 'nope' })).status).toBe(403);
  });

  it('answers a known key as it is and leaves its invite alone', async () => {
    const g = gateway();
    const b = g.balance(5000);
    const r = await open(g, {}, auth(b.key));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ account_id: b.id, created: false, balance_msub: 5000 });
  });

  it('keeps an opened balance when a later funding of it expires (releaseIfEmpty)', async () => {
    const { releaseIfEmpty } = await import('../../src/accounts.ts');
    const g = gateway({ FORGE_INVITE_ONLY: 'true' });
    const r = await (await open(g, { invite: g.deps.invites.create('t').code })).json();
    expect(releaseIfEmpty(g.deps.db, r.account_id)).toBe(false);
    expect(g.deps.ledger.get(r.account_id)).toBeTruthy();
    // A balance opened by a funding and used on a free model while the funding waits is kept too.
    const b = g.balance(0);
    expect((await g.chat(ask('free-echo'), auth(b.key))).status).toBe(200);
    expect(releaseIfEmpty(g.deps.db, b.id)).toBe(false);
    // One never used is still released, as before.
    const unused = g.balance(0);
    expect(releaseIfEmpty(g.deps.db, unused.id)).toBe(true);
  });

  it('is listed in the funding methods while there are free models', async () => {
    const g = gateway();
    const m = await (await g.app.request('http://gw.test/v1/wallet/fund/methods')).json();
    expect(m.open).toEqual({ enabled: true, free_models: ['free-echo', 'free-nousage', 'free-fail'] });
  });
});

describe('a Token Factory model from config/models.json', () => {
  it('is answered at a $0 balance and never charged (the supplier swapped for the mock: no live call)', async () => {
    const raw = JSON.parse(readFileSync('config/models.json', 'utf8'));
    raw.suppliers.tokenfactory = { type: 'mock', tier: 'standard' };
    for (const m of raw.models) if (m.supplier === 'tokenfactory') m.upstream = 'mock-echo';
    const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', TINFOIL_API_KEY: 'x', FORGE_FOREIGN_DISCOVERY_RELAYS: '' };
    const deps = buildDeps(loadConfig(e as NodeJS.ProcessEnv, raw), { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
    const app = createApp(deps);
    for (const msub of [0, 7_000]) {
      const key = newApiKey();
      const a = deps.ledger.createAccountRaw(key, 'usd', null);
      if (msub) deps.ledger.creditRaw(a.id, msub, 'topup', null);
      const r = await app.request('http://gw.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...auth(key) }, body: JSON.stringify(ask('glm-5.3-flash')) });
      expect(r.status).toBe(200);
      expect(r.headers.get('x-forge-charged-msub')).toBe('0');
      expect(deps.ledger.get(a.id)!.balance_msub).toBe(msub);
    }
  });
});

describe('Start free: an invite code alone, with config/models.json', () => {
  it('opens a $0 balance whose key answers on a Token Factory model and is refused on a paid one', async () => {
    const raw = JSON.parse(readFileSync('config/models.json', 'utf8'));
    raw.suppliers.tokenfactory = { type: 'mock', tier: 'standard' };
    for (const m of raw.models) if (m.supplier === 'tokenfactory') m.upstream = 'mock-echo';
    const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', TINFOIL_API_KEY: 'x', FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_INVITE_ONLY: 'true' };
    const deps = buildDeps(loadConfig(e as NodeJS.ProcessEnv, raw), { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
    const app = createApp(deps);
    const code = deps.invites.create('t').code;
    const r = await app.request('http://gw.test/v1/wallet/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: code }) });
    expect(r.status).toBe(200);
    const { key, account_id } = await r.json();
    // The invite is spent as a funded top-up spends it: bound to the new balance, and not reusable.
    expect(deps.invites.lookup(code)).toMatchObject({ status: 'redeemed' });
    expect(deps.ledger.get(account_id)!.invite_id).toBeTruthy();
    const chat = (model: string) =>
      app.request('http://gw.test/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', ...auth(key) }, body: JSON.stringify(ask(model)) });
    expect((await chat('glm-5.3-flash')).status).toBe(200);
    expect((await chat('tinfoil/gpt-oss-120b')).status).toBe(402);
    expect(deps.ledger.get(account_id)!.balance_msub).toBe(0);
  });
});

describe('the catalog', () => {
  it('makes every Token Factory model free, with a reason, and no Tinfoil model', () => {
    const raw = JSON.parse(readFileSync('config/models.json', 'utf8'));
    const c = loadConfig({ TOKENFACTORY_API_KEY: 'x', TINFOIL_API_KEY: 'x', FORGE_FOREIGN_DISCOVERY_RELAYS: '' } as NodeJS.ProcessEnv, raw);
    const tf = c.catalog.models.filter((m) => m.supplier === 'tokenfactory');
    expect(tf.length).toBe(11); // minimax-m3.1-flash and nemotron-3-super left Token Factory on 2026-11-15
    for (const m of tf) {
      expect(m.pricing).toBe('free');
      expect(m.free_reason).toMatch(/Token Factory beta/);
      expect([m.input_usd_per_mtok, m.output_usd_per_mtok]).toEqual([0, 0]);
    }
    for (const m of c.catalog.models.filter((x) => x.supplier === 'tinfoil')) {
      expect(m.pricing).toBe('paid');
      expect(m.input_usd_per_mtok).toBeGreaterThan(0);
    }
  });

  it('refuses a free model with a token price, without a reason, or with web search', () => {
    const base = (m: object) => ({ suppliers: { s: { type: 'mock', tier: 'standard' } }, models: [{ id: 'x', supplier: 's', upstream: 'x', pricing: 'free', free_reason: 'r', ...m }] });
    expect(() => loadConfig({}, base({ input_usd_per_mtok: 1 }))).toThrow(/free model x/);
    expect(() => loadConfig({}, base({ free_reason: undefined }))).toThrow(/free_reason/);
    expect(() => loadConfig({}, base({ web_search: true }))).toThrow(/web_search/);
    // A paid model still needs its prices.
    expect(() => loadConfig({}, { suppliers: { s: { type: 'mock', tier: 'standard' } }, models: [{ id: 'y', supplier: 's', upstream: 'y' }] })).toThrow(/price/);
  });

  it('leaves free models off the free-question (credit) list', async () => {
    const { freeRules } = await import('../../src/credits.ts');
    const c = loadConfig({ FORGE_CREDIT_MINT: 'https://credits.example', FORGE_FREE_MODELS: 'free-echo,mock-echo' }, catalog);
    expect(freeRules(c)!.models).toEqual(['mock-echo']);
  });
});

// Speed marks (owner, 2026-11-15): the v2 model picker shows a rabbit on fast models and lists slow ones
// under their own Slow heading (a turtle). The marks come from a timing battery of every model: the
// private (Tinfoil) ones are all fast, and the free Standard Kimi K3.1 Pro is slow while its private twin is fast.
describe('speed marks in config/models.json and /v1/models', () => {
  const raw = JSON.parse(readFileSync('config/models.json', 'utf8'));
  it('marks the free models fast or slow, and every private model fast', () => {
    const speed = Object.fromEntries(raw.models.map((m: any) => [m.id, m.speed ?? null]));
    expect(speed).toMatchObject({
      'glm-5.3-flash': 'fast',
      'nemotron-3-ultra': 'fast',
      'deepseek-v4.1-flash-1017': 'fast',
      'glm-5.3-flash-uncensored-fp8': 'fast',
      'glm-5.3': 'fast',
      'kimi-k3.1-pro': 'slow',
      'glm-5.3-uncensored-fp8': 'slow',
      'kimi-k3-abliterated': 'slow',
      'deepseek-v4.1-flash-1017-uncensored-fp8': 'slow',
      'qwen3.8-27b': 'slow',
      'nemotron-3.5-lightning': null,
    });
    for (const m of raw.models.filter((x: any) => x.supplier === 'tinfoil')) expect(m.speed, m.id).toBe('fast');
    expect(speed['tinfoil/kimi-k3-1-pro']).toBe('fast');
  });
  it('serves the mark as speed, null where there is none', async () => {
    const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '', TINFOIL_API_KEY: 'x', TOKENFACTORY_API_KEY: 'x' };
    const config = loadConfig(e as NodeJS.ProcessEnv, raw);
    const app = createApp(buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv }));
    const body = await (await app.request('http://gw.test/v1/models')).json();
    const by = (id: string) => body.data.find((m: any) => m.id === id);
    expect(by('glm-5.3-flash').speed).toBe('fast');
    expect(by('kimi-k3.1-pro').speed).toBe('slow');
    expect(by('nemotron-3.5-lightning').speed).toBeNull();
    expect(by('tinfoil/gpt-oss-120b').speed).toBe('fast');
  });
});
