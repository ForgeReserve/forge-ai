import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { getEncodedToken, Mint } from '@cashu/cashu-ts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GatewayWallet, PaymentError } from '../../src/cashu/wallet.ts';
import { openDb } from '../../src/db.ts';

/** A loopback HTTP listener that records every path it is asked for. */
interface Listener {
  url: string;
  hits: string[];
  server: Server;
}

function listen(handler: (path: string, res: import('node:http').ServerResponse) => void): Promise<Listener> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '');
    req.resume();
    handler(req.url ?? '', res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits, server })));
}

const fakeProof = { id: '00ad268c4d1f5826', amount: 8, secret: 'abc', C: '02' + '11'.repeat(32) } as any;

// Report finding 3: a mint that passes the first probe redirects the later Cashu requests to a
// private target. `target` stands for that private host; it must never be reached.
describe('Cashu transport: redirects are refused, untrusted mints are vetted before contact', () => {
  let target: Listener;
  let redirector: Listener;

  beforeAll(async () => {
    target = await listen((_path, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"synthetic":"invalid mint document"}');
    });
    redirector = await listen((_path, res) => {
      res.writeHead(302, { location: `${target.url}/private-target` });
      res.end();
    });
  });
  afterAll(() => {
    target.server.close();
    redirector.server.close();
  });
  beforeEach(() => {
    target.hits.length = 0;
    redirector.hits.length = 0;
  });

  it('mint discovery (info, keysets, keys) does not follow a redirect', async () => {
    const w = new GatewayWallet(openDb(':memory:'), { trustedMints: [redirector.url], units: ['sat'], maxTokenBytes: 2000 });
    await expect(w.wallet(redirector.url, 'sat')).rejects.toThrow();
    expect(redirector.hits).toContain('/v1/info');
    expect(target.hits).toEqual([]);
  });

  it('every other Cashu GET refuses a redirect too (keysets, keys, quote checks)', async () => {
    new GatewayWallet(openDb(':memory:'), { trustedMints: [redirector.url], units: ['sat'], maxTokenBytes: 2000 });
    const mint = new Mint(redirector.url);
    await expect(mint.getKeySets()).rejects.toThrow();
    await expect(mint.getKeys()).rejects.toThrow();
    await expect(mint.checkMintQuoteBolt11('q')).rejects.toThrow();
    await expect(mint.checkMeltQuoteBolt11('q')).rejects.toThrow();
    expect(redirector.hits.length).toBeGreaterThanOrEqual(4);
    expect(target.hits).toEqual([]);
  });

  it('an untrusted mint that fails the safety check is never contacted, and the error says why', async () => {
    const vetted: string[] = [];
    const w = new GatewayWallet(openDb(':memory:'), {
      trustedMints: ['https://forge.example'],
      units: ['sat'],
      maxTokenBytes: 2000,
      vetMint: async (m) => {
        vetted.push(m);
        throw new PaymentError('mint_not_allowed', 'this mint address is not allowed');
      },
    });
    const token = getEncodedToken({ mint: redirector.url, unit: 'sat', proofs: [fakeProof] });
    await expect(w.inspect(token, undefined, { foreign: true })).rejects.toMatchObject({ code: 'mint_not_allowed', status: 400 });
    await expect(w.wallet(redirector.url, 'sat')).rejects.toMatchObject({ code: 'mint_not_allowed' });
    expect(vetted).toEqual([redirector.url, redirector.url]);
    expect(redirector.hits).toEqual([]);
    expect(target.hits).toEqual([]);
  });

  it('a trusted mint is not put through the foreign-mint check', async () => {
    const vetted: string[] = [];
    const w = new GatewayWallet(openDb(':memory:'), {
      trustedMints: [redirector.url],
      units: ['sat'],
      maxTokenBytes: 2000,
      vetMint: async (m) => {
        vetted.push(m);
      },
    });
    await expect(w.wallet(redirector.url, 'sat')).rejects.toThrow();
    expect(vetted).toEqual([]);
  });
});
