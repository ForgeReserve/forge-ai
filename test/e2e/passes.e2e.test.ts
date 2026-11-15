import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatBody, type Gateway, MINT_A, mintsUp, mintToken, redeem, startGateway } from './helpers.ts';

// Event passes (docs/ADMIN.md, Event passes) against the local mints (pnpm mint:up): POST /v1/wallet/open
// opens a $0 balance per use for the free models, up to the pass's cap; the key takes funds later like
// any balance. A pass never stands in for an invite where money comes in: a top-up or a NUT-24 payment
// sent with one is refused before its token is touched, and the token still redeems at the mint.

let g: Gateway;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true' },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'free-echo', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'e2e', max_output_tokens: 256 });
    },
  });
}, 60_000);

afterAll(async () => {
  await g?.close();
});

const DAY = 24 * 3600 * 1000;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${g.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const pass = (uses: number) => g.deps.passes.create({ maxUses: uses, expiresAt: Date.now() + DAY, label: 'e2e' });
const used = (id: string) => (g.deps.db.prepare('SELECT uses FROM passes WHERE id = ?').get(id) as { uses: number }).uses;

describe('an event pass on POST /v1/wallet/open', () => {
  it('opens one $0 balance per use up to its cap, each answered free and funded later like any balance', async () => {
    const p = pass(2);
    const a = await (await post('/v1/wallet/open', { invite: p.code })).json();
    const b = await (await post('/v1/wallet/open', { invite: p.code })).json();
    expect(a).toMatchObject({ created: true, balance_msub: 0 });
    expect(b).toMatchObject({ created: true, balance_msub: 0 });
    expect(a.key).not.toBe(b.key);
    expect(used(p.id)).toBe(2);

    const third = await post('/v1/wallet/open', { invite: p.code });
    expect(third.status).toBe(403);
    expect((await third.json()).error.code).toBe('pass_used_up');

    const free = await post('/v1/chat/completions', chatBody('free-echo'), auth(a.key));
    expect(free.status).toBe(200);
    expect(free.headers.get('x-forge-charged-msub')).toBe('0');
    // The key takes eCash like any balance key: no invite is asked of a balance that exists.
    const top = await post('/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 10) }, auth(a.key));
    expect(top.status).toBe(200);
    expect((await top.json()).balance_msub).toBe(10_000);
    const paid = await post('/v1/chat/completions', chatBody('mock-echo'), auth(a.key));
    expect(paid.status).toBe(200);
    // Known key, sent again with the used-up pass: answered as it is, no use counted.
    const again = await post('/v1/wallet/open', { invite: p.code }, auth(b.key));
    expect(again.status).toBe(200);
    expect((await again.json()).created).toBe(false);
    expect(used(p.id)).toBe(2);
  });

  it('is refused for a top-up with no key: the token is not touched and still redeems', async () => {
    const p = pass(10);
    const token = await mintToken(MINT_A, 'usd', 7);
    const r = await post('/v1/wallet/topup', { token, invite: p.code });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('invite_required');
    expect(used(p.id)).toBe(0);
    expect(await redeem(token)).toBe(7);
  });

  it('is refused as X-Forge-Invite on a NUT-24 payment: the token is not touched and still redeems', async () => {
    const p = pass(10);
    const token = await mintToken(MINT_A, 'usd', 5);
    const r = await post('/v1/chat/completions', chatBody('mock-echo'), { 'x-cashu': token, 'x-forge-invite': p.code });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('invite_required');
    expect(used(p.id)).toBe(0);
    expect(await redeem(token)).toBe(5);
  });
});
