// The faucet and the card relay need no balance, so the rate limit counts them by the client's address
// only: a made-up bearer on each request must not open a fresh bucket, and no bearer is looked up there.
// Every route pays its address bucket (test/unit/ratelimit.test.ts); a route that takes a balance also
// pays the account bucket of a key that verifies.
import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { RateLimiter } from '../../src/ratelimit.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { testCatalog } from '../e2e/helpers.ts';

setLogSilent(true);
const BASE = 'http://gw.test';

function gateway() {
  // The default limit: 60 a minute.
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_TRUST_PROXY: 'true' };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog(1));
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: undefined });
  const key = newApiKey();
  deps.ledger.createAccountRaw(key, 'usd', null);
  return { app, key };
}

const post = (app: ReturnType<typeof gateway>['app'], path: string, ip: string, bearer?: string) =>
  app.request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: '{}',
  });

describe('the rate limit on routes that need no balance', () => {
  for (const path of ['/v1/free/challenge', '/v1/free/verify', '/v1/free/claim', '/v1/wallet/fund/card/mint', '/v1/wallet/fund/card/swap', '/v1/wallet/fund/card/restore']) {
    it(`counts ${path} by address, whatever bearer comes with it`, async () => {
      const { app } = gateway();
      const codes: number[] = [];
      for (let i = 0; i < 61; i++) codes.push((await post(app, path, '198.51.100.7', randomBytes(24).toString('hex'))).status);
      expect(codes).toContain(429);
      expect(codes.at(-1)).toBe(429);
      // Another address has its own bucket.
      expect((await post(app, path, '198.51.100.8', randomBytes(24).toString('hex'))).status).not.toBe(429);
    });
  }

  it('shares one address bucket across the faucet, the card relay and the balance routes', async () => {
    const { app, key } = gateway();
    const codes: number[] = [];
    for (let i = 0; i < 61; i++) codes.push((await post(app, i % 2 ? '/v1/free/challenge' : '/v1/wallet/fund/card/mint', '198.51.100.9', randomBytes(24).toString('hex'))).status);
    expect(codes.at(-1)).toBe(429);
    // Every request pays its client address first, whatever key it carries: from the same address a
    // balance route is limited too. From another address the same key is not.
    expect((await post(app, '/v1/wallet/refund', '198.51.100.9', key)).status).toBe(429);
    expect((await post(app, '/v1/wallet/refund', '198.51.100.10', key)).status).not.toBe(429);
  });

  it('charges only the address bucket on these routes, even for a key that verifies', async () => {
    const { app, key } = gateway();
    const keys: string[] = [];
    const real = RateLimiter.prototype.take;
    const spy = vi.spyOn(RateLimiter.prototype, 'take').mockImplementation(function (this: RateLimiter, k: string, now?: number) {
      keys.push(k);
      return real.call(this, k, now);
    });
    try {
      for (const path of ['/v1/free/challenge', '/v1/wallet/fund/card/mint']) await post(app, path, '198.51.100.11', key);
    } finally {
      spy.mockRestore();
    }
    expect(keys).toEqual(['ip:198.51.100.11', 'ip:198.51.100.11']);
  });
});
