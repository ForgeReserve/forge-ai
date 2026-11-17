import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tx } from '../../src/db.ts';
import { newApiKey } from '../../src/ledger.ts';
import { chatBody, createInvite, type Gateway, MINT_A, mintsUp, mintToken, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();

/** An upstream that answers 200 with headers and then fails while the body is read. */
const brokenBody = async () =>
  new Response(
    new ReadableStream({
      start(ctrl) {
        ctrl.error(new Error('connection reset'));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

// The fault this guards against: a non-stream body read that failed after 200 headers skipped settlement and left the
// request running, its reservation held and its change unavailable until a restart.
describe.skipIf(!up)('non-stream upstream body failures', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());

  const withBrokenBody = async <T,>(fn: () => Promise<T>): Promise<T> => {
    const mock = g.deps.suppliers.get('mock')!;
    const realChat = mock.chat.bind(mock);
    mock.chat = brokenBody;
    try {
      return await fn();
    } finally {
      mock.chat = realChat;
    }
  };

  it('a balance request is finalised in-process: nothing charged, reservation released', async () => {
    const key = newApiKey();
    const a = tx(g.deps.db, () => {
      const a = g.deps.ledger.createAccountRaw(key, 'usd', null);
      g.deps.ledger.creditRaw(a.id, 100_000, 'topup', null);
      return a;
    });
    const res = await withBrokenBody(() =>
      fetch(`${g.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(chatBody('mock-echo')),
      }),
    );
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.message).toMatch(/not charged/);
    expect(res.headers.get('x-forge-charged-msub')).toBe('0');
    expect(res.headers.get('x-forge-balance-msub')).toBe('100000');
    const requestId = res.headers.get('x-forge-request-id')!;
    const row: any = g.deps.db.prepare('SELECT status, charged_msub FROM requests WHERE id = ?').get(requestId);
    expect(row).toEqual({ status: 'failed', charged_msub: 0 });
    // Released by the request itself, before any sweep runs.
    expect(g.deps.ledger.reservedMsub(a.id)).toBe(0);
    expect(g.deps.ledger.releaseStale(0)).toBe(0);
    expect(g.deps.ledger.get(a.id)!.balance_msub).toBe(100_000);
  });

  it('a NUT-24 request returns its full change at once and at the change URL', async () => {
    const invite = createInvite(g);
    const token = await mintToken(MINT_A, 'usd', 30);
    const res = await withBrokenBody(() =>
      fetch(`${g.url}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Forge-Invite': invite, 'X-Cashu': token },
        body: JSON.stringify(chatBody('mock-echo')),
      }),
    );
    expect(res.status).toBe(502);
    expect(res.headers.get('x-forge-charged-msub')).toBe('0');
    const requestId = res.headers.get('x-forge-request-id')!;
    const row: any = g.deps.db.prepare('SELECT status, charged_msub, change_units FROM requests WHERE id = ?').get(requestId);
    expect(row).toEqual({ status: 'failed', charged_msub: 0, change_units: 30 });
    // The change URL answers at once (no 409 until restart) with the same token the response carried.
    const again = await fetch(`${g.url}/v1/change/${requestId}`);
    expect(again.status).toBe(200);
    const change = res.headers.get('x-cashu-change')!;
    expect((await again.json()).token).toBe(change);
    expect(await redeem(change)).toBe(30);
  });
});
