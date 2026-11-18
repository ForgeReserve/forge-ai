// Two balances (docs/PAYMENTS.md, Two balances), against the local mints: a phone with a dollar balance
// that receives sat eCash opens its sat balance with the dollar key (X-Forge-Sibling), with no invite and
// no change of units, and the app's rule (public/v2/core/balances.js payUnit, on the holds of
// public/v2/core/price.js) pays a question in full from dollars first, then from sats.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BTC_USD, chatBody, createInvite, type Gateway, MINT_A, mintToken, mintsUp, redeem, startGateway } from './helpers.ts';

const up = await mintsUp();
const { holdMsub }: any = await import('../../public/v2/core/price.js' as string);
const { payUnit }: any = await import('../../public/v2/core/balances.js' as string);

async function post(g: Gateway, path: string, body: object, headers: Record<string, string> = {}) {
  const res = await fetch(`${g.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const count = (g: Gateway, sql: string, ...args: string[]) => (g.deps.db.prepare(sql).get(...args) as { n: number }).n;

describe.skipIf(!up)('two balances: sat eCash on a phone that holds dollars', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway({ env: { FORGE_UNITS: 'usd,sat' } });
  });
  afterAll(() => g.close());

  it('says so in the funding methods', async () => {
    const m = (await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json()) as any;
    expect(m.sibling).toEqual({ enabled: true, header: 'X-Forge-Sibling' });
    expect(m.invite_only).toBe(true);
  });

  it('opens the sat balance with the dollar key: no invite, no conversion, no fee, and only once', async () => {
    const usd = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 5), invite: createInvite(g) });
    expect(usd.status).toBe(200);
    const invitesBefore = count(g, "SELECT COUNT(*) AS n FROM invites WHERE status = 'open'");

    // The sat token goes to a sat balance as it is: credited in full, in sats, no funding (no melt, no quote).
    const sat = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'sat', 1000) }, { 'X-Forge-Sibling': usd.body.key });
    expect(sat.status).toBe(200);
    expect(sat.body).toMatchObject({ unit: 'sat', credited: 1000, balance_msub: 1_000_000 });
    expect(sat.body.key).toMatch(/^sk-forge-/);
    expect(sat.body.key).not.toBe(usd.body.key);
    expect(count(g, 'SELECT COUNT(*) AS n FROM fundings')).toBe(0);
    // The dollar balance is untouched, no invite was spent, and the one link is the sibling's sibling_of.
    expect((await (await fetch(`${g.url}/v1/wallet`, { headers: auth(usd.body.key) })).json()).balance_msub).toBe(5000);
    expect(count(g, "SELECT COUNT(*) AS n FROM invites WHERE status = 'open'")).toBe(invitesBefore);
    expect(g.deps.db.prepare('SELECT sibling_of FROM accounts WHERE id = ?').get(sat.body.account_id)).toEqual({ sibling_of: usd.body.account_id });

    // Only once: the dollar key opens no second sat balance, and the sat key opens nothing.
    const t1 = await mintToken(MINT_A, 'sat', 10);
    const again = await post(g, '/v1/wallet/topup', { token: t1 }, { 'X-Forge-Sibling': usd.body.key });
    expect(again.status).toBe(403);
    expect(again.body.error.code).toBe('sibling_refused');
    const t2 = await mintToken(MINT_A, 'usd', 10);
    const chain = await post(g, '/v1/wallet/topup', { token: t2 }, { 'X-Forge-Sibling': sat.body.key });
    expect(chain.status).toBe(403);
    expect(chain.body.error.code).toBe('sibling_refused');
    // Both refused tokens were left untouched: they are still the sender's.
    expect(await redeem(t1, MINT_A, 'sat')).toBe(10);
    expect(await redeem(t2, MINT_A, 'usd')).toBe(10);
    // More sat eCash goes on the sat balance with its own key.
    const more = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'sat', 20) }, auth(sat.body.key));
    expect(more.body).toMatchObject({ unit: 'sat', credited: 20, balance_msub: 1_020_000 });
  });

  it('a lost answer costs nothing: the key the phone made and kept, sent again with the same token, is a replay', async () => {
    const { newKey }: any = await import('../../public/v2/core/balances.js' as string);
    const usd = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 5), invite: createInvite(g) });
    const token = await mintToken(MINT_A, 'sat', 700);
    // The phone makes the sat key and keeps it before sending (app.js makeKey), then sends it as the bearer.
    const mine = newKey(crypto.getRandomValues(new Uint8Array(24)));
    const headers = { 'X-Forge-Sibling': usd.body.key, ...auth(mine) };
    const first = await post(g, '/v1/wallet/topup', { token }, headers);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ unit: 'sat', credited: 700 });
    // No key in the answer: the phone has it already. The answer is lost; the same request again:
    expect(first.body.key).toBeUndefined();
    const again = await post(g, '/v1/wallet/topup', { token }, headers);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ unit: 'sat', replay: true, credited: 0, balance_msub: 700_000, account_id: first.body.account_id });
    // Credited once, on the key the phone holds, and only one sat balance was opened.
    expect((await (await fetch(`${g.url}/v1/wallet`, { headers: auth(mine) })).json()).balance_msub).toBe(700_000);
    expect(count(g, 'SELECT COUNT(*) AS n FROM accounts WHERE sibling_of = ?', usd.body.account_id)).toBe(1);
    // A funding route sent again with the key and the header after the balance exists is that balance's, never a 403.
    const ln = await post(g, '/v1/wallet/fund/lightning', { amount: 10, unit: 'sat' }, headers);
    expect(ln.status).toBe(200);
    expect(ln.body.account_id).toBe(first.body.account_id);
  });

  it('pays each question in full from dollars first, then from sats once the dollars cannot cover the hold', async () => {
    const usd = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 5), invite: createInvite(g) });
    const sat = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, 'sat', 1000) }, { 'X-Forge-Sibling': usd.body.key });
    const keys: Record<string, string> = { usd: usd.body.key, sat: sat.body.key };
    const models = (await (await fetch(`${g.url}/v1/models`)).json()) as any;
    // flat-echo: $0.03 for a short question, held and charged exactly, so the turn to sats is exact.
    const model = models.data.find((m: any) => m.id === 'flat-echo');
    expect(models.btc_usd).toBe(BTC_USD);
    const wallet = async (key: string) => (await (await fetch(`${g.url}/v1/wallet`, { headers: auth(key) })).json()) as any;

    const ask = async () => {
      const body = chatBody('flat-echo');
      const bytes = new TextEncoder().encode(JSON.stringify(body)).length;
      const hold = { usd: holdMsub(model, 'usd', { bodyBytes: bytes, maxOut: body.max_tokens, btcUsd: models.btc_usd }), sat: holdMsub(model, 'sat', { bodyBytes: bytes, maxOut: body.max_tokens, btcUsd: models.btc_usd }) };
      const available = { usd: (await wallet(keys.usd!)).available_msub, sat: (await wallet(keys.sat!)).available_msub };
      const unit = payUnit({ available, hold });
      const r = await post(g, '/v1/chat/completions', body, auth(keys[unit]!));
      expect(r.status).toBe(200);
      return { unit, hold, charged: Number(r.headers.get('x-forge-charged-msub')), balance: Number(r.headers.get('x-forge-balance-msub')) };
    };

    // 5 cents: the first question (3 cents) is paid from dollars.
    const q1 = await ask();
    expect(q1).toMatchObject({ unit: 'usd', hold: { usd: 3000, sat: 30_000 }, charged: 3000, balance: 2000 });
    // 2 cents left: not enough for a 3 cent hold, so the whole question is paid from sats (30 sat), never split.
    const q2 = await ask();
    expect(q2).toMatchObject({ unit: 'sat', charged: 30_000, balance: 970_000 });
    expect((await wallet(keys.usd!)).balance_msub).toBe(2000);
    // And sats keep paying while the dollars stay short.
    expect((await ask()).unit).toBe('sat');
    // With no rate, a sat balance cannot pay: the hold in sats is null, and the 2 cents do not cover it.
    const noRate = { usd: holdMsub(model, 'usd', { bodyBytes: 100, maxOut: 64, btcUsd: null }), sat: holdMsub(model, 'sat', { bodyBytes: 100, maxOut: 64, btcUsd: null }) };
    expect(noRate.sat).toBeNull();
    expect(payUnit({ available: { usd: 2000, sat: 940_000 }, hold: noRate })).toBeNull();
  });
});
