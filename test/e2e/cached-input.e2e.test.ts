// Cached input (docs/PAYMENTS.md, Cached input). Tinfoil serves a repeated prompt prefix from its cache and
// bills those input tokens at a lower published rate; it reports them as usage.prompt_tokens_details.cached_tokens
// in the body and as cached_prompt_tokens in X-Tinfoil-Usage-Metrics. The gateway holds the full input price
// and charges the cached tokens at the model's cached_input_usd_per_mtok, so the unused hold returns, as
// change or to the balance, exactly as any other unused hold does. Against a stub Tinfoil.
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setLogSilent } from '../../src/log.ts';
import { createInvite, type Gateway, MINT_A, mintToken, mintsUp, readSse, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();
const TOKEN = 'e2e-admin-token-' + randomBytes(8).toString('hex');

/** USD per million tokens, as the stub prices them (and the catalog lists them). */
const PRICES: Record<string, { input: number; cached?: number; output: number }> = {
  'enc-model': { input: 100, cached: 10, output: 1000 },
  'enc-nocache': { input: 100, output: 1000 },
};
/** nano-USD at markup 1: uncached input, cached input and output at the model's prices. */
const nano = (model: string, prompt: number, cached: number, out: number) => {
  const p = PRICES[model]!;
  return (prompt - cached) * p.input * 1000 + cached * (p.cached ?? p.input) * 1000 + out * p.output * 1000;
};
/** msub on a usd balance (1 msub = 10,000 nano-USD), rounded up. */
const msub = (n: number) => Math.ceil(n / 10_000);

function frames(n: number, size = 40): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < n; i++) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(size);
    parts.push(len, randomBytes(size));
  }
  return Buffer.concat(parts);
}

/** What the stub reports for the next request. */
interface Next {
  prompt: number;
  completion: number;
  /** The body's prompt_tokens_details.cached_tokens; undefined leaves the details out. */
  cached?: unknown;
  /** false: leave cached_prompt_tokens out of X-Tinfoil-Usage-Metrics (Tinfoil's router sends it with the details). */
  metrics?: boolean;
  /** false: leave prompt_tokens_details out of the body, so only the metrics carry the count. */
  body?: boolean;
  /** cost_usd as if every input token were billed at the full price (a supplier figure the catalog disagrees with). */
  costAtFull?: boolean;
  /** The metrics' cached_prompt_tokens when it differs from the body's count. */
  metricsCached?: number;
  /** Cut the connection: a plaintext stream before or after its usage chunk, an encrypted stream before its trailer. */
  cut?: 'before-usage' | 'after-usage' | 'encrypted';
}

describe.skipIf(!up)('cached input (stub Tinfoil)', () => {
  let enclave: http.Server;
  let g: Gateway;
  /** The same catalog at FORGE_MARKUP=1.25. */
  let g125: Gateway;
  let next: Next = { prompt: 1000, completion: 20 };

  /** Tinfoil's X-Tinfoil-Usage-Metrics for the next request, cost_usd at its published rates. */
  const metricsFor = (model: string): string => {
    const reported = next.metricsCached ?? next.cached;
    const cached = typeof reported === 'number' ? Math.min(next.prompt, Math.max(0, reported)) : undefined;
    let s = `prompt=${next.prompt},completion=${next.completion},total=${next.prompt + next.completion}`;
    if (next.metrics !== false && cached !== undefined) s += `,cached_prompt_tokens=${cached},uncached_prompt_tokens=${next.prompt - cached}`;
    const cost = nano(model, next.prompt, next.costAtFull ? 0 : (cached ?? 0), next.completion);
    return `${s},model=${model},cost_usd=${(cost / 1e9).toFixed(9).replace(/0+$/, '')}`;
  };

  beforeAll(async () => {
    enclave = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        if (req.headers['ehbp-encapsulated-key']) {
          const model = String(req.headers['x-tinfoil-model']);
          if (String(req.headers.accept).includes('text/event-stream')) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'ehbp-response-nonce': 'ab'.repeat(32), trailer: 'X-Tinfoil-Usage-Metrics' });
            res.write(frames(3));
            if (next.cut === 'encrypted') {
              setTimeout(() => res.socket?.destroy(), 30);
              return;
            }
            res.addTrailers({ 'X-Tinfoil-Usage-Metrics': metricsFor(model) });
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': metricsFor(model) });
          res.end(frames(3));
          return;
        }
        const j = JSON.parse(body.toString('utf8'));
        const usage: Record<string, unknown> = { prompt_tokens: next.prompt, completion_tokens: next.completion, total_tokens: next.prompt + next.completion };
        if (next.cached !== undefined && next.body !== false) usage.prompt_tokens_details = { cached_tokens: next.cached };
        if (j.stream) {
          // A plaintext stream: the usage chunk carries the cached count; the metrics come in a trailer
          // the gateway's fetch cannot read, so none are sent here.
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello again.' } }] })}\n\n`);
          if (next.cut === 'before-usage') {
            setTimeout(() => res.socket?.destroy(), 30);
            return;
          }
          res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
          if (next.cut === 'after-usage') {
            setTimeout(() => res.socket?.destroy(), 30);
            return;
          }
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', 'x-tinfoil-usage-metrics': metricsFor(j.model) });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello again.' }, finish_reason: 'stop' }], usage }));
      });
    });
    await new Promise<void>((r) => enclave.listen(0, '127.0.0.1', r));
    const editCatalog = (cat: any) => {
      Object.assign(
        cat.models.find((x: any) => x.id === 'tinfoil/enc-model'),
        { cached_input_usd_per_mtok: PRICES['enc-model']!.cached },
      );
      cat.models.push({ ...cat.models.find((x: any) => x.id === 'tinfoil/enc-model'), id: 'tinfoil/enc-nocache', upstream: 'enc-nocache', cached_input_usd_per_mtok: undefined });
    };
    const enclavePort = (enclave.address() as AddressInfo).port;
    g = await startGateway({
      enclavePort,
      env: { FORGE_ADMIN_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'), FORGE_ADMIN_RATE_LIMIT_RPM: '100000' },
      editCatalog,
    });
    g125 = await startGateway({ enclavePort, env: { FORGE_MARKUP: '1.25' }, editCatalog });
  });
  afterAll(async () => {
    await g.close();
    await g125.close();
    enclave.close();
  });

  const row = (id: string) => g.deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(id) as any;
  /** Waits for a request that settles after its stream has ended. */
  const settledRow = async (id: string) => {
    for (let i = 0; i < 100; i++) {
      const r = row(id);
      if (r?.status === 'settled' || r?.status === 'failed') return r;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error(`request ${id} never settled`);
  };
  // A body of about 4,000 bytes holds about 2,000 input tokens, more than the 1,000 the stub reports.
  const plainBody = (model: string, extra: object = {}) => ({ model, messages: [{ role: 'user', content: 'x'.repeat(4000) }], max_tokens: 64, ...extra });
  const balance = async (cents: number): Promise<string> => {
    const r = await fetch(`${g.url}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', cents), invite: createInvite(g) }),
    });
    return (await r.json()).key;
  };
  const balanceMsub = async (key: string) => (await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json()).balance_msub as number;
  const plain = (key: string, body: object) => fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(body) });
  const encrypted = (key: string, model: string, accept = 'application/json') =>
    fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept, 'ehbp-encapsulated-key': 'ee'.repeat(32), 'x-tinfoil-model': model, 'x-tinfoil-max-output-tokens': '64' },
      body: new Uint8Array(randomBytes(4000)),
    });

  it('balance, plaintext: cached tokens at the cached price, the rest of the hold back on the balance', async () => {
    const key = await balance(100);
    const before = await balanceMsub(key);
    next = { prompt: 1000, completion: 20, cached: 800 };
    const res = await plain(key, plainBody('tinfoil/enc-model'));
    expect(res.status).toBe(200);
    const j = await res.json();
    // The usage the supplier sent reaches the client as it came, cached count included.
    expect(j.usage.prompt_tokens_details).toEqual({ cached_tokens: 800 });
    const r = row(res.headers.get('x-forge-request-id')!);
    // 200 uncached at 100, 800 cached at 10, 20 out at 1000 USD per million: 4,800 msub, against 12,000 at the full price.
    expect(r.charged_msub).toBe(4800);
    expect(r.charged_msub).toBe(msub(nano('enc-model', 1000, 800, 20)));
    expect(r.cached_input_tokens).toBe(800);
    expect(r.input_tokens).toBe(1000);
    expect(r.price_nusd).toBe(nano('enc-model', 1000, 800, 20));
    // The hold is the full input price, so the cached saving is returned with the rest of the hold.
    expect(r.reserved_msub).toBeGreaterThan(12_000);
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(4800);
    expect(await balanceMsub(key)).toBe(before - 4800);
    expect(g.deps.ledger.reservedMsub(g.deps.ledger.findByKey(key)!.id)).toBe(0);
    // The supplier's cost (Tinfoil's cost_usd) is the same figure at markup 1.
    expect(r.cost_source).toBe('supplier');
    expect(r.supplier_cost_nusd).toBe(r.price_nusd);
  });

  it('balance, plaintext: the cached count from the usage metrics when the body has none', async () => {
    const key = await balance(100);
    next = { prompt: 1000, completion: 20, cached: 800, body: false };
    let res = await plain(key, plainBody('tinfoil/enc-model'));
    expect((await res.json()).usage.prompt_tokens_details).toBeUndefined();
    let r = row(res.headers.get('x-forge-request-id')!);
    expect(r.charged_msub).toBe(4800);
    expect(r.cached_input_tokens).toBe(800);
    // A count that is not a number, in the body and so not in the metrics either, is no cached tokens.
    next = { prompt: 1000, completion: 20, cached: 'eight hundred' };
    res = await plain(key, plainBody('tinfoil/enc-model'));
    r = row(res.headers.get('x-forge-request-id')!);
    expect(r.charged_msub).toBe(12_000);
    expect(r.cached_input_tokens).toBe(0);
  });

  it('a supplier that reports no cached tokens is charged exactly as before', async () => {
    const key = await balance(100);
    next = { prompt: 1000, completion: 20 };
    const res = await plain(key, plainBody('tinfoil/enc-model'));
    const r = row(res.headers.get('x-forge-request-id')!);
    expect(r.charged_msub).toBe(12_000);
    expect(r.charged_msub).toBe(msub(1000 * 100 * 1000 + 20 * 1000 * 1000));
    expect(r.cached_input_tokens).toBe(0);
  });

  it('a model with no cached price charges cached tokens at the input price', async () => {
    const key = await balance(100);
    next = { prompt: 1000, completion: 20, cached: 800 };
    const res = await plain(key, plainBody('tinfoil/enc-nocache'));
    const r = row(res.headers.get('x-forge-request-id')!);
    expect(r.charged_msub).toBe(12_000);
    expect(r.cached_input_tokens).toBe(800);
    expect(r.supplier_cost_nusd).toBe(r.price_nusd);
  });

  it('a cached count above the input tokens counts as all of them; a negative one as none', async () => {
    const key = await balance(100);
    next = { prompt: 1000, completion: 20, cached: 5000 };
    let res = await plain(key, plainBody('tinfoil/enc-model'));
    let r = row(res.headers.get('x-forge-request-id')!);
    expect(r.cached_input_tokens).toBe(1000);
    expect(r.charged_msub).toBe(msub(nano('enc-model', 1000, 1000, 20)));
    next = { prompt: 1000, completion: 20, cached: -50, metrics: false };
    res = await plain(key, plainBody('tinfoil/enc-model'));
    r = row(res.headers.get('x-forge-request-id')!);
    expect(r.cached_input_tokens).toBe(0);
    expect(r.charged_msub).toBe(12_000);
  });

  it('balance, plaintext stream: the usage chunk carries the cached count; the client sees it when it asked', async () => {
    const key = await balance(100);
    const before = await balanceMsub(key);
    next = { prompt: 1000, completion: 20, cached: 800 };
    const res = await plain(key, plainBody('tinfoil/enc-model', { stream: true, stream_options: { include_usage: true } }));
    const { data, forge } = await readSse(res);
    expect(data.find((d) => d.usage)?.usage.prompt_tokens_details).toEqual({ cached_tokens: 800 });
    expect(forge.charged_msub).toBe(4800);
    const r = row(forge.request_id);
    expect(r.cached_input_tokens).toBe(800);
    // No metrics on a plaintext stream: our cost is the usage at catalog cost, cached input at its price.
    expect(r.cost_source).toBe('catalog');
    expect(r.supplier_cost_nusd).toBe(r.price_nusd);
    expect(await balanceMsub(key)).toBe(before - 4800);
  });

  it('balance, encrypted: the cached count from the metrics header, and from the trailer of a stream', async () => {
    const key = await balance(100);
    next = { prompt: 1000, completion: 20, cached: 800 };
    let res = await encrypted(key, 'enc-model');
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    let r = row(res.headers.get('x-forge-request-id')!);
    expect(r.usage_source).toBe('tinfoil-metrics');
    expect(r.charged_msub).toBe(4800);
    expect(r.cached_input_tokens).toBe(800);
    expect(r.supplier_cost_nusd).toBe(r.price_nusd);
    res = await encrypted(key, 'enc-model', 'text/event-stream');
    await res.arrayBuffer();
    r = await settledRow(res.headers.get('x-forge-request-id')!);
    expect(r.charged_msub).toBe(4800);
    expect(r.cached_input_tokens).toBe(800);
    expect(g.deps.ledger.reservedMsub(g.deps.ledger.findByKey(key)!.id)).toBe(0);
  });

  it('NUT-24: the cached saving comes back as change', async () => {
    const invite = createInvite(g);
    next = { prompt: 1000, completion: 20, cached: 800 };
    const token = await mintToken(MINT_A, 'usd', 30);
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-invite': invite, 'x-cashu': token },
      body: JSON.stringify(plainBody('tinfoil/enc-model')),
    });
    expect(res.status).toBe(200);
    // 4,800 msub is 4.8 cents, charged as 5 whole cents; 25 of the 30 come back.
    expect(Number(res.headers.get('x-forge-charged-msub'))).toBe(5000);
    expect(await redeem(res.headers.get('x-cashu-change')!)).toBe(25);
    expect(row(res.headers.get('x-forge-request-id')!).change_units).toBe(25);
  });

  it('NUT-24 stream: the change in the forge event; with no cached tokens, the change is as before', async () => {
    const invite = createInvite(g);
    next = { prompt: 1000, completion: 20, cached: 800 };
    let res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-invite': invite, 'x-cashu': await mintToken(MINT_A, 'usd', 30) },
      body: JSON.stringify(plainBody('tinfoil/enc-model', { stream: true })),
    });
    let { forge } = await readSse(res);
    expect(forge.charged_msub).toBe(5000);
    expect(await redeem(forge.change)).toBe(25);
    next = { prompt: 1000, completion: 20 };
    res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-invite': createInvite(g), 'x-cashu': await mintToken(MINT_A, 'usd', 30) },
      body: JSON.stringify(plainBody('tinfoil/enc-model', { stream: true })),
    });
    ({ forge } = await readSse(res));
    expect(forge.charged_msub).toBe(12_000);
    expect(await redeem(forge.change)).toBe(18);
  });

  it('GET /v1/models lists the cached price where a model has one', async () => {
    const m = (await (await fetch(`${g.url}/v1/models`)).json()).data as any[];
    const cached = m.find((x) => x.id === 'tinfoil/enc-model').pricing;
    expect(cached.usd_per_mtok).toEqual({ input: 100, output: 1000, cached_input: 10 });
    // $10 per million at $100,000 per bitcoin is 10,000 sat per million.
    expect(cached.sat_per_mtok.cached_input).toBe(10_000);
    // The hold stays at the full input price.
    expect(cached.hold.input_nano_usd_per_token).toBe(100_000);
    expect(m.find((x) => x.id === 'tinfoil/enc-nocache').pricing.usd_per_mtok).toEqual({ input: 100, output: 1000 });
  });

  it('admin costs at markup 1: what people paid equals what the supplier cost, cached requests included', async () => {
    const c = (await (await fetch(`${g.url}/admin/api/costs`, { headers: { 'X-Forge-Admin-Token': TOKEN } })).json()) as any;
    expect(c.markup).toBe(1);
    const m = c.models.find((x: any) => x.model === 'tinfoil/enc-model');
    expect(m.cached_input_tokens).toBeGreaterThan(0);
    expect(m.catalog.cached_input).toBe(10);
    expect(m.cost_nusd).toBe(m.price_nusd);
    for (const x of c.models) expect(x.cost_nusd - x.price_nusd).toBe(0);
    // The fit takes cached input out at its own price, so cache hits do not read as a cheaper input price.
    expect(m.derived).not.toBeNull();
    expect(m.derived.input).toBeCloseTo(100, 6);
    expect(m.derived.output).toBeCloseTo(1000, 6);
    expect(m.drift).toBe(false);
    const o = (await (await fetch(`${g.url}/admin/api/overview`, { headers: { 'X-Forge-Admin-Token': TOKEN } })).json()) as any;
    for (const w of Object.values(o.windows) as any[]) expect(w.total.margin_msub.usd).toBe(0);
    const reqs = (await (await fetch(`${g.url}/admin/api/requests?limit=5`, { headers: { 'X-Forge-Admin-Token': TOKEN } })).json()) as any;
    expect(reqs.data.some((x: any) => x.cached_input_tokens === 800)).toBe(true);
    // Settings lists the cached price in usd and sat, cost and sale, and null on a model without one.
    const st = (await (await fetch(`${g.url}/admin/api/settings`, { headers: { 'X-Forge-Admin-Token': TOKEN } })).json()) as any;
    const sm = st.models.find((x: any) => x.id === 'tinfoil/enc-model');
    expect(sm.cost_usd_per_mtok.cached_input).toBe(10);
    expect(sm.price_usd_per_mtok.cached_input).toBe(10);
    // $10 per million at $100,000 per bitcoin is 10,000 sat per million.
    expect(sm.price_sat_per_mtok.cached_input).toBe(10_000);
    const none = st.models.find((x: any) => x.id === 'tinfoil/enc-nocache');
    expect([none.cost_usd_per_mtok.cached_input, none.price_usd_per_mtok.cached_input, none.price_sat_per_mtok.cached_input]).toEqual([null, null, null]);
  });

  /** Runs fn with the gateway's warning lines captured; returns them parsed. */
  const warnings = async (fn: () => Promise<void>): Promise<any[]> => {
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => (lines.push(String(chunk)), true));
    setLogSilent(false);
    try {
      await fn();
    } finally {
      setLogSilent(process.env.FORGE_TEST_LOGS !== '1');
      spy.mockRestore();
    }
    return lines.map((l) => JSON.parse(l));
  };

  it('plaintext: the metrics count is charged when both carry one; the body count only when the metrics carry none', async () => {
    const key = await balance(200);
    const charge = async (n: Next) => {
      next = n;
      const res = await plain(key, plainBody('tinfoil/enc-model'));
      await res.json();
      return row(res.headers.get('x-forge-request-id')!);
    };
    let r: any;
    let w = await warnings(async () => {
      // Both, equal.
      r = await charge({ prompt: 1000, completion: 20, cached: 800 });
    });
    expect([r.cached_input_tokens, r.charged_msub]).toEqual([800, msub(nano('enc-model', 1000, 800, 20))]);
    expect(w.filter((l) => l.msg === 'cached_tokens_differ')).toEqual([]);
    // Both, the metrics lower than the body: the metrics count is charged, and the difference logged.
    w = await warnings(async () => {
      r = await charge({ prompt: 1000, completion: 20, cached: 800, metricsCached: 600 });
    });
    expect([r.cached_input_tokens, r.charged_msub]).toEqual([600, msub(nano('enc-model', 1000, 600, 20))]);
    expect(w.filter((l) => l.msg === 'cached_tokens_differ')).toEqual([
      expect.objectContaining({ request_id: r.id, model: 'tinfoil/enc-model', body_cached_tokens: 800, metrics_cached_tokens: 600 }),
    ]);
    // Both, the metrics higher than the body.
    w = await warnings(async () => {
      r = await charge({ prompt: 1000, completion: 20, cached: 300, metricsCached: 900 });
    });
    expect([r.cached_input_tokens, r.charged_msub]).toEqual([900, msub(nano('enc-model', 1000, 900, 20))]);
    expect(w.find((l) => l.msg === 'cached_tokens_differ')).toMatchObject({ body_cached_tokens: 300, metrics_cached_tokens: 900 });
    // Only the body.
    r = await charge({ prompt: 1000, completion: 20, cached: 700, metrics: false });
    expect([r.cached_input_tokens, r.charged_msub]).toEqual([700, msub(nano('enc-model', 1000, 700, 20))]);
    // Only the metrics.
    r = await charge({ prompt: 1000, completion: 20, cached: 400, body: false });
    expect([r.cached_input_tokens, r.charged_msub]).toEqual([400, msub(nano('enc-model', 1000, 400, 20))]);
    // Neither.
    r = await charge({ prompt: 1000, completion: 20 });
    expect([r.cached_input_tokens, r.charged_msub]).toEqual([0, 12_000]);
    // The metrics count is bounded to the input tokens too.
    r = await charge({ prompt: 1000, completion: 20, cached: 100, metricsCached: 4000 });
    expect([r.cached_input_tokens, r.charged_msub]).toEqual([1000, msub(nano('enc-model', 1000, 1000, 20))]);
  });

  it('at FORGE_MARKUP=1.25: the exact charge with cached tokens', async () => {
    const r0 = await fetch(`${g125.url}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100), invite: createInvite(g125) }),
    });
    const key = (await r0.json()).key;
    next = { prompt: 1000, completion: 20, cached: 800 };
    const res = await fetch(`${g125.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(plainBody('tinfoil/enc-model')) });
    expect(res.status).toBe(200);
    const r = g125.deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(res.headers.get('x-forge-request-id')!) as any;
    // 125,000 nano-USD per uncached input token, 12,500 per cached one, 1,250,000 per output token:
    // 200 * 125,000 + 800 * 12,500 + 20 * 1,250,000 = 60,000,000 nano-USD, 6,000 msub (15,000 at the full price).
    expect(r.price_nusd).toBe(60_000_000);
    expect(r.charged_msub).toBe(6000);
    expect(r.cached_input_tokens).toBe(800);
    // Our cost is Tinfoil's figure, at its own (markup 1) prices.
    expect(r.supplier_cost_nusd).toBe(nano('enc-model', 1000, 800, 20));
    const m = ((await (await fetch(`${g125.url}/v1/models`)).json()).data as any[]).find((x) => x.id === 'tinfoil/enc-model');
    expect(m.pricing.usd_per_mtok).toEqual({ input: 125, output: 1250, cached_input: 12.5 });
  });

  it('a stream cut off before its usage is charged the full-price estimate, as before', async () => {
    const key = await balance(100);
    // Plaintext: the cached count was in the usage chunk that never came.
    next = { prompt: 1000, completion: 20, cached: 800, cut: 'before-usage' };
    const body = plainBody('tinfoil/enc-model', { stream: true });
    let res = await plain(key, body);
    let { forge } = await readSse(res);
    expect(forge.partial).toBe(true);
    let r = row(forge.request_id);
    // Input estimated as body bytes / 4 at the input price; one content chunk of 12 characters is 3 tokens out.
    const estIn = Math.ceil(Buffer.byteLength(JSON.stringify(body)) / 4);
    expect([r.usage_source, r.cached_input_tokens, r.charged_msub]).toEqual(['estimate', 0, msub(estIn * 100_000 + 3 * 1_000_000)]);
    // Encrypted: the cached count was in the trailer that never came.
    next = { prompt: 1000, completion: 20, cached: 800, cut: 'encrypted' };
    res = await encrypted(key, 'enc-model', 'text/event-stream');
    await res.arrayBuffer().catch(() => undefined);
    r = await settledRow(res.headers.get('x-forge-request-id')!);
    // 4,000 bytes / 4 = 1,000 input tokens at the input price, and 3 frames out.
    expect([r.usage_source, r.cached_input_tokens, r.charged_msub]).toEqual(['estimate', 0, msub(1000 * 100_000 + 3 * 1_000_000)]);
  });

  it('a plaintext stream cut off after its usage chunk is charged that usage, cached input at the cached price', async () => {
    const key = await balance(100);
    next = { prompt: 1000, completion: 20, cached: 800, cut: 'after-usage' };
    const res = await plain(key, plainBody('tinfoil/enc-model', { stream: true }));
    const { forge } = await readSse(res);
    expect(forge.partial).toBe(true);
    const r = row(forge.request_id);
    expect([r.usage_source, r.cached_input_tokens, r.charged_msub]).toEqual(['upstream', 800, 4800]);
  });

  // Last: the request it makes on purpose has a supplier cost above the price, which the costs test above would count.
  it("logs supplier_cost_differs when the supplier's cost disagrees with the catalog, and not when it agrees", async () => {
    const key = await balance(100);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => (lines.push(String(chunk)), true));
    setLogSilent(false);
    try {
      next = { prompt: 1000, completion: 20, cached: 800 };
      await (await plain(key, plainBody('tinfoil/enc-model'))).json();
      expect(lines.filter((l) => l.includes('supplier_cost_differs'))).toEqual([]);
      next = { prompt: 1000, completion: 20, cached: 800, costAtFull: true };
      const res = await plain(key, plainBody('tinfoil/enc-model'));
      await res.json();
      // Still charged at the catalog's cached price; the difference is logged for the operator.
      expect(row(res.headers.get('x-forge-request-id')!).charged_msub).toBe(4800);
      const warn = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'supplier_cost_differs');
      expect(warn).toMatchObject({ model: 'tinfoil/enc-model', supplier_cost_nusd: 120_000_000, catalog_cost_nusd: 48_000_000, input_tokens: 1000, cached_input_tokens: 800, output_tokens: 20 });
    } finally {
      setLogSilent(process.env.FORGE_TEST_LOGS !== '1');
      spy.mockRestore();
    }
  });
});
