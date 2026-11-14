import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

// The v2 engine client (public/v2/core/engine.js), the SSE reader and proof of work, against stubs.
const E: any = await import('../../../public/v2/core/engine.js' as string);
const P: any = await import('../../../public/v2/core/pow.js' as string);
const SSE: any = await import('../../../public/v2/core/sse.js' as string);

const enc = new TextEncoder();
/** A streamed body that delivers the given pieces one by one. */
const streamOf = (pieces: string[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const p of pieces) c.enqueue(enc.encode(p));
      c.close();
    },
  });
const sse = (pieces: string[], status = 200) => new Response(streamOf(pieces), { status, headers: { 'content-type': 'text/event-stream' } });
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

const chunk = (content: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\n`;

describe('SHA-256 and proof of work', () => {
  it('matches node:crypto for lengths around the block edges', () => {
    for (const n of [0, 1, 55, 56, 63, 64, 65, 119, 1000]) {
      const bytes = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 255);
      expect(Buffer.from(P.sha256(bytes)).toString('hex'), String(n)).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('counts leading zero bits', () => {
    expect(P.leadingZeroBits(new Uint8Array([0, 0, 1]))).toBe(23);
    expect(P.leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    expect(P.leadingZeroBits(new Uint8Array([0, 0x0f]))).toBe(12);
  });

  it('finds a solution with the asked number of zero bits, in the Bellows format', async () => {
    const s = await P.solvePow('v1.challenge.mac', 12);
    expect(s.startsWith('v1.challenge.mac:')).toBe(true);
    expect(P.leadingZeroBits(createHash('sha256').update(s).digest())).toBeGreaterThanOrEqual(12);
    await expect(P.solvePow('x', 40)).rejects.toThrow(/out of range/);
  });

  it('uses the Bellows header names', () => {
    expect(P.POW_HEADER).toBe('X-Bellows-Pow');
    expect(P.POW_CHALLENGE_HEADER).toBe('X-Bellows-Pow-Challenge');
  });
});

describe('stream parsing', () => {
  it('reads text split across chunks, usage and the forge event', async () => {
    const all = chunk('Hello') + chunk(', world') + `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } })}\n\n` + 'data: [DONE]\n\n' + `event: forge\ndata: ${JSON.stringify({ charged_msub: 12, balance_msub: 488 })}\n\n`;
    // Cut the stream at awkward places, including inside a line and between the two newlines.
    const pieces = [all.slice(0, 7), all.slice(7, 40), all.slice(40, 41), all.slice(41, 90), all.slice(90)];
    const out = { text: '', usage: null as any, forge: null as any };
    await SSE.readStream(streamOf(pieces), { onText: (d: string) => (out.text += d), onUsage: (u: any) => (out.usage = u), onForge: (f: any) => (out.forge = f) });
    expect(out.text).toBe('Hello, world');
    expect(out.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2 });
    expect(out.forge).toEqual({ charged_msub: 12, balance_msub: 488 });
  });

  it('handles CRLF and a final event without a blank line', () => {
    const p = SSE.createSseParser();
    expect(p.push('data: {"a":1}\r\n\r\ndata: {"b"')).toEqual([{ event: 'message', data: '{"a":1}' }]);
    expect(p.push(':2}')).toEqual([]);
    expect(p.flush()).toEqual([{ event: 'message', data: '{"b":2}' }]);
  });

  it('throws when the engine reports an error inside the stream', async () => {
    const body = streamOf([chunk('Half'), `data: ${JSON.stringify({ error: { message: 'upstream stream failed', type: 'upstream_error' } })}\n\n`]);
    let text = '';
    await expect(SSE.readStream(body, { onText: (d: string) => (text += d) })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(text).toBe('Half');
  });

  it('still hands over the forge event the gateway sends after an in-stream error, then throws', async () => {
    // The gateway settles a broken stream as partial (src/app.ts) and says what it charged after the error.
    const body = streamOf([chunk('Half'), `data: ${JSON.stringify({ error: { message: 'upstream stream failed', type: 'upstream_error' } })}\n\n`, chunk(' ignored'), `event: forge\ndata: ${JSON.stringify({ charged_msub: 1234, balance_msub: 8766, partial: true })}\n\n`]);
    let text = '';
    let forge: any = null;
    await expect(SSE.readStream(body, { onText: (d: string) => (text += d), onForge: (f: any) => (forge = f) })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(forge).toEqual({ charged_msub: 1234, balance_msub: 8766, partial: true });
    // Text after the error is not shown as part of the answer.
    expect(text).toBe('Half');
  });

  it('passes the forge event through chat() on an in-stream error', async () => {
    const e = E.createEngine({ fetch: async () => sse([`data: ${JSON.stringify({ error: { message: 'boom', type: 'upstream_error' } })}\n\n`, `event: forge\ndata: {"charged_msub":0,"balance_msub":100}\n\n`]) });
    let forge: any = null;
    await expect(e.chat({ key: 'k', body: { model: 'm', messages: [] }, onForge: (f: any) => (forge = f) })).rejects.toMatchObject({ code: 'upstream_error' });
    expect(forge).toEqual({ charged_msub: 0, balance_msub: 100 });
  });
});

describe('engine client', () => {
  it('streams a chat answer with the balance key and the request shape v1 uses', async () => {
    const f = vi.fn(async (_url: string, _init: any) => sse([chunk('Forge'), chunk(' answers'), `event: forge\ndata: {"charged_msub":5,"balance_msub":95}\n\n`]));
    const e = E.createEngine({ base: 'https://engine.example/', fetch: f });
    let text = '';
    let forge: any;
    await e.chat({ key: 'sk-forge-k', body: { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64 }, onText: (d: string) => (text += d), onForge: (x: any) => (forge = x) });
    expect(text).toBe('Forge answers');
    expect(forge.balance_msub).toBe(95);
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe('https://engine.example/v1/chat/completions');
    expect(init.headers.authorization).toBe('Bearer sk-forge-k');
    expect(JSON.parse(init.body)).toMatchObject({ model: 'm', stream: true, stream_options: { include_usage: true }, max_tokens: 64 });
  });

  it('turns a 402 into a payment error the app can act on', async () => {
    const e = E.createEngine({ fetch: async () => json({ error: { message: 'balance too low', code: 'insufficient_balance' } }, 402) });
    await expect(e.chat({ key: 'k', body: { model: 'm', messages: [] } })).rejects.toMatchObject({ name: 'EngineError', code: 'insufficient_balance', status: 402, retryable: false });
    const e2 = E.createEngine({ fetch: async () => json({ error: { message: 'pay 5 usd' } }, 402) });
    await expect(e2.chat({ key: 'k', body: { model: 'm', messages: [] } })).rejects.toMatchObject({ code: 'payment_required', status: 402 });
  });

  it('answers a 428 proof-of-work challenge once and resends with the solution', async () => {
    const calls: any[] = [];
    const f = vi.fn(async (_url: string, init: any) => {
      calls.push(init);
      if (!init.headers['X-Bellows-Pow']) return json({ error: { message: 'opening a balance needs proof of work', code: 'pow_required' }, pow: { challenge: 'v1.c.m', bits: 10, expires_at: 0, header: 'X-Bellows-Pow' } }, 428, { 'X-Bellows-Pow-Challenge': 'v1.from-header.m' });
      return json({ key: 'sk-forge-new', credited: 100, unit: 'usd' });
    });
    const e = E.createEngine({ fetch: f });
    const r = await e.topup(undefined, 'cashuBtoken', undefined);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    const sol = calls[1].headers['X-Bellows-Pow'];
    // The header challenge wins over the one in the body, as in the Bellows client.
    expect(sol.startsWith('v1.from-header.m:')).toBe(true);
    expect(P.leadingZeroBits(createHash('sha256').update(sol).digest())).toBeGreaterThanOrEqual(10);
    expect(JSON.parse(calls[1].body)).toEqual({ token: 'cashuBtoken' });
  });

  it('does not loop when the engine refuses the solution', async () => {
    const f = vi.fn(async () => json({ error: { code: 'pow_required', message: 'refused' }, pow: { challenge: 'v1.c.m', bits: 1 } }, 428));
    const e = E.createEngine({ fetch: f, solve: async (c: string) => `${c}:0` });
    const r = await e.call('/v1/wallet/topup', { json: { token: 'x' } });
    expect(r.status).toBe(428);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('refuses a 428 without a challenge', async () => {
    const e = E.createEngine({ fetch: async () => json({ error: { code: 'pow_required' } }, 428) });
    await expect(e.call('/v1/wallet/topup', { json: {} })).rejects.toMatchObject({ code: 'pow_required' });
  });

  it('answers 428 on a chat request too', async () => {
    let n = 0;
    const f = async (_u: string, init: any) => (n++ === 0 ? json({ error: { code: 'pow_required' }, pow: { challenge: 'v1.a.b', bits: 2 } }, 428) : (expect(init.headers['X-Bellows-Pow']).toMatch(/^v1\.a\.b:/), sse([chunk('ok')])));
    const e = E.createEngine({ fetch: f });
    let text = '';
    await e.chat({ key: 'k', body: { model: 'm', messages: [] }, onText: (d: string) => (text += d) });
    expect(text).toBe('ok');
  });

  it('reports a network failure as offline and retryable', async () => {
    const e = E.createEngine({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
    await expect(e.models()).rejects.toMatchObject({ code: 'offline', retryable: true });
  });

  it('passes an abort through as an AbortError', async () => {
    const e = E.createEngine({ fetch: async () => { throw new DOMException('Aborted', 'AbortError'); } });
    await expect(e.chat({ key: 'k', body: { model: 'm', messages: [] } })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('sends a private model through the encrypting fetch with the Tinfoil headers', async () => {
    const plain = vi.fn();
    const ef = vi.fn(async (_path: string, _init: any) => sse([chunk('sealed')]));
    const e = E.createEngine({ fetch: plain, encryptedFetch: async () => ef });
    let text = '';
    await e.chat({ key: 'k', body: { model: 'tinfoil/x', messages: [], max_tokens: 99 }, encrypted: { upstream: 'x-up' }, onText: (d: string) => (text += d) });
    expect(text).toBe('sealed');
    expect(plain).not.toHaveBeenCalled();
    const [path, init] = ef.mock.calls[0]!;
    expect(path).toBe('chat/completions');
    expect(init.headers['X-Tinfoil-Model']).toBe('x-up');
    expect(init.headers['X-Tinfoil-Max-Output-Tokens']).toBe('99');
    expect(JSON.parse(init.body).model).toBe('x-up');
  });

  it('Search the web: the search options travel in the encrypted body, and the hold is asked for in X-Forge-Web-Search', async () => {
    const ef = vi.fn(async (_path: string, _init: any) => sse([chunk('found')]));
    const e = E.createEngine({ fetch: vi.fn(), encryptedFetch: async () => ef });
    const body = { model: 'tinfoil/x', messages: [], max_tokens: 99, web_search_options: {}, pii_check_options: {}, prompt_injection_check_options: {} };
    await e.chat({ key: 'k', body, encrypted: { upstream: 'x-up' }, search: true, onText: () => {} });
    const [, init] = ef.mock.calls[0]!;
    expect(init.headers['X-Forge-Web-Search']).toBe('1');
    const sent = JSON.parse(init.body);
    expect(sent).toMatchObject({ model: 'x-up', web_search_options: {}, pii_check_options: {}, prompt_injection_check_options: {} });
    // The bytes sent are exactly the ones the app priced (chatPayload).
    expect(init.body).toBe(E.chatPayload(body, { upstream: 'x-up' }));
    // Off: no header.
    await e.chat({ key: 'k', body: { model: 'tinfoil/x', messages: [], max_tokens: 9 }, encrypted: { upstream: 'x-up' }, onText: () => {} });
    expect(ef.mock.calls[1]![1].headers['X-Forge-Web-Search']).toBeUndefined();
  });

  it('never sends a private question in plain text when the enclave cannot be checked', async () => {
    const plain = vi.fn();
    const e = E.createEngine({ fetch: plain, encryptedFetch: async () => { throw new Error('attestation failed'); } });
    await expect(e.chat({ key: 'k', body: { model: 'm', messages: [] }, encrypted: { upstream: 'm' } })).rejects.toMatchObject({ code: 'encryption_unavailable' });
    const e2 = E.createEngine({ fetch: plain });
    await expect(e2.chat({ key: 'k', body: { model: 'm', messages: [] }, encrypted: { upstream: 'm' } })).rejects.toMatchObject({ code: 'encryption_unavailable' });
    expect(plain).not.toHaveBeenCalled();
  });

  it('marks pending and mint errors as retryable, refusals as final', () => {
    expect(E.errorFrom(503, { error: { code: 'topup_pending' } }).retryable).toBe(true);
    expect(E.errorFrom(409, { error: { code: 'token_in_flight' } }).retryable).toBe(true);
    expect(E.errorFrom(429, null).retryable).toBe(true);
    expect(E.errorFrom(400, { error: { code: 'token_spent', message: 'used' } })).toMatchObject({ code: 'token_spent', retryable: false, message: 'used' });
    expect(E.errorFrom(500, null)).toMatchObject({ code: 'http_500', retryable: true });
  });
});
