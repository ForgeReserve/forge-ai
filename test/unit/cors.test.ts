// The Android app runs the v2 app from its own files at https://localhost, so every engine route the
// app uses is a cross-origin call: the browser asks first (preflight) for anything with a balance key
// or a JSON body, and lets the app read only the answer headers the engine exposes. These checks run
// each route the way the app calls it (public/v2/core/engine.js, core/faucet.js, the Tinfoil SDK).
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { silentWav } from '../../src/audio.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { testCatalog } from '../e2e/helpers.ts';

setLogSilent(true);
const { POW_CHALLENGE_HEADER, POW_HEADER }: { POW_CHALLENGE_HEADER: string; POW_HEADER: string } = await import('../../public/v2/core/pow.js' as string);
const APP = 'https://localhost';
const BASE = 'http://gw.test';

function gateway(env: Record<string, string> = {}) {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_MARKUP: '1', FORGE_RATE_LIMIT_RPM: '100000', TEST_TINFOIL_KEY: 'k', ...env };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog(1, { audio: true }));
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: undefined });
  const key = newApiKey();
  const acct = deps.ledger.createAccountRaw(key, 'usd', null);
  deps.ledger.creditRaw(acct.id, 5_000_000, 'topup', null);
  return { app, key, deps };
}

/** The browser's preflight for a request with these headers. */
const preflight = (app: ReturnType<typeof gateway>['app'], path: string, method: string, headers: string[]) =>
  app.request(`${BASE}${path}`, { method: 'OPTIONS', headers: { origin: APP, 'access-control-request-method': method, 'access-control-request-headers': headers.join(',') } });

function allows(res: Response, method: string, headers: string[]) {
  expect(res.status, 'preflight status').toBeLessThan(300);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  const methods = (res.headers.get('access-control-allow-methods') ?? '').toLowerCase().split(/\s*,\s*/);
  expect(methods).toContain(method.toLowerCase());
  const allowed = (res.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(/\s*,\s*/);
  for (const h of headers) expect(allowed, h).toContain(h.toLowerCase());
}

/** What the app may read from an answer. */
function exposes(res: Response, headers: string[]) {
  expect(res.headers.get('access-control-allow-origin'), 'allow origin').toBe('*');
  const exposed = (res.headers.get('access-control-expose-headers') ?? '').toLowerCase().split(/\s*,\s*/);
  for (const h of headers) expect(exposed, h).toContain(h.toLowerCase());
}

// Every call the v2 app makes to its engine: [method, path, request headers beyond the safelisted ones].
const AUTH_JSON = ['authorization', 'content-type'];
const ROUTES: Array<[string, string, string[]]> = [
  ['GET', '/v1/models', []],
  ['GET', '/v1/wallet', ['authorization']],
  ['GET', '/v1/wallet/refunds', ['authorization']],
  ['POST', '/v1/wallet/refund', AUTH_JSON],
  ['POST', '/v1/wallet/topup', AUTH_JSON],
  ['GET', '/v1/wallet/fund/methods', []],
  ['GET', '/v1/wallet/fund/mints', []],
  ['GET', '/v1/wallet/fund/fund_x', ['authorization']],
  ['POST', '/v1/wallet/fund/lightning', AUTH_JSON],
  ['POST', '/v1/wallet/fund/onchain', AUTH_JSON],
  ['POST', '/v1/wallet/fund/foreign/quote', AUTH_JSON],
  ['POST', '/v1/wallet/fund/foreign/confirm', AUTH_JSON],
  ['POST', '/v1/audio/transcriptions', ['authorization']],
  ['POST', '/v1/audio/speech', AUTH_JSON],
  ['POST', '/v1/chat/completions', AUTH_JSON],
  // A private model: the body is encrypted to the enclave (EHBP, the Tinfoil SDK).
  ['POST', '/v1/chat/completions', ['authorization', 'content-type', 'ehbp-encapsulated-key', 'x-tinfoil-model', 'x-tinfoil-max-output-tokens']],
  // The same, with web search on (the app says so in a header: the body is encrypted).
  ['POST', '/v1/chat/completions', ['authorization', 'content-type', 'ehbp-encapsulated-key', 'x-tinfoil-model', 'x-tinfoil-max-output-tokens', 'x-forge-web-search']],
  // A Bellows asks for proof of work with a 428; the app sends the same request again with the solution.
  ['POST', '/v1/wallet/topup', [...AUTH_JSON, POW_HEADER]],
  ['GET', '/v1/free', []],
  ['POST', '/v1/free/challenge', ['content-type']],
  ['POST', '/v1/free/verify', ['content-type']],
  ['POST', '/v1/free/claim', ['content-type']],
];

describe('CORS for the Android app (origin https://localhost)', () => {
  it.each(ROUTES)('allows %s %s with the headers the app sends', async (method, path, headers) => {
    const { app } = gateway();
    allows(await preflight(app, path, method, headers), method, headers);
  });

  it('allows the attestation the Tinfoil SDK reads', async () => {
    const { app } = gateway();
    for (const path of ['/attestation', '/.well-known/hpke-keys']) {
      const r = await app.request(`${BASE}${path}`, { headers: { origin: APP } });
      expect(r.headers.get('access-control-allow-origin'), path).toBe('*');
    }
  });

  it('lets the app read the balance after a paid answer, streamed', async () => {
    const { app, key } = gateway();
    const r = await app.request(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { origin: APP, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 16, stream: true }),
    });
    expect(r.status).toBe(200);
    await r.text();
    exposes(r, ['X-Forge-Request-Id', 'X-Forge-Unit', 'X-Forge-Privacy']);
  });

  it('lets the app read what speech cost', async () => {
    const { app, key } = gateway();
    const say = await app.request(`${BASE}/v1/audio/speech`, {
      method: 'POST',
      headers: { origin: APP, authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'mock-speech', input: 'Hello there.', response_format: 'wav' }),
    });
    expect(say.status).toBe(200);
    exposes(say, ['X-Forge-Charged-Msub', 'X-Forge-Balance-Msub']);

    const form = new FormData();
    form.append('file', new Blob([silentWav(1, 16000) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', 'mock-transcribe');
    const heard = await app.request(`${BASE}/v1/audio/transcriptions`, { method: 'POST', headers: { origin: APP, authorization: `Bearer ${key}` }, body: form });
    expect(heard.status).toBe(200);
    exposes(heard, ['X-Forge-Charged-Msub', 'X-Forge-Balance-Msub']);
  });

  it('lets the app read refusals, so it can say what went wrong', async () => {
    const { app } = gateway({ FORGE_RATE_LIMIT_RPM: '1' });
    const bad = await app.request(`${BASE}/v1/wallet`, { headers: { origin: APP, authorization: 'Bearer nope' } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get('access-control-allow-origin')).toBe('*');
    const post = () => app.request(`${BASE}/v1/wallet/refund`, { method: 'POST', headers: { origin: APP, authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    let limited = await post();
    for (let i = 0; i < 30 && limited.status !== 429; i++) limited = await post();
    expect(limited.status).toBe(429);
    exposes(limited, ['Retry-After']);
    const big = await app.request(`${BASE}/v1/wallet/topup`, { method: 'POST', headers: { origin: APP, 'content-type': 'application/json' }, body: 'x'.repeat(1_100_000) });
    expect(big.status).toBe(413);
    expect(big.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('exposes the proof of work challenge a Bellows sends with a 428', async () => {
    const { app } = gateway();
    exposes(await app.request(`${BASE}/v1/models`, { headers: { origin: APP } }), [POW_CHALLENGE_HEADER]);
  });

  it('never lets another site call the admin API', async () => {
    const { app } = gateway();
    const r = await preflight(app, '/admin/api/session', 'GET', ['x-forge-admin-token']);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});
