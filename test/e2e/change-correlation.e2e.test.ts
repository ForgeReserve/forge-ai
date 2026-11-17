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

// The fault this guards against: every HTTP attempt drew a fresh random request id, so change from a paid retry (and
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

// Review of H4: a paid attempt that failed after the swap (in production, a mint timeout on completeSwap)
// left its change unreachable without a restart. /v1/change/{id} answered 404 although the token was held,
// and a retry that recovered the swap marked the request paid, so /v1/change/{id} answered 409 until restart.
describe.skipIf(!up)('change after runtime recovery, without a restart', () => {
  let g: Gateway;
  let invite: string;
  beforeAll(async () => {
    g = await startGateway({ faults: { afterReceiveSwap: true } });
    invite = createInvite(g);
  });
  afterAll(() => g.close());

  /** Pays under the 402 id; the injected fault fails the attempt after the mint has swapped the token. */
  async function failedPaidAttempt(): Promise<{ id: string; amount: number; token: string }> {
    const { id, amount } = await ask402(g, invite);
    const token = await mintToken(MINT_A, 'usd', amount + 4);
    const res = await post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': id });
    expect(res.status).toBeGreaterThanOrEqual(500);
    const inc: any = g.deps.db.prepare('SELECT status FROM incoming WHERE request_id = ?').get(id);
    expect(inc.status).toBe('prepared');
    return { id, amount, token };
  }

  const resend = (token: string, id?: string) =>
    post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, ...(id ? { 'X-Forge-Request-Id': id } : {}) });

  it('the 402 id finds the held payment at once, and retries with the same token leave it there', async () => {
    const { id, amount, token } = await failedPaidAttempt();
    const first = await fetch(`${g.url}/v1/change/${id}`);
    expect([200, 409]).toContain(first.status);
    const withId = await resend(token, id);
    expect(withId.status).toBe(409);
    const msg = (await withId.json()).error.message;
    expect(msg).toContain(`/v1/change/${id}`);
    expect(msg).toContain('its token was spent there');
    const withoutId = await resend(token);
    expect(withoutId.status).toBe(400);
    expect((await withoutId.json()).error.code).toBe('token_spent');
    const ch = await changeFor(g, id);
    expect(ch.status).toBe(200);
    expect(await redeem((await ch.json()).token)).toBe(amount + 4);
    const row: any = g.deps.db.prepare('SELECT status, paid_units, change_units FROM requests WHERE id = ?').get(id);
    expect(row).toEqual({ status: 'aborted', paid_units: amount + 4, change_units: amount + 4 });
    expect(g.deps.wallet.listOutgoing({ requestId: id }).filter((r) => r.purpose === 'change')).toHaveLength(1);
  });

  it('a retry without the id that recovers the swap owes the change under the 402 id', async () => {
    const { id, amount, token } = await failedPaidAttempt();
    // The retry finalizes the original swap through the recovery hook; the token is then spent.
    const retry = await resend(token);
    expect(retry.status).toBe(400);
    expect((await retry.json()).error.code).toBe('token_spent');
    const retryId = retry.headers.get('x-forge-request-id')!;
    const ch = await changeFor(g, id);
    expect(ch.status).toBe(200);
    expect(await redeem((await ch.json()).token)).toBe(amount + 4);
    // The retry's own id carries no payment and no change.
    expect((await fetch(`${g.url}/v1/change/${retryId}`)).status).toBe(404);
  });

  it('answers 409, never 404, while the mint cannot settle the swap', async () => {
    const { id, amount } = await failedPaidAttempt();
    const recover = g.deps.wallet.recoverIncomingFor.bind(g.deps.wallet);
    g.deps.wallet.recoverIncomingFor = async () => {
      throw new Error('mint offline');
    };
    try {
      const res = await fetch(`${g.url}/v1/change/${id}`);
      expect(res.status).toBe(409);
      expect(res.headers.get('retry-after')).toBeTruthy();
      expect((await res.json()).error.code).toBe('not_settled');
    } finally {
      g.deps.wallet.recoverIncomingFor = recover;
    }
    const ch = await changeFor(g, id);
    expect(ch.status).toBe(200);
    expect(await redeem((await ch.json()).token)).toBe(amount + 4);
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

/**
 * Makes the gateway's next receive stop forever at `stage`, the way a process that dies there leaves it:
 * the request row stays 'new' and nothing after the stage runs, so neither finalize nor the failure path
 * touches the database again. 'beforeSwap' stops after the incoming row is written, before the mint is
 * contacted; 'afterSwap' stops once the mint has swapped the token.
 */
function dieDuringReceive(g: Gateway, stage: 'beforeSwap' | 'afterSwap', requestId: string): void {
  const w = g.deps.wallet;
  const load = w.wallet.bind(w);
  const never = () => new Promise<never>(() => {});
  w.wallet = async (mint, unit) => {
    // The token is inspected (which loads the wallet too) before the incoming row is written.
    if (stage === 'beforeSwap' && g.deps.db.prepare('SELECT 1 FROM incoming WHERE request_id = ?').get(requestId)) return never();
    const real = await load(mint, unit);
    return new Proxy(real, {
      get(t, k) {
        if (stage === 'afterSwap' && k === 'completeSwap') return async (...a: Parameters<typeof real.completeSwap>) => (await t.completeSwap(...a), never());
        const v = Reflect.get(t, k);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
  };
}

// Review of H4: a request whose process died mid-receive stayed 'new' after a restart that found the mint
// down, and the startup sweep picks only paid or running requests. /v1/change/{id} then answered
// "request still running" forever (or until a restart found the mint up), and a payer whose token never
// reached the mint was told the same instead of 404.
describe.skipIf(!up)('a request the process died in mid-receive', () => {
  async function diedAt(stage: 'beforeSwap' | 'afterSwap'): Promise<{ dbPath: string; id: string; amount: number; token: string }> {
    const g = await startGateway();
    const invite = createInvite(g);
    const { id, amount } = await ask402(g, invite);
    const token = await mintToken(MINT_A, 'usd', amount + 4);
    const incoming = () => g.deps.db.prepare('SELECT status FROM incoming WHERE request_id = ?').get(id) as { status: string } | undefined;
    dieDuringReceive(g, stage, id);
    const want = stage === 'afterSwap' ? 'prepared' : 'new';
    void post(g, chatBody('mock-echo'), { 'X-Forge-Invite': invite, 'X-Cashu': token, 'X-Forge-Request-Id': id }).catch(() => undefined);
    for (let i = 0; i < 100 && incoming()?.status !== want; i++) await new Promise((r) => setTimeout(r, 50));
    expect(incoming()?.status).toBe(want);
    expect((g.deps.db.prepare('SELECT status FROM requests WHERE id = ?').get(id) as { status: string }).status).toBe('new');
    await g.close();
    return { dbPath: g.dbPath, id, amount, token };
  }

  it('after the swap, with the mint down at restart: 409 not_settled, then the full change once the mint answers, with no restart', async () => {
    const { dbPath, id, amount } = await diedAt('afterSwap');
    const faults = { mintDownOnRecovery: true };
    const g = await startGateway({ dbPath, faults });
    try {
      const inc: any = g.deps.db.prepare('SELECT status FROM incoming WHERE request_id = ?').get(id);
      expect(inc.status).toBe('prepared');
      for (let i = 0; i < 2; i++) {
        const res = await fetch(`${g.url}/v1/change/${id}`);
        expect(res.status).toBe(409);
        expect(res.headers.get('retry-after')).toBeTruthy();
        const err = (await res.json()).error;
        expect(err.code).toBe('not_settled');
        expect(err.message).not.toBe('request still running');
      }
      faults.mintDownOnRecovery = false;
      const ch = await changeFor(g, id);
      expect(ch.status).toBe(200);
      expect(await redeem((await ch.json()).token)).toBe(amount + 4);
      const row: any = g.deps.db.prepare('SELECT status, paid_units, change_units FROM requests WHERE id = ?').get(id);
      expect(row).toEqual({ status: 'aborted', paid_units: amount + 4, change_units: amount + 4 });
    } finally {
      await g.close();
    }
  });

  it('before the mint was contacted: 404 after a restart, and the token is still the payer\'s', async () => {
    const { dbPath, id, amount, token } = await diedAt('beforeSwap');
    const g = await startGateway({ dbPath });
    try {
      const res = await fetch(`${g.url}/v1/change/${id}`);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('not_found');
      expect(await redeem(token)).toBe(amount + 4);
    } finally {
      await g.close();
    }
  });
});
