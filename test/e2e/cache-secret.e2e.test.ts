// The Tinfoil prompt cache, kept to one payer (docs/PRIVACY.md, Prompt caching). Tinfoil's router shares a
// cache between requests with the same API identity and user_cache_secret, and the gateway sends every
// request under its one key. So a plaintext request to a Tinfoil model carries the payer's own secret:
// the balance's (stable, from the wallet seed) or, for NUT-24, a fresh one. Against a stub Tinfoil that
// records what reaches it, and an OpenAI-compatible stub supplier that must see the body as before.
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setLogSilent } from '../../src/log.ts';
import { holdNanoUsd, nanoUsdToMsub } from '../../src/pricing.ts';
import { createInvite, creditMintUp, type Gateway, MINT_A, MINT_CREDIT, mintToken, mintsUp, readSse, startGateway } from './helpers.ts';

const up = await mintsUp();
const creditUp = up && (await creditMintUp());

/** One request as it reached a stub. */
interface Seen {
  path: string;
  headers: http.IncomingHttpHeaders;
  raw: Buffer;
  json?: any;
}

describe.skipIf(!up)('Tinfoil cache secret (stub Tinfoil)', () => {
  let stub: http.Server;
  let port: number;
  const seen: Seen[] = [];
  /** 'echo-error': answer 400 with an error message that quotes the body's user_cache_secret. */
  let mode: 'ok' | 'echo-error' = 'ok';
  let g: Gateway;
  /** Extra gateways a test starts; closed at the end. */
  const others: Gateway[] = [];

  const editCatalog = (cat: any) => {
    const tin = cat.models.find((x: any) => x.id === 'tinfoil/enc-model');
    // An OpenAI-compatible supplier on the same stub, at the same prices: the body it gets must not change.
    cat.suppliers.other = { type: 'openai', tier: 'standard', baseUrl: `http://127.0.0.1:${port}/other/v1`, apiKeyEnv: 'TEST_TINFOIL_KEY' };
    cat.models.push({ ...tin, id: 'plainai/enc-model', supplier: 'other' });
    // A free model on Tinfoil: served on a balance key, held and charged nothing.
    cat.models.push({ id: 'tinfoil/free-model', supplier: 'tinfoil', upstream: 'free-model', pricing: 'free', free_reason: 'e2e', max_output_tokens: 256 });
  };

  beforeAll(async () => {
    stub = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks);
        const s: Seen = { path: req.url ?? '', headers: req.headers, raw };
        seen.push(s);
        const usage = { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020 };
        if (req.headers['ehbp-encapsulated-key']) {
          res.writeHead(200, { 'content-type': 'application/json', 'ehbp-response-nonce': 'cd'.repeat(32), 'x-tinfoil-usage-metrics': 'prompt=1000,completion=20,total=1020' });
          res.end(randomBytes(40));
          return;
        }
        s.json = JSON.parse(raw.toString('utf8'));
        if (mode === 'echo-error') {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { message: `bad request carrying ${s.json.user_cache_secret}` } }));
          return;
        }
        if (s.json.stream) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hello.' } }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`);
          res.end('data: [DONE]\n\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }], usage }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', r));
    port = (stub.address() as AddressInfo).port;
    g = await startGateway({ enclavePort: port, editCatalog });
  });
  afterAll(async () => {
    await g.close();
    for (const o of others) await o.close().catch(() => undefined);
    stub.close();
  });

  const body = (model = 'tinfoil/enc-model', extra: object = {}) => ({ model, messages: [{ role: 'user', content: 'An opening long enough to be cached. '.repeat(100) }], max_tokens: 64, ...extra });
  const balance = async (gw: Gateway = g, cents = 100): Promise<string> => {
    const r = await fetch(`${gw.url}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', cents), invite: createInvite(gw) }),
    });
    return (await r.json()).key;
  };
  const plain = (key: string, b: object, gw: Gateway = g) =>
    fetch(`${gw.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify(b) });
  const nut24 = async (b: object, gw: Gateway = g) =>
    fetch(`${gw.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forge-invite': createInvite(gw), 'x-cashu': await mintToken(MINT_A, 'usd', 30) },
      body: JSON.stringify(b),
    });
  /** Sends a request, reads the answer, and returns what the stub got and the request row. */
  const send = async (go: () => Promise<Response>, gw: Gateway = g) => {
    const n = seen.length;
    const res = await go();
    const streamed = String(res.headers.get('content-type')).includes('event-stream');
    const out = streamed ? await readSse(res) : await res.json();
    expect(seen.length, JSON.stringify(out)).toBe(n + 1);
    const id = res.headers.get('x-forge-request-id')!;
    let row: any;
    for (let i = 0; i < 100 && !(row = gw.deps.db.prepare("SELECT * FROM requests WHERE id = ? AND status IN ('settled', 'failed')").get(id)); i++) await new Promise((r) => setTimeout(r, 20));
    return { res, out, upstream: seen.at(-1)!, row };
  };
  const secretOf = (s: Seen): string => s.json.user_cache_secret;
  const accountId = (key: string, gw: Gateway = g) => gw.deps.ledger.findByKey(key)!.id;

  it('two balances sending the same body send different secrets; neither is the key or the balance id', async () => {
    const [a, b] = [await balance(), await balance()];
    const sa = secretOf((await send(() => plain(a, body()))).upstream);
    const sb = secretOf((await send(() => plain(b, body()))).upstream);
    expect(sa).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sb).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sa).not.toBe(sb);
    for (const v of [a, b, accountId(a), accountId(b)]) {
      expect(sa.includes(v) || v.includes(sa)).toBe(false);
      expect(sb.includes(v) || v.includes(sb)).toBe(false);
    }
  });

  it('one balance keeps its secret on repeat requests, streamed or not, and across a top-up', async () => {
    const key = await balance();
    const first = secretOf((await send(() => plain(key, body()))).upstream);
    expect(secretOf((await send(() => plain(key, body()))).upstream)).toBe(first);
    const streamed = await send(() => plain(key, body('tinfoil/enc-model', { stream: true })));
    expect(streamed.upstream.json.stream).toBe(true);
    expect(secretOf(streamed.upstream)).toBe(first);
    expect(streamed.out.forge.charged_msub).toBeGreaterThan(0);
    // A top-up of the same balance.
    const t = await fetch(`${g.url}/v1/wallet/topup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 50) }),
    });
    expect(t.status).toBe(200);
    expect(secretOf((await send(() => plain(key, body()))).upstream)).toBe(first);
  });

  it('a balance keeps its secret after the gateway restarts on the same data', async () => {
    const g1 = await startGateway({ enclavePort: port, editCatalog });
    const key = await balance(g1);
    const before = secretOf((await send(() => plain(key, body(), g1), g1)).upstream);
    await g1.close();
    const g2 = await startGateway({ enclavePort: port, editCatalog, dbPath: g1.dbPath });
    others.push(g2);
    expect(secretOf((await send(() => plain(key, body(), g2), g2)).upstream)).toBe(before);
    // A new balance on the restarted gateway gets a secret of its own.
    const fresh = await balance(g2);
    expect(secretOf((await send(() => plain(fresh, body(), g2), g2)).upstream)).not.toBe(before);
  });

  it("a client's own secret splits its balance's cache but never reaches another balance's", async () => {
    const [a, b] = [await balance(), await balance()];
    const base = secretOf((await send(() => plain(a, body()))).upstream);
    const mine = secretOf((await send(() => plain(a, body('tinfoil/enc-model', { user_cache_secret: 'shared-value' })))).upstream);
    expect(mine).not.toBe(base);
    expect(mine).not.toBe('shared-value');
    // Stable for that balance and value, streamed too.
    expect(secretOf((await send(() => plain(a, body('tinfoil/enc-model', { user_cache_secret: 'shared-value' })))).upstream)).toBe(mine);
    expect(secretOf((await send(() => plain(a, body('tinfoil/enc-model', { user_cache_secret: 'shared-value', stream: true })))).upstream)).toBe(mine);
    // Another balance with the same value lands elsewhere.
    const theirs = secretOf((await send(() => plain(b, body('tinfoil/enc-model', { user_cache_secret: 'shared-value' })))).upstream);
    expect(theirs).not.toBe(mine);
    expect(theirs).not.toBe('shared-value');
    // A value that is empty or not a string is no value, as Tinfoil reads it: the balance's own secret.
    expect(secretOf((await send(() => plain(a, body('tinfoil/enc-model', { user_cache_secret: '' })))).upstream)).toBe(base);
    expect(secretOf((await send(() => plain(a, body('tinfoil/enc-model', { user_cache_secret: 12345 })))).upstream)).toBe(base);
  });

  it('NUT-24 requests carry a fresh secret every time, also when the client sends one', async () => {
    const got = new Set<string>();
    for (const b of [body(), body(), body('tinfoil/enc-model', { user_cache_secret: 'shared-value' }), body('tinfoil/enc-model', { user_cache_secret: 'shared-value' }), body('tinfoil/enc-model', { stream: true })]) {
      const r = await send(() => nut24(b));
      expect(r.res.status).toBe(200);
      const s = secretOf(r.upstream);
      expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(s).not.toBe('shared-value');
      got.add(s);
    }
    expect(got.size).toBe(5);
  });

  it('free models, balances opened with an invite at 0 and event-pass balances: each balance its own secret', async () => {
    const open = async (invite: string) => (await (await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite }) })).json()).key as string;
    const k = await open(createInvite(g));
    const free = await send(() => plain(k, body('tinfoil/free-model')));
    expect(free.res.status).toBe(200);
    expect(free.row.charged_msub).toBe(0);
    const s1 = secretOf(free.upstream);
    expect(secretOf((await send(() => plain(k, body('tinfoil/free-model')))).upstream)).toBe(s1);
    // One event pass, two people: two balances, two caches.
    const pass = g.deps.passes.create({ maxUses: 5, expiresAt: Date.now() + 3_600_000 }).code;
    const [p1, p2] = [await open(pass), await open(pass)];
    const sp1 = secretOf((await send(() => plain(p1, body('tinfoil/free-model')))).upstream);
    const sp2 = secretOf((await send(() => plain(p2, body('tinfoil/free-model')))).upstream);
    expect(new Set([s1, sp1, sp2]).size).toBe(3);
  });

  it('a supplier other than Tinfoil gets the body exactly as before, a client secret included', async () => {
    const key = await balance();
    const check = async (b: Record<string, unknown>) => {
      const r = await send(() => plain(key, b));
      expect(r.res.status).toBe(200);
      expect(r.upstream.path).toBe('/other/v1/chat/completions');
      // What the gateway sent before this change: the client's body with the upstream model name.
      expect(r.upstream.raw.toString('utf8')).toBe(JSON.stringify({ ...b, model: 'enc-model' }));
    };
    await check(body('plainai/enc-model'));
    await check(body('plainai/enc-model', { user_cache_secret: 'shared-value' }));
    const r = await send(() => plain(key, body('plainai/enc-model', { stream: true, user_cache_secret: 'shared-value' })));
    expect(r.upstream.json.user_cache_secret).toBe('shared-value');
  });

  it('an encrypted request is forwarded byte for byte, with no secret added', async () => {
    const key = await balance();
    const ct = randomBytes(4000);
    for (const accept of ['application/json', 'text/event-stream']) {
      const n = seen.length;
      const res = await fetch(`${g.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept, 'ehbp-encapsulated-key': 'ee'.repeat(32), 'x-tinfoil-model': 'enc-model', 'x-tinfoil-max-output-tokens': '64' },
        body: new Uint8Array(ct),
      });
      await res.arrayBuffer();
      expect(seen.length).toBe(n + 1);
      const s = seen.at(-1)!;
      expect(s.raw.equals(ct)).toBe(true);
      expect(s.headers['content-length']).toBe(String(ct.length));
      expect(Object.keys(s.headers).some((h) => h.includes('cache'))).toBe(false);
    }
  });

  it('the hold and the charge are those of the same request without the secret', async () => {
    const env = g.deps.config.env;
    const cat = g.deps.config.catalog;
    for (const stream of [false, true]) {
      const key = await balance();
      const b = body('tinfoil/enc-model', stream ? { stream: true } : {});
      const bOther = { ...b, model: 'plainai/enc-model' };
      const tin = await send(() => plain(key, b));
      const oth = await send(() => plain(key, bOther));
      // The upstream body is longer by the added field; the hold is still taken from the client's bytes.
      const clientBytes = Buffer.byteLength(JSON.stringify(b));
      expect(tin.upstream.raw.length).toBeGreaterThan(clientBytes);
      const model = cat.models.find((m) => m.id === 'tinfoil/enc-model')!;
      const expectHold = nanoUsdToMsub(holdNanoUsd(cat.suppliers.tinfoil!, model, clientBytes, 64, env.FORGE_MARKUP, env.FORGE_BYTES_PER_TOKEN), 'usd');
      expect(tin.row.reserved_msub).toBe(expectHold);
      expect(oth.row.reserved_msub).toBe(expectHold);
      // 1,000 in at 100 and 20 out at 1,000 USD per million: 12,000 msub, the same on both suppliers.
      expect(tin.row.charged_msub).toBe(12_000);
      expect(oth.row.charged_msub).toBe(12_000);
      expect([tin.row.input_tokens, tin.row.output_tokens, tin.row.price_nusd]).toEqual([oth.row.input_tokens, oth.row.output_tokens, oth.row.price_nusd]);
    }
    // NUT-24: the 402 quote and the change are the same as on the supplier without a secret.
    const quote = async (model: string) => (await (await fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forge-invite': createInvite(g) }, body: JSON.stringify(body(model)) })).json()).amount;
    expect(await quote('tinfoil/enc-model')).toBe(await quote('plainai/enc-model'));
    const t = await send(() => nut24(body('tinfoil/enc-model')));
    const o = await send(() => nut24(body('plainai/enc-model')));
    expect([t.row.reserved_msub, t.row.charged_msub, t.row.change_units]).toEqual([o.row.reserved_msub, o.row.charged_msub, o.row.change_units]);
    expect(t.row.charged_msub).toBe(12_000);
  });

  it('the secret appears in no log line, no stored row, no database file and no error answer', async () => {
    const lines: string[] = [];
    const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => (lines.push(String(chunk)), true));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => (lines.push(String(chunk)), true));
    setLogSilent(false);
    const secrets: string[] = [];
    const answers: string[] = [];
    try {
      const key = await balance();
      for (const go of [() => plain(key, body()), () => plain(key, body('tinfoil/enc-model', { stream: true })), () => plain(key, body('tinfoil/enc-model', { user_cache_secret: 'shared-value' })), () => nut24(body())]) {
        const r = await send(go);
        secrets.push(secretOf(r.upstream));
        answers.push(JSON.stringify(r.out), JSON.stringify([...r.res.headers]));
      }
      // A supplier error that quotes the secret: the client and the log get it with the secret taken out.
      mode = 'echo-error';
      for (const go of [() => plain(key, body()), () => nut24(body())]) {
        const n = seen.length;
        const res = await go();
        const text = await res.text();
        expect(res.status).toBe(400);
        secrets.push(secretOf(seen[n]!));
        expect(text).toContain('[user_cache_secret]');
        answers.push(text, JSON.stringify([...res.headers]));
      }
    } finally {
      mode = 'ok';
      setLogSilent(process.env.FORGE_TEST_LOGS !== '1');
      out.mockRestore();
      err.mockRestore();
    }
    expect(secrets.every((s) => /^[A-Za-z0-9_-]{43}$/.test(s))).toBe(true);
    const logText = lines.join('');
    // The logs were captured: the request lines are there.
    expect(lines.some((l) => l.includes('"msg":"request"'))).toBe(true);
    const tables = (g.deps.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    const rows = tables.map((t) => JSON.stringify(g.deps.db.prepare(`SELECT * FROM "${t}"`).all())).join('\n');
    const files = [g.dbPath, `${g.dbPath}-wal`, `${g.dbPath}-shm`].filter(existsSync).map((f) => readFileSync(f));
    for (const s of secrets) {
      expect(logText.includes(s)).toBe(false);
      expect(rows.includes(s)).toBe(false);
      for (const f of files) expect(f.includes(Buffer.from(s))).toBe(false);
      for (const a of answers) expect(a.includes(s)).toBe(false);
    }
  });

  describe.skipIf(!creditUp)('free questions (credits)', () => {
    let gf: Gateway;
    beforeAll(async () => {
      gf = await startGateway({
        enclavePort: port,
        editCatalog,
        env: { FORGE_CREDIT_MINT: MINT_CREDIT, FORGE_FREE_MODELS: 'tinfoil/enc-model', FORGE_FREE_MAX_INPUT_TOKENS: '4000', FORGE_FREE_MAX_OUTPUT_TOKENS: '100' },
      });
      others.push(gf);
    });
    it('a free-question balance has its own stable secret, and another one has another', async () => {
      const open = async () => {
        const r = await fetch(`${gf.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_CREDIT, 'usd', 3) }) });
        return (await r.json()).key as string;
      };
      const [a, b] = [await open(), await open()];
      expect(gf.deps.ledger.findByKey(a)!.free).toBe(1);
      const sa = secretOf((await send(() => plain(a, body(), gf), gf)).upstream);
      expect(secretOf((await send(() => plain(a, body(), gf), gf)).upstream)).toBe(sa);
      expect(secretOf((await send(() => plain(b, body(), gf), gf)).upstream)).not.toBe(sa);
    });
  });
});
