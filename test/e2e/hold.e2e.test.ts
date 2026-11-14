// The funds hold (owner decision 1, 2026-11-14): a metered supplier that reports usage holds the model's
// own metered worst case (input estimate plus max output at the model's price, with markup). Its flat
// schedule no longer drives the hold, and a response without a usage count is charged that metered worst
// case, never more than the hold. Live evidence: gpt-oss-120b at 4096 output held about 156 sat for a
// question charged about 0.1 sat, because the hold took the larger of the metered and flat figures.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BTC_USD, createInvite, type Gateway, MINT_A, mintToken, mintsUp, startGateway } from './helpers.ts';

const up = await mintsUp();
const { holdMsub }: any = await import('../../public/v2/core/price.js' as string);

/** The production Tinfoil flat schedule (config/models.json), which used to drive the hold. */
const PROD_FLAT = {
  buckets: [
    { maxBytes: 8192, usd: 0.002 },
    { maxBytes: 65536, usd: 0.01 },
    { maxBytes: 1000000, usd: 0.05 },
  ],
  output_usd_per_mtok: 20,
};

/** EHBP-shaped body: [4-byte BE length][bytes] frames standing in for ciphertext. */
function frames(n: number, size = 40): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(size);
    parts.push(len, randomBytes(size));
  }
  return Buffer.concat(parts);
}

/** The metered worst case in msub at markup 1: ceil(bytes / 2) input tokens plus maxOut at 0.15 and 0.6 USD/M. */
function meteredWorstMsub(bytes: number, maxOut: number, unit: 'usd' | 'sat'): number {
  const nano = Math.ceil(bytes / 2) * 150 + maxOut * 600;
  return unit === 'usd' ? Math.ceil(nano / 10_000) : Math.ceil((nano * 100) / BTC_USD);
}

describe.skipIf(!up)('funds hold: the metered worst case (fake enclave)', () => {
  let enclave: http.Server;
  let g: Gateway;
  /** When false, the enclave answers without a usage count (no metrics header, no usage object). */
  let withUsage = true;
  const reply = frames(3);

  beforeAll(async () => {
    enclave = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const usage = 'prompt=50,completion=7,total=57,model=enc-model,cost_usd=0.0000001';
        if (req.headers['ehbp-encapsulated-key']) {
          res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), ...(withUsage ? { 'x-tinfoil-usage-metrics': usage } : {}) });
          res.end(reply);
          return;
        }
        const body = { id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }] };
        if (withUsage) Object.assign(body, { usage: { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 } });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((r) => enclave.listen(0, '127.0.0.1', r));
    const port = (enclave.address() as AddressInfo).port;
    g = await startGateway({
      enclavePort: port,
      env: { FORGE_UNITS: 'usd,sat' },
      editCatalog: (cat) => {
        Object.assign(cat.suppliers.tinfoil, { pricing: 'metered', flat: PROD_FLAT });
        const m = cat.models.find((x: any) => x.id === 'tinfoil/enc-model');
        Object.assign(m, { input_usd_per_mtok: 0.15, output_usd_per_mtok: 0.6, max_output_tokens: 8192 });
      },
    });
  });
  afterAll(async () => {
    await g.close();
    enclave.close();
  });

  /** A balance of `cents` usd cents. */
  const balance = async (cents: number) => {
    const r = await fetch(`${g.url}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', cents), invite: createInvite(g) }),
    });
    return (await r.json()).key as string;
  };
  const sendEncrypted = (key: string, body: Buffer, maxOut = 4096) =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'ehbp-encapsulated-key': 'ee'.repeat(32),
        'x-tinfoil-model': 'enc-model',
        'x-tinfoil-max-output-tokens': String(maxOut),
      },
      body: new Uint8Array(body),
    });
  const row = (id: string) => g.deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as any;

  it('a balance just above the metered worst case is not refused (the flat schedule no longer drives the hold)', async () => {
    const body = frames(5);
    const worst = meteredWorstMsub(body.length, 4096, 'usd');
    // The flat schedule at 4096 output would hold 8,392 msub (8.4 cents); the metered worst case is under 1 cent.
    expect(worst).toBeLessThan(1000);
    const key = await balance(1);
    const res = await sendEncrypted(key, body);
    expect(res.status).toBe(200);
    const r = row(res.headers.get('x-forge-request-id')!);
    expect(r.reserved_msub).toBe(worst);
    expect(r.usage_source).toBe('tinfoil-metrics');
  });

  it('a response without a usage count is charged the metered worst case, which is the hold', async () => {
    withUsage = false;
    try {
      const body = frames(5);
      const key = await balance(1);
      const res = await sendEncrypted(key, body);
      expect(res.status).toBe(200);
      const r = row(res.headers.get('x-forge-request-id')!);
      expect(r.charged_msub).toBe(meteredWorstMsub(body.length, 4096, 'usd'));
      expect(r.charged_msub).toBe(r.reserved_msub);
      expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(r.reserved_msub);
    } finally {
      withUsage = true;
    }
  });

  it('a plaintext answer without a usage count is charged the metered worst case, never more than the hold', async () => {
    withUsage = false;
    try {
      const key = await balance(1);
      const body = JSON.stringify({ model: 'tinfoil/enc-model', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096 });
      const res = await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body });
      expect(res.status).toBe(200);
      const r = row(res.headers.get('x-forge-request-id')!);
      expect(r.reserved_msub).toBe(meteredWorstMsub(Buffer.byteLength(body), 4096, 'usd'));
      expect(r.charged_msub).toBe(r.reserved_msub);
    } finally {
      withUsage = true;
    }
  });

  it('the NUT-24 quote asks for the metered worst case', async () => {
    const body = frames(5);
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'ehbp-encapsulated-key': 'ee'.repeat(32), 'x-tinfoil-model': 'enc-model', 'x-tinfoil-max-output-tokens': '4096', 'x-forge-unit': 'usd', 'x-forge-invite': createInvite(g) },
      body: new Uint8Array(body),
    });
    expect(res.status).toBe(402);
    const j = await res.json();
    expect(j.error.amount ?? j.amount).toBe(Math.ceil(meteredWorstMsub(body.length, 4096, 'usd') / 1000));
  });

  it("/v1/models gives the app what it needs to compute the gateway's hold exactly", async () => {
    const models = await (await fetch(`${g.url}/v1/models`)).json();
    const m = models.data.find((x: any) => x.id === 'tinfoil/enc-model');
    expect(m.pricing.hold).toBeTruthy();
    for (const unit of ['usd', 'sat'] as const) {
      for (const maxOut of [1, 4096, 8192]) {
        for (const bytes of [10, 220, 9000, 70_000]) {
          expect(holdMsub(m, unit, { bodyBytes: bytes, maxOut, btcUsd: models.btc_usd })).toBe(meteredWorstMsub(bytes, maxOut, unit));
        }
      }
    }
    // And the figure the gateway actually holds for a request matches the app's figure.
    const body = frames(9);
    const key = await balance(1);
    const res = await sendEncrypted(key, body, 2048);
    expect(row(res.headers.get('x-forge-request-id')!).reserved_msub).toBe(holdMsub(m, 'usd', { bodyBytes: body.length, maxOut: 2048 }));
  });
});
