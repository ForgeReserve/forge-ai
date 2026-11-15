import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatBody, createInvite, expectedMsub, type Gateway, MINT_A, mintsUp, mintToken, readSse, redeem, startGateway } from './helpers.ts';

// Free models (docs/PAYMENTS.md, Free models) against the local mints (pnpm mint:up): a balance key at 0
// or funded is never held or charged on a free model, a NUT-24 token sent for one is refused untouched
// (it still redeems at the mint afterwards), and a paid model on the same gateway charges as before.

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

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${g.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const wallet = async (key: string) => (await (await fetch(`${g.url}/v1/wallet`, { headers: auth(key) })).json()) as any;

describe('free models', () => {
  it('serve a balance opened with an invite and nothing on it, then the same key funded, never charging', async () => {
    const opened = await (await post('/v1/wallet/open', { invite: createInvite(g) })).json();
    expect(opened.balance_msub).toBe(0);
    const r = await post('/v1/chat/completions', chatBody('free-echo'), auth(opened.key));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    // Funded later like any balance: the free model still takes nothing, a paid one is charged as before.
    const top = await post('/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 20) }, auth(opened.key));
    expect(top.status).toBe(200);
    const s = await post('/v1/chat/completions', chatBody('free-echo', { stream: true }), auth(opened.key));
    const { forge } = await readSse(s);
    expect(forge).toMatchObject({ charged_msub: 0, balance_msub: 20_000 });
    expect((await wallet(opened.key)).balance_msub).toBe(20_000);
    const paid = await post('/v1/chat/completions', chatBody('mock-echo'), auth(opened.key));
    expect(paid.status).toBe(200);
    const charged = Number(paid.headers.get('x-forge-charged-msub'));
    const usage = (await paid.json()).usage;
    expect(charged).toBe(expectedMsub(usage.prompt_tokens, usage.completion_tokens));
    expect((await wallet(opened.key)).balance_msub).toBe(20_000 - charged);
  });

  it('refuse a NUT-24 token without touching it: it still redeems at the mint', async () => {
    const token = await mintToken(MINT_A, 'usd', 5);
    const r = await post('/v1/chat/completions', chatBody('free-echo'), { 'x-cashu': token, 'x-forge-invite': createInvite(g) });
    expect(r.status).toBe(401);
    expect((await r.json()).error.code).toBe('balance_key_required');
    expect(r.headers.get('x-cashu')).toBeNull();
    expect(await redeem(token)).toBe(5);
  });

  it('refuse a request with no key and no token, with no payment request', async () => {
    const r = await post('/v1/chat/completions', chatBody('free-echo'), { 'x-forge-invite': createInvite(g) });
    expect(r.status).toBe(401);
    expect(r.headers.get('x-cashu')).toBeNull();
  });
});
