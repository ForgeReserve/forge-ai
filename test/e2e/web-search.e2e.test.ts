// Web search for private models (F6, docs/PAYMENTS.md, Web search). Tinfoil searches from the enclave and
// charges its fee once per request that searched, reported as web_search_calls in X-Tinfoil-Usage-Metrics.
// The gateway cannot read an encrypted body, so the client declares search with X-Forge-Web-Search: 1 and
// the hold takes the fee and the search allowance; a plaintext body is read directly. A search that was
// not declared is charged at most the hold. Against a mock enclave.
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, MINT_A, mintToken, mintsUp, readSse, startGateway } from './helpers.ts';

const up = await mintsUp();
const { holdMsub }: any = await import('../../public/v2/core/price.js' as string);

const FEE_USD = 0.05;
const SEARCH = { request_usd: FEE_USD, extra_input_tokens: 1000, output_factor: 2 };

function frames(n: number, size = 40): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(size);
    parts.push(len, randomBytes(size));
  }
  return Buffer.concat(parts);
}

/** msub (usd, markup 1) for usage at 0.15 and 0.6 USD per million tokens, plus the fee when searched. */
const usd = (inTok: number, outTok: number, searched: boolean) => Math.ceil((inTok * 150 + outTok * 600 + (searched ? FEE_USD * 1e9 : 0)) / 10_000);
/** The hold (usd, markup 1): body bytes / 2 input, maxOut output; with search the allowance and the fee. */
const hold = (bytes: number, maxOut: number, searched: boolean) =>
  searched ? usd(Math.ceil(bytes / 2) + SEARCH.extra_input_tokens, maxOut * SEARCH.output_factor, true) : usd(Math.ceil(bytes / 2), maxOut, false);

describe.skipIf(!up)('web search (mock enclave)', () => {
  let enclave: http.Server;
  let g: Gateway;
  let key: string;
  /** The usage metrics the enclave reports next. */
  let metrics = '';
  const seen: Array<{ headers: http.IncomingHttpHeaders; body: Buffer }> = [];

  beforeAll(async () => {
    enclave = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        seen.push({ headers: req.headers, body });
        if (req.headers['ehbp-encapsulated-key']) {
          res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': metrics });
          res.end(frames(3));
          return;
        }
        const j = JSON.parse(body.toString('utf8'));
        const usage = { prompt_tokens: 50, completion_tokens: 7, total_tokens: 57 };
        if (j.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Found it.' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-tinfoil-usage-metrics': metrics });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Found it.' }, finish_reason: 'stop' }], usage }));
      });
    });
    await new Promise<void>((r) => enclave.listen(0, '127.0.0.1', r));
    g = await startGateway({
      enclavePort: (enclave.address() as AddressInfo).port,
      editCatalog: (cat) => {
        cat.suppliers.tinfoil.web_search = SEARCH;
        Object.assign(
          cat.models.find((x: any) => x.id === 'tinfoil/enc-model'),
          { input_usd_per_mtok: 0.15, output_usd_per_mtok: 0.6, max_output_tokens: 8192, web_search: true },
        );
      },
    });
    const r = await fetch(`${g.url}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 300), invite: createInvite(g) }),
    });
    key = (await r.json()).key;
  });
  afterAll(async () => {
    await g.close();
    enclave.close();
  });

  const row = (id: string) => g.deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as any;
  const encrypted = (body: Buffer, extra: Record<string, string> = {}) =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'ehbp-encapsulated-key': 'ee'.repeat(32), 'x-tinfoil-model': 'enc-model', 'x-tinfoil-max-output-tokens': '4096', ...extra },
      body: new Uint8Array(body),
    });
  const plain = (body: object) => fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const searchBody = (extra: object = {}) => ({
    model: 'tinfoil/enc-model',
    messages: [{ role: 'user', content: 'What is on in town tonight?' }],
    max_tokens: 4096,
    web_search_options: {},
    pii_check_options: {},
    prompt_injection_check_options: {},
    ...extra,
  });

  it('encrypted, declared: the hold takes the fee and the allowance; the fee is charged when the usage shows a search', async () => {
    metrics = 'prompt=50,completion=7,total=57,model=enc-model,web_search_calls=2,cost_usd=0.0500117';
    const body = frames(5);
    const res = await encrypted(body, { 'x-forge-web-search': '1' });
    expect(res.status).toBe(200);
    const r = row(res.headers.get('x-forge-request-id')!);
    expect(r.reserved_msub).toBe(hold(body.length, 4096, true));
    expect(r.charged_msub).toBe(usd(50, 7, true));
    // The declaration stays with the gateway: it is not sent on to the enclave.
    expect(seen.at(-1)!.headers['x-forge-web-search']).toBeUndefined();
  });

  it('encrypted, declared, but the model did not search: no fee', async () => {
    metrics = 'prompt=50,completion=7,total=57,model=enc-model,cost_usd=0.0000117';
    const res = await encrypted(frames(5), { 'x-forge-web-search': '1' });
    expect(row(res.headers.get('x-forge-request-id')!).charged_msub).toBe(usd(50, 7, false));
  });

  it('encrypted, not declared, yet the usage shows a search: charged at most the hold', async () => {
    metrics = 'prompt=50,completion=7,total=57,model=enc-model,web_search_calls=1,cost_usd=0.0500117';
    const body = frames(5);
    const res = await encrypted(body);
    expect(res.status).toBe(200);
    const r = row(res.headers.get('x-forge-request-id')!);
    expect(r.reserved_msub).toBe(hold(body.length, 4096, false));
    expect(r.charged_msub).toBe(r.reserved_msub);
    expect(r.charged_msub).toBeLessThan(usd(50, 7, true));
  });

  it('plaintext: the gateway reads web_search_options itself, sends the body on as it came, and charges the fee the metrics show', async () => {
    metrics = 'prompt=50,completion=7,total=57,model=enc-model,web_search_calls=1,other_cost_usd=0.0002,cost_usd=0.0502117';
    const b = searchBody();
    const res = await plain(b);
    expect(res.status).toBe(200);
    const r = row(res.headers.get('x-forge-request-id')!);
    expect(r.reserved_msub).toBe(hold(Buffer.byteLength(JSON.stringify(b)), 4096, true));
    // Tokens, the search fee, and the privacy filter's fee (other_cost_usd), passed on.
    expect(r.charged_msub).toBe(Math.ceil((50 * 150 + 7 * 600 + FEE_USD * 1e9 + 0.0002 * 1e9) / 10_000));
    const sent = JSON.parse(seen.at(-1)!.body.toString('utf8'));
    expect(sent.web_search_options).toEqual({});
    expect(sent.pii_check_options).toEqual({});
    expect(sent.prompt_injection_check_options).toEqual({});
  });

  it('plaintext stream: the metrics never arrive (an HTTP trailer), so with search on the fee is charged, within the hold', async () => {
    const res = await plain(searchBody({ stream: true }));
    const s = await readSse(res);
    const r = row(s.forge.request_id);
    expect(r.charged_msub).toBe(usd(50, 7, true));
    expect(r.charged_msub).toBeLessThanOrEqual(r.reserved_msub);
  });

  it('a model without web search refuses the switch; /v1/models says which models search, and the app holds the same', async () => {
    const res = await plain({ model: 'mock-echo', messages: [{ role: 'user', content: 'hi' }], web_search_options: {} });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('web_search_unavailable');
    const enc = await encrypted(frames(2), { 'x-forge-web-search': '1', 'x-tinfoil-model': 'enc-model' });
    expect(enc.status).toBe(200);

    const models = await (await fetch(`${g.url}/v1/models`)).json();
    const m = models.data.find((x: any) => x.id === 'tinfoil/enc-model');
    expect(m.capabilities.web_search).toBe(true);
    expect(models.data.find((x: any) => x.id === 'mock-echo').capabilities.web_search).toBe(false);
    expect(m.pricing.hold.web_search).toEqual({ nano_usd: FEE_USD * 1e9, extra_input_tokens: 1000, output_factor: 2 });
    const body = frames(7);
    const r = await encrypted(body, { 'x-forge-web-search': '1' });
    expect(row(r.headers.get('x-forge-request-id')!).reserved_msub).toBe(holdMsub(m, 'usd', { bodyBytes: body.length, maxOut: 4096, search: true }));
  });
});
