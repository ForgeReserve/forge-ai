import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, startGateway } from './helpers.ts';

const TOKEN = 'e2e-admin-token-' + randomBytes(8).toString('hex');

/** A stand-in for Tinfoil's admin billing API with the response shapes seen on 2026-11-10. */
async function fakeTinfoil(): Promise<{ url: string; auth: string[]; close: () => Promise<void> }> {
  const auth: string[] = [];
  const server: Server = createServer((req, res) => {
    auth.push(req.headers.authorization ?? '');
    const url = new URL(req.url ?? '/', 'http://x');
    const body =
      url.pathname === '/api/billing/usage'
        ? url.searchParams.get('time') === '30d'
          ? { cost: 0.5, requests: 40, tokens: 9000 }
          : { cost: 1.25, requests: 100, tokens: 20000 }
        : url.pathname === '/api/billing/transactions'
          ? { transactions: [{ amount: 10 }, { amount: -2 }] }
          : null;
    res.writeHead(body ? 200 : 404, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body ?? { error: 'not found' }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    auth,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('admin overview: Tinfoil credit', () => {
  let g: Gateway;
  let tf: Awaited<ReturnType<typeof fakeTinfoil>>;
  beforeAll(async () => {
    tf = await fakeTinfoil();
    g = await startGateway({
      env: {
        FORGE_ADMIN_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'),
        FORGE_ADMIN_RATE_LIMIT_RPM: '100000',
        TINFOIL_ADMIN_KEY: 'admin_test',
        FORGE_TINFOIL_ADMIN_URL: tf.url,
        FORGE_TINFOIL_OPENING_CREDIT_USD: '5',
        FORGE_TINFOIL_LOW_USD: '1',
      },
    });
  });
  afterAll(async () => {
    await g.close();
    await tf.close();
  });

  it('works out remaining credit as opening + credit added - all-time spend', async () => {
    const res = await fetch(`${g.url}/admin/api/overview`, { headers: { 'X-Forge-Admin-Token': TOKEN } });
    expect(res.status).toBe(200);
    const o = (await res.json()) as any;
    expect(o.tinfoil).toMatchObject({ ok: true, opening_usd: 5, added_usd: 10, spent_usd: 1.25, spent_30d_usd: 0.5, requests: 100, remaining_usd: 13.75, low: false });
    expect(tf.auth.every((a) => a === 'Bearer admin_test')).toBe(true);
    // The admin key never reaches the browser.
    expect(JSON.stringify(o)).not.toContain('admin_test');
  });
});
