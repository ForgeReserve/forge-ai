import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tx } from '../../src/db.ts';
import { Ledger, newApiKey } from '../../src/ledger.ts';
import { chatBody, expectedMsub, type Gateway, mintsUp, readSse, startGateway } from './helpers.ts';

const up = await mintsUp();

// The fault this guards against: the stale-reservation sweep released the reservation of a stream that was
// still running, and the stream then settled for nothing.
describe.skipIf(!up)('stale reservations and active streams', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());

  const account = (msub: number) => {
    const key = newApiKey();
    const a = tx(g.deps.db, () => {
      const a = g.deps.ledger.createAccountRaw(key, 'usd', null);
      g.deps.ledger.creditRaw(a.id, msub, 'topup', null);
      return a;
    });
    return { key, id: a.id };
  };

  /** Starts a slow stream and resolves once a few chunks have arrived, with the rest of the body still to come. */
  const startSlowStream = async (key: string) => {
    const res = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(chatBody('mock-slow', { stream: true, max_tokens: 40, stream_options: { include_usage: true } })),
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let head = '';
    while ((head.match(/data: /g) ?? []).length < 5) {
      const { value, done } = await reader.read();
      if (done) throw new Error('stream ended early');
      head += dec.decode(value, { stream: true });
    }
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      rest += dec.decode(value, { stream: true });
    }
    return { requestId: res.headers.get('x-forge-request-id')!, sse: await readSse(new Response(head + rest)) };
  };

  it('the periodic sweep leaves an active stream reserved and the stream is charged in full', async () => {
    const { key, id } = account(100_000);
    let swept = -1;
    let heldDuringStream = 0;
    const done = startSlowStream(key);
    // Let the stream start, then run the sweep with a zero age cutoff (as if the stream were older than the window).
    for (let i = 0; i < 100 && g.deps.ledger.reservedMsub(id) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 150));
    swept = g.deps.ledger.releaseStale(0);
    heldDuringStream = g.deps.ledger.reservedMsub(id);
    const { sse } = await done;
    expect(swept).toBe(0);
    expect(heldDuringStream).toBeGreaterThan(0);
    const usage = sse.data.find((d) => d.usage).usage;
    const cost = expectedMsub(usage.prompt_tokens, usage.completion_tokens);
    expect(cost).toBeGreaterThan(0);
    expect(sse.forge.charged_msub).toBe(cost);
    expect(g.deps.ledger.get(id)!.balance_msub).toBe(100_000 - cost);
    expect(g.deps.ledger.reservedMsub(id)).toBe(0);
  });

  it('a stream whose reservation was released elsewhere is still charged at completion', async () => {
    const { key, id } = account(100_000);
    const done = startSlowStream(key);
    for (let i = 0; i < 100 && g.deps.ledger.reservedMsub(id) === 0; i++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => setTimeout(r, 150));
    // A ledger with no live owners over the same database (what a restarted process sees) releases it.
    expect(new Ledger(g.deps.db).releaseStale(0)).toBe(1);
    expect(g.deps.ledger.reservedMsub(id)).toBe(0);
    const { requestId, sse } = await done;
    const usage = sse.data.find((d) => d.usage).usage;
    const cost = expectedMsub(usage.prompt_tokens, usage.completion_tokens);
    expect(sse.forge.charged_msub).toBe(cost);
    expect(g.deps.ledger.get(id)!.balance_msub).toBe(100_000 - cost);
    const row: any = g.deps.db.prepare('SELECT status, charged_msub FROM requests WHERE id = ?').get(requestId);
    expect(row).toEqual({ status: 'settled', charged_msub: cost });
  });

  it('a request that fails before settling leaves its reservation to the abandoned-request sweep', async () => {
    const { key, id } = account(100_000);
    const ledger = g.deps.ledger;
    const realSettle = ledger.settle.bind(ledger);
    // Settlement itself throws, so the error escapes the request before anything is settled. (A failed
    // upstream body read no longer escapes: it settles as an upstream failure, see upstream-failures.e2e.)
    ledger.settle = () => {
      throw new Error('settlement failed');
    };
    try {
      const res = await fetch(`${g.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(chatBody('mock-echo')),
      });
      expect(res.ok).toBe(false);
    } finally {
      ledger.settle = realSettle;
    }
    // The reservation is still held, but nothing owns it any more: the periodic sweep frees it
    // in-process, no restart needed.
    expect(g.deps.ledger.reservedMsub(id)).toBeGreaterThan(0);
    expect(g.deps.ledger.releaseStale(0)).toBe(1);
    expect(g.deps.ledger.reservedMsub(id)).toBe(0);
    expect(g.deps.ledger.get(id)!.balance_msub).toBe(100_000);
  });
});
