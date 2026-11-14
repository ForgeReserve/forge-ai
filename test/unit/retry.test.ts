import { createServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogSchema } from '../../src/config.ts';
import { failedBeforeSend, fetchWithRetry, OpenAISupplier } from '../../src/suppliers/openai.ts';

let server: Server | undefined;
afterEach(
  () =>
    new Promise<void>((r) => {
      vi.restoreAllMocks();
      if (!server) return r();
      server.closeAllConnections();
      server.close(() => r());
      server = undefined;
    }),
);

function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  server = createServer(handler);
  return new Promise((r) => server!.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(server!.address() as any).port}/`)));
}

/** A port that nothing listens on: bound once, then closed. */
function closedPort(): Promise<number> {
  const s = createNetServer();
  return new Promise((r) => s.listen(0, '127.0.0.1', () => {
    const port = (s.address() as any).port;
    s.close(() => r(port));
  }));
}

const readBody = (req: IncomingMessage) =>
  new Promise<string>((r) => {
    let b = '';
    req.on('data', (ch) => (b += ch));
    req.on('end', () => r(b));
  });

const post = (body: string, headers: Record<string, string> = {}): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

describe('fetchWithRetry', () => {
  it('does not resend a request whose headers timed out', async () => {
    let hits = 0;
    const url = await listen(() => void hits++); // never responds
    const err = await fetchWithRetry(url, { method: 'POST' }, new AbortController().signal, { retries: 2, timeoutMs: 200 }).catch((e) => e);
    expect(err.status).toBe(504);
    expect(hits).toBe(1);
  });

  // Red-team finding 6: two 503s then a 200 produced three identical upstream bodies.
  it('does not resend a sent request after a retryable status when the supplier takes no idempotency key', async () => {
    const bodies: string[] = [];
    const url = await listen(async (req, res) => {
      bodies.push(await readBody(req));
      res.statusCode = bodies.length <= 2 ? 503 : 200;
      res.end('{}');
    });
    const res = await fetchWithRetry(url, post('{"model":"m"}'), new AbortController().signal, { retries: 2, timeoutMs: 1000 });
    expect(res.status).toBe(503);
    expect(bodies).toEqual(['{"model":"m"}']);
  });

  it('does not resend a request whose connection reset after the body was sent', async () => {
    const bodies: string[] = [];
    const url = await listen(async (req) => {
      bodies.push(await readBody(req));
      req.socket.destroy();
    });
    const err = await fetchWithRetry(url, post('{"model":"m"}'), new AbortController().signal, { retries: 2, timeoutMs: 1000 }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/after the request was sent/);
    expect(bodies).toHaveLength(1);
  });

  it('retries a retryable status only when idempotent, with the same key on every attempt', async () => {
    const keys: (string | undefined)[] = [];
    const url = await listen(async (req, res) => {
      await readBody(req);
      keys.push(req.headers['idempotency-key'] as string | undefined);
      res.statusCode = keys.length === 1 ? 503 : 200;
      res.end('ok');
    });
    const res = await fetchWithRetry(url, post('{}', { 'idempotency-key': 'k-1' }), new AbortController().signal, { retries: 2, timeoutMs: 1000 }, true);
    expect(res.status).toBe(200);
    expect(keys).toEqual(['k-1', 'k-1']);
  });

  it('retries a reset after send only when idempotent', async () => {
    let hits = 0;
    const url = await listen(async (req, res) => {
      await readBody(req);
      if (++hits === 1) return req.socket.destroy();
      res.end('ok');
    });
    const res = await fetchWithRetry(url, post('{}'), new AbortController().signal, { retries: 2, timeoutMs: 1000 }, true);
    expect(res.status).toBe(200);
    expect(hits).toBe(2);
  });

  it('retries a refused connection, which never reached the supplier', async () => {
    const port = await closedPort();
    const spy = vi.spyOn(globalThis, 'fetch');
    const err = await fetchWithRetry(`http://127.0.0.1:${port}/`, post('{}'), new AbortController().signal, { retries: 2, timeoutMs: 1000 }).catch((e) => e);
    expect(err.status).toBe(502);
    expect(err.message).toMatch(/upstream unreachable/);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('a pre-send failure followed by success sends the body once', async () => {
    const bodies: string[] = [];
    const url = await listen(async (req, res) => {
      bodies.push(await readBody(req));
      res.end('ok');
    });
    const real = globalThis.fetch;
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      if (++calls === 1) return Promise.reject(new TypeError('fetch failed', { cause: Object.assign(new Error('getaddrinfo EAI_AGAIN'), { code: 'EAI_AGAIN' }) }));
      return real(input, init);
    });
    const res = await fetchWithRetry(url, post('{"a":1}'), new AbortController().signal, { retries: 2, timeoutMs: 1000 });
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(bodies).toEqual(['{"a":1}']);
  });
});

describe('failedBeforeSend', () => {
  const fetchErr = (cause: unknown) => new TypeError('fetch failed', { cause });
  const coded = (code: string) => Object.assign(new Error(code), { code });

  it('accepts connection refused, DNS, connect timeout and certificate failures', () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
      expect(failedBeforeSend(fetchErr(coded(code))), code).toBe(true);
    }
    // Happy eyeballs: every address refused.
    const agg = Object.assign(new AggregateError([coded('ECONNREFUSED'), coded('ECONNREFUSED')]), { code: 'ECONNREFUSED' });
    expect(failedBeforeSend(fetchErr(agg))).toBe(true);
  });

  it('rejects resets, socket closes and anything unknown', () => {
    for (const code of ['ECONNRESET', 'UND_ERR_SOCKET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_HEADERS_TIMEOUT', 'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC']) {
      expect(failedBeforeSend(fetchErr(coded(code))), code).toBe(false);
    }
    expect(failedBeforeSend(new Error('boom'))).toBe(false);
    expect(failedBeforeSend(fetchErr(undefined))).toBe(false);
    const mixed = new AggregateError([coded('ECONNREFUSED'), coded('ECONNRESET')]);
    expect(failedBeforeSend(fetchErr(mixed))).toBe(false);
  });
});

describe('OpenAISupplier idempotency key', () => {
  const supplierConfig = (extra: object) =>
    CatalogSchema.parse({
      suppliers: { s: { type: 'openai', baseUrl: 'http://127.0.0.1:1/v1', apiKeyEnv: 'K', tier: 'standard', ...extra } },
      models: [{ id: 'm', supplier: 's', upstream: 'm', input_usd_per_mtok: 1, output_usd_per_mtok: 1 }],
    }).suppliers.s!;

  it('sends one fresh key per logical request, the same on its retries', async () => {
    const keys: (string | undefined)[] = [];
    const url = await listen(async (req, res) => {
      await readBody(req);
      keys.push(req.headers['idempotency-key'] as string | undefined);
      res.statusCode = keys.length === 1 ? 503 : 200;
      res.end('{}');
    });
    const cfg = { ...supplierConfig({ idempotencyHeader: 'Idempotency-Key' }), baseUrl: url.replace(/\/$/, '') };
    const s = new OpenAISupplier('s', cfg, { K: 'key' }, { retries: 2, timeoutMs: 1000 });
    const call = () => s.chat({ model: { upstream: 'm' } as any, body: { model: 'm' }, stream: false, signal: new AbortController().signal });
    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('sends no key and does not retry a status without one', async () => {
    const keys: (string | undefined)[] = [];
    const url = await listen(async (req, res) => {
      await readBody(req);
      keys.push(req.headers['idempotency-key'] as string | undefined);
      res.statusCode = 503;
      res.end('{}');
    });
    const cfg = { ...supplierConfig({}), baseUrl: url.replace(/\/$/, '') };
    const s = new OpenAISupplier('s', cfg, { K: 'key' }, { retries: 2, timeoutMs: 1000 });
    const res = await s.chat({ model: { upstream: 'm' } as any, body: { model: 'm' }, stream: false, signal: new AbortController().signal });
    expect(res.status).toBe(503);
    expect(keys).toEqual([undefined]);
  });

  it('refuses a header name that is not a token', () => {
    expect(() => supplierConfig({ idempotencyHeader: 'Bad Header' })).toThrow();
  });
});
