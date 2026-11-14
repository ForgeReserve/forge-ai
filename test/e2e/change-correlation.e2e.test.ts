import { PaymentRequest } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatBody, createInvite, type Gateway, MINT_A, mintsUp, mintToken, readSse, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();

const post = (g: Gateway, body: object, headers: Record<string, string>, signal?: AbortSignal) =>
  fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal });

/** Asks for a 402 and returns the request id it names, checking the header and the NUT-18 request agree. */
async function ask402(g: Gateway, invite: string): Promise<{ id: string; amount: number }> {
  const res = await post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite });
  expect(res.status).toBe(402);
  const id = res.headers.get('x-forge-request-id')!;
  expect(id).toMatch(/^req_[0-9a-f]{32}$/);
  const pr = PaymentRequest.fromEncodedRequest(res.headers.get('x-cashu')!);
  expect(pr.id).toBe(id);
  return { id, amount: pr.amount!.toNumber() };
}

async function changeFor(g: Gateway, id: string): Promise<Response> {
  for (let i = 0; i < 50; i++) {
    const res = await fetch(`${g.url}/v1/change/${id}`);
    if (res.status !== 409) return res;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`change for ${id} never settled`);
}

// Red-team finding 8: every HTTP attempt drew a fresh random request id, so change from a paid retry (and
// from error or startup recovery after a disconnect) sat under an id the payer had never seen; the id
// from the 402 answered 404.
describe.skipIf(!up)('change is findable by the id from the 402', () => {
  let g: Gateway;
  let invite: string;
  beforeAll(async () => {
    g = await startGateway();
    invite = createInvite(g);
  });
  afterAll(() => g.close());

  it('a paid retry that echoes the id runs under it, and its change is at /v1/change/{id}', async () => {
    const { id, amount } = await ask402(g, invite);
    const token = await mintToken(MINT_A, 'usd', amount + 5);
    const ok = await post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': id });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('x-forge-request-id')).toBe(id);
    expect(ok.headers.get('x-forge-change-url')).toBe(`/v1/change/${id}`);
    const change = ok.headers.get('x-cashu-change')!;
    const again = await changeFor(g, id);
    expect(again.status).toBe(200);
    expect((await again.json()).token).toBe(change);
    expect(await redeem(change)).toBe(amount + 5 - 2);
  });

  it('a streamed paid retry names the same id in its final forge event', async () => {
    const { id, amount } = await ask402(g, invite);
    const token = await mintToken(MINT_A, 'usd', amount + 3);
    const res = await post(g, chatBody('mock-echo', { stream: true }), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': id });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-forge-request-id')).toBe(id);
    const { forge } = await readSse(res);
    expect(forge.request_id).toBe(id);
    expect(forge.change_url).toBe(`/v1/change/${id}`);
    const again = await (await changeFor(g, id)).json();
    expect(again.token).toBe(forge.change);
  });

  it('a payer who disconnects mid-request finds the change error recovery made under the 402 id', async () => {
    const { id, amount } = await ask402(g, invite);
    const token = await mintToken(MINT_A, 'usd', amount);
    const mock = g.deps.suppliers.get('mock')!;
    const realChat = mock.chat.bind(mock);
    let reached!: () => void;
    const atUpstream = new Promise<void>((r) => (reached = r));
    // An upstream that never answers: only the client's disconnect ends the call.
    mock.chat = (call) =>
      new Promise<Response>((_, reject) => {
        reached();
        call.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    const abort = new AbortController();
    try {
      const pending = post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': id }, abort.signal).catch(() => undefined);
      await atUpstream;
      abort.abort();
      await pending;
      // The payer never saw the paid response; the id it already holds finds the full refund.
      const res = await changeFor(g, id);
      expect(res.status).toBe(200);
      expect(await redeem((await res.json()).token)).toBe(amount);
    } finally {
      mock.chat = realChat;
    }
  });

  it('refuses a malformed id before the token is touched', async () => {
    const token = await mintToken(MINT_A, 'usd', 20);
    const res = await post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': 'fund_0123' });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('invalid_request');
    expect(await redeem(token)).toBe(20);
  });

  it('refuses a second payment under an id that already carries one, and leaves the token unspent', async () => {
    const { id, amount } = await ask402(g, invite);
    const first = await post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': await mintToken(MINT_A, 'usd', amount), 'X-Forge-Request-Id': id });
    expect(first.status).toBe(200);
    const token = await mintToken(MINT_A, 'usd', amount);
    const second = await post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': id });
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error.code).toBe('request_id_used');
    expect(body.error.message).toContain(`/v1/change/${id}`);
    expect(await redeem(token)).toBe(amount);
    // The first payment's row and change are untouched.
    const row: any = g.deps.db.prepare('SELECT status FROM requests WHERE id = ?').get(id);
    expect(row.status).toBe('settled');
  });

  it('a paid request without the header still runs under a fresh id', async () => {
    const { id } = await ask402(g, invite);
    const ok = await post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': await mintToken(MINT_A, 'usd', 20) });
    expect(ok.status).toBe(200);
    const fresh = ok.headers.get('x-forge-request-id')!;
    expect(fresh).toMatch(/^req_[0-9a-f]{32}$/);
    expect(fresh).not.toBe(id);
    expect((await changeFor(g, fresh)).status).toBe(200);
  });
});

describe.skipIf(!up)('change after startup recovery', () => {
  it('a paid retry whose receive was interrupted owes its change under the 402 id after a restart', async () => {
    const faulty = await startGateway({ faults: { afterReceiveSwap: true } });
    const invite = createInvite(faulty);
    const { id, amount } = await ask402(faulty, invite);
    const token = await mintToken(MINT_A, 'usd', amount + 4);
    const res = await post(faulty, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': id });
    expect(res.status).toBeGreaterThanOrEqual(500);
    await faulty.close();

    const g = await startGateway({ dbPath: faulty.dbPath });
    try {
      const ch = await changeFor(g, id);
      expect(ch.status).toBe(200);
      expect(await redeem((await ch.json()).token)).toBe(amount + 4);
    } finally {
      await g.close();
    }
  });
});
