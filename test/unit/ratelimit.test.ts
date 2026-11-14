import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { RateLimiter } from '../../src/ratelimit.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 1, output_usd_per_mtok: 2 }],
};

// RPM 4 gives the limiter's minimum burst of 5 per bucket, refilling far slower than a test runs.
const BURST = 5;

function gateway() {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_RATE_LIMIT_RPM: '4', FORGE_TRUST_PROXY: 'true', FORGE_FOREIGN_DISCOVERY_RELAYS: '' };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp(deps);
  const chat = (ip: string, key?: string) =>
    app.request('http://gw.test/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], max_tokens: 8 }),
    });
  return { deps, chat };
}

/** Records every bucket key the gateway's limiters are asked for. */
function watchBuckets(): string[] {
  const keys: string[] = [];
  const real = RateLimiter.prototype.take;
  vi.spyOn(RateLimiter.prototype, 'take').mockImplementation(function (this: RateLimiter, key: string, now?: number) {
    keys.push(key);
    return real.call(this, key, now);
  });
  return keys;
}

afterEach(() => vi.restoreAllMocks());

describe('gateway rate limit (finding 10)', () => {
  it('gives rotating unknown bearers no fresh burst and no bucket of their own', async () => {
    const { chat } = gateway();
    const keys = watchBuckets();
    const codes: number[] = [];
    for (let i = 0; i < 8; i++) codes.push((await chat('203.0.113.7', newApiKey())).status);
    // The first burst reaches authentication and is refused there; the rest stop at the IP limit.
    expect(codes).toEqual([...Array(BURST).fill(401), ...Array(8 - BURST).fill(429)]);
    expect(new Set(keys)).toEqual(new Set(['ip:203.0.113.7']));
  });

  it('holds a verified key to its IP bucket and to its own account bucket', async () => {
    const { chat, deps } = gateway();
    const key = newApiKey();
    const account = deps.ledger.createAccountRaw(key, 'usd', null);
    const keys = watchBuckets();

    // Unknown bearers from one address use up that address; a real key from it is limited too.
    for (let i = 0; i < BURST; i++) await chat('198.51.100.1', newApiKey());
    expect((await chat('198.51.100.1', key)).status).toBe(429);

    // From fresh addresses the key is held by its account bucket instead.
    const codes: number[] = [];
    for (let i = 0; i < BURST + 2; i++) codes.push((await chat(`192.0.2.${i + 1}`, key)).status);
    expect(codes.slice(0, BURST).every((s) => s !== 429)).toBe(true);
    expect(codes.slice(BURST)).toEqual([429, 429]);
    expect(keys).toContain('acct:' + account.id);
    expect(keys.some((k) => k.startsWith('k:'))).toBe(false);
  });

  it('limits requests with no bearer by client IP', async () => {
    const { chat } = gateway();
    const codes: number[] = [];
    for (let i = 0; i < BURST + 1; i++) codes.push((await chat('203.0.113.9')).status);
    expect(codes.at(-1)).toBe(429);
    expect(codes.slice(0, BURST)).not.toContain(429);
    expect((await chat('203.0.113.10')).status).not.toBe(429);
  });
});
