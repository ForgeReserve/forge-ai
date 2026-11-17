import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, expectedMsub, type Gateway, MINT_A, mintToken, mintsUp, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();

/** Builds an EHBP-shaped body: [4-byte BE length][bytes] frames. Content is random (stands in for ciphertext). */
function frames(n: number, size = 40): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(size);
    parts.push(len, randomBytes(size));
  }
  return Buffer.concat(parts);
}

interface Seen {
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

describe.skipIf(!up)('EHBP encrypted pass-through (fake enclave)', () => {
  let enclave: http.Server;
  let g: Gateway;
  let key: string;
  const seen: Seen[] = [];
  let reply: Buffer;
  /** When set, the enclave answers 200 with headers and a partial frame, then resets the connection. */
  let breakBody = false;

  beforeAll(async () => {
    enclave = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ headers: req.headers, body: Buffer.concat(chunks) });
        const usage = 'prompt=50,completion=7,total=57,model=enc-model,cost_usd=0.0001';
        if (breakBody) {
          res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32) });
          res.write(reply.subarray(0, 10));
          setTimeout(() => res.socket?.destroy(), 20);
          return;
        }
        if (String(req.headers.accept).includes('text/event-stream')) {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'ehbp-response-nonce': 'ab'.repeat(32), trailer: 'X-Tinfoil-Usage-Metrics' });
          let i = 0;
          const tick = () => {
            if (i < 7) {
              res.write(reply.subarray(i * 44, (i + 1) * 44));
              i++;
              setTimeout(tick, 5);
            } else {
              res.addTrailers({ 'X-Tinfoil-Usage-Metrics': usage });
              res.end();
            }
          };
          tick();
        } else {
          res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': usage });
          res.end(reply);
        }
      });
    });
    await new Promise<void>((r) => enclave.listen(0, '127.0.0.1', r));
    const port = (enclave.address() as AddressInfo).port;
    g = await startGateway({ enclavePort: port });
    const invite = createInvite(g);
    key = (
      await (
        await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100), invite }) })
      ).json()
    ).key;
  });
  afterAll(async () => {
    await g.close();
    enclave.close();
  });

  const send = (body: Buffer, extra: Record<string, string> = {}) =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'ehbp-encapsulated-key': 'ee'.repeat(32),
        'x-tinfoil-model': 'enc-model',
        'x-tinfoil-max-output-tokens': '100',
        ...extra,
      },
      body: new Uint8Array(body),
    });

  it('forwards ciphertext untouched and bills from the usage header', async () => {
    reply = frames(3);
    const reqBody = frames(5);
    const res = await send(reqBody);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(reply)).toBe(true);
    expect(res.headers.get('ehbp-response-nonce')).toBe('cd'.repeat(32));
    expect(res.headers.get('x-forge-privacy')).toBe('enclave-encrypted');
    const s = seen.at(-1)!;
    expect(s.body.equals(reqBody)).toBe(true);
    expect(s.headers.authorization).toBe('Bearer test-enclave-key'); // client's forge key is not forwarded
    expect(s.headers['x-tinfoil-request-usage-metrics']).toBe('true');
    expect(s.headers['ehbp-encapsulated-key']).toBe('ee'.repeat(32));
    expect(s.headers['x-tinfoil-model']).toBe('enc-model');
    expect(s.headers['x-tinfoil-max-output-tokens']).toBe('100');
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(expectedMsub(50, 7));
  });

  it('streams ciphertext and bills from the HTTP trailer', async () => {
    reply = frames(7);
    const res = await send(frames(2), { accept: 'text/event-stream' });
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(reply)).toBe(true);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
    expect(res.headers.get('x-forge-charged-msub')).toBeNull(); // streamed: settled after the trailer
    const reqId = res.headers.get('x-forge-request-id')!;
    let row: any;
    for (let i = 0; i < 30; i++) {
      row = g.deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(reqId);
      if (row.status === 'settled') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row.usage_source).toBe('tinfoil-metrics');
    expect(row.charged_msub).toBe(expectedMsub(50, 7));
  });

  // The fault this guards against, on the encrypted path: a non-stream enclave body that failed after 200 headers settled as
  // 'partial' (charging the input estimate, or the whole flat schedule) and then threw a bare 502 that
  // carried no charge or change headers.
  describe('non-stream enclave body that fails after 200 headers', () => {
    const tinfoilCfg = () => g.deps.config.catalog.suppliers.tinfoil as any;
    /** Runs fn with the enclave body broken and, when asked, the enclave supplier priced flat. */
    const broken = async <T,>(fn: () => Promise<T>, opts: { flat?: boolean } = {}): Promise<T> => {
      const cfg = tinfoilCfg();
      const saved = { pricing: cfg.pricing, flat: cfg.flat };
      if (opts.flat) Object.assign(cfg, { pricing: 'flat', flat: { buckets: [{ maxBytes: 1_000_000, usd: 0.1 }], output_usd_per_mtok: 0 } });
      reply = frames(3);
      breakBody = true;
      try {
        return await fn();
      } finally {
        breakBody = false;
        Object.assign(cfg, saved);
      }
    };

    it('a balance request on a flat-priced enclave is not charged and its reservation is released', async () => {
      const account = g.deps.ledger.findByKey(key)!;
      const before = g.deps.ledger.get(account.id)!.balance_msub;
      const res = await broken(() => send(frames(2)), { flat: true });
      expect(res.status).toBe(502);
      const body = await res.json();
      expect(body.error.code).toBe('upstream_error');
      expect(body.error.message).toMatch(/not charged/);
      expect(res.headers.get('x-forge-charged-msub')).toBe('0');
      expect(res.headers.get('x-forge-balance-msub')).toBe(String(before));
      const row: any = g.deps.db.prepare('SELECT status, charged_msub FROM requests WHERE id = ?').get(res.headers.get('x-forge-request-id'));
      expect(row).toEqual({ status: 'failed', charged_msub: 0 });
      expect(g.deps.ledger.reservedMsub(account.id)).toBe(0);
      expect(g.deps.ledger.get(account.id)!.balance_msub).toBe(before);
    });

    for (const flat of [true, false]) {
      it(`a NUT-24 request (${flat ? 'flat' : 'metered'} enclave) returns its full change in the reply and at the change URL`, async () => {
        const invite = createInvite(g);
        const token = await mintToken(MINT_A, 'usd', 30);
        const res = await broken(
          () =>
            fetch(`${g.url}/v1/chat/completions`, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'ehbp-encapsulated-key': 'ee'.repeat(32),
                'x-tinfoil-model': 'enc-model',
                'x-tinfoil-max-output-tokens': '100',
                'X-Forge-Invite': invite,
                'X-Cashu': token,
              },
              body: new Uint8Array(frames(2)),
            }),
          { flat },
        );
        expect(res.status).toBe(502);
        expect(res.headers.get('x-forge-charged-msub')).toBe('0');
        const requestId = res.headers.get('x-forge-request-id')!;
        const row: any = g.deps.db.prepare('SELECT status, charged_msub, change_units FROM requests WHERE id = ?').get(requestId);
        expect(row).toEqual({ status: 'failed', charged_msub: 0, change_units: 30 });
        const change = res.headers.get('x-cashu-change')!;
        expect(change).toMatch(/^cashu/);
        const again = await fetch(`${g.url}/v1/change/${requestId}`);
        expect(again.status).toBe(200);
        expect((await again.json()).token).toBe(change);
        expect(await redeem(change)).toBe(30);
      });
    }
  });

  it('refuses enclave URLs outside the allowlist', async () => {
    const res = await send(frames(1), { 'x-tinfoil-enclave-url': 'https://evil.example.com' });
    expect(res.status).toBe(400);
  });

  it('refuses max output above the model cap', async () => {
    const res = await send(frames(1), { 'x-tinfoil-max-output-tokens': '100000' });
    expect(res.status).toBe(400);
  });
});
