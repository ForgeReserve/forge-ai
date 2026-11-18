// eCash from Forge's own mint in the other unit (a sat token for a usd balance, or the reverse): the
// top-up refuses it with wrong_unit and a pointer, and the other-mint quote and confirm change it at the
// mint's own price (docs/PAYMENTS.md, Changing units). The local mints run FakeWallet backends, which pay
// every invoice without moving money, so these tests prove the gateway's states and arithmetic against
// the mint's quotes, not a Lightning payment between the Forge mint's two units.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newApiKey } from '../../src/ledger.ts';
import { createInvite, type Gateway, MINT_A, MINT_B, mintToken, mintsUp, redeem, startGateway, userWallet } from './helpers.ts';

const up = await mintsUp();
const n = (x: unknown) => Number(String(x));

async function post(g: Gateway, path: string, body: object, key?: string) {
  const res = await fetch(`${g.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as any };
}

async function get(g: Gateway, path: string, key: string) {
  const res = await fetch(`${g.url}${path}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: res.status, body: (await res.json()) as any };
}

async function waitFor(g: Gateway, id: string, key: string) {
  for (let i = 0; i < 100; i++) {
    const r = await get(g, `/v1/wallet/fund/${id}`, key);
    if (['done', 'expired', 'failed', 'refunded'].includes(r.body.state)) return r.body;
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`funding ${id} did not finish`);
}

/** Drives a funding with the poller until it is done (the restart tests use the new process's poller). */
async function tickUntilDone(g: Gateway, id: string) {
  for (let i = 0; i < 100; i++) {
    await g.deps.funding.tick();
    const r = g.deps.funding.get(id)!;
    if (['done', 'expired', 'failed', 'refunded'].includes(r.state)) return r;
    g.deps.db.prepare('UPDATE fundings SET next_check = 0 WHERE id = ?').run(id);
    await new Promise((res) => setTimeout(res, 200));
  }
  throw new Error(`funding ${id} did not finish`);
}

const topupRows = (g: Gateway, accountId: string) => (g.deps.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE account_id = ? AND kind = 'topup'").get(accountId) as { n: number }).n;

/** A balance in `unit` with `amount` on it, opened by a plain top-up of Forge eCash. */
async function balance(g: Gateway, unit: 'usd' | 'sat', amount: number) {
  const r = await post(g, '/v1/wallet/topup', { token: await mintToken(MINT_A, unit, amount), invite: createInvite(g) });
  expect(r.status).toBe(200);
  return { key: r.body.key as string, accountId: r.body.account_id as string };
}

describe.skipIf(!up)('changing units: eCash from the Forge mint in the other unit', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());

  it('lists the change among the funding methods', async () => {
    const m = (await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json()) as any;
    expect(m.convert.enabled).toBe(true);
    expect(m.convert.units.sort()).toEqual(['sat', 'usd']);
  });

  it('a sat token funds a usd balance: the top-up points to the quote, the quote is what is credited', async () => {
    const { key, accountId } = await balance(g, 'usd', 10);
    const token = await mintToken(MINT_A, 'sat', 1000);
    // The top-up still refuses it, unchanged for API clients, and now says where the change is offered.
    const refused = await post(g, '/v1/wallet/topup', { token }, key);
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('wrong_unit');
    expect(refused.body.error.message).toBe('this balance is in usd; this funding is in sat');
    expect(refused.body.convert).toEqual({ quote: '/v1/wallet/fund/foreign/quote', unit: 'usd', token_unit: 'sat' });

    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
    expect(q.status).toBe(200);
    expect(q.body.state).toBe('quoted');
    expect(q.body.unit).toBe('usd');
    const f = q.body.foreign;
    expect(f).toMatchObject({ mint: MINT_A, unit: 'sat', token_amount: 1000, convert: true, unlisted: false });
    expect(f.credit).toBeGreaterThan(0);
    expect(f.fee_max).toBeGreaterThan(0);
    // Nothing is taken before the yes.
    expect(g.deps.db.prepare("SELECT COUNT(*) AS n FROM incoming WHERE purpose = 'foreign'").get()).toEqual({ n: 0 });
    // The credit is the Forge invoice's amount, the mint's own quote, and the token's mint can pay it.
    const row = g.deps.funding.get(q.body.id)!;
    const melt = await (await userWallet(MINT_A, 'sat')).checkMeltQuoteBolt11(row.f_melt_quote!);
    expect(melt.request).toBe(row.request);
    expect(n(melt.amount) + n(melt.fee_reserve)).toBeLessThanOrEqual(1000);
    expect(n((await (await userWallet(MINT_A, 'usd')).checkMintQuoteBolt11(row.quote!)).amount)).toBe(f.credit);

    const c = await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
    expect(c.status).toBe(200);
    const done = c.body.state === 'done' ? c.body : await waitFor(g, q.body.id, key);
    expect(done.state).toBe('done');
    expect(done.credited).toBe(f.credit);
    expect(done.balance_msub).toBe((10 + f.credit) * 1000);
    expect(topupRows(g, accountId)).toBe(2);
    // What the fees did not use comes back as sat eCash from the Forge mint.
    const back = await redeem(done.foreign.change_token, MINT_A, 'sat');
    expect(back).toBeGreaterThan(0);
    expect(back + f.fee_max).toBeLessThanOrEqual(1000);
    // The held sat proofs are spent: none is counted as the gateway's own.
    expect(g.deps.db.prepare("SELECT COUNT(*) AS n FROM proofs WHERE op_id = ? AND state != 'spent'").get(q.body.id)).toEqual({ n: 0 });
  });

  it('a usd token funds a sat balance', async () => {
    const { key } = await balance(g, 'sat', 100);
    const token = await mintToken(MINT_A, 'usd', 200);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'sat' }, key);
    expect(q.status).toBe(200);
    expect(q.body.foreign).toMatchObject({ unit: 'usd', token_amount: 200, convert: true });
    const credit = q.body.foreign.credit as number;
    expect(credit).toBeGreaterThan(0);
    await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
    const done = await waitFor(g, q.body.id, key);
    expect(done.state).toBe('done');
    expect(done.credited).toBe(credit);
    expect(done.balance_msub).toBe((100 + credit) * 1000);
  });

  it('a same-unit top-up is unchanged: added directly, no fees, no funding; the quote sends it back to the top-up', async () => {
    const { key, accountId } = await balance(g, 'usd', 10);
    const token = await mintToken(MINT_A, 'usd', 37);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
    expect(q.status).toBe(400);
    expect(q.body.error.code).toBe('use_topup');
    const r = await post(g, '/v1/wallet/topup', { token }, key);
    expect(r.status).toBe(200);
    expect(r.body.credited).toBe(37);
    expect(r.body.balance_msub).toBe(47_000);
    expect(g.deps.funding.list(accountId)).toEqual([]);
  });

  it('a token spent twice is refused once: a second change of it, and a top-up of it after the change', async () => {
    const { key, accountId } = await balance(g, 'usd', 10);
    const token = await mintToken(MINT_A, 'sat', 800);
    const q1 = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
    const q2 = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
    expect(q1.status).toBe(200);
    expect(q2.status).toBe(200);
    await post(g, '/v1/wallet/fund/foreign/confirm', { id: q1.body.id, token }, key);
    const done = await waitFor(g, q1.body.id, key);
    expect(done.state).toBe('done');
    const again = await post(g, '/v1/wallet/fund/foreign/confirm', { id: q2.body.id, token }, key);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('token_spent');
    expect(g.deps.funding.get(q2.body.id)!.state).toBe('quoted');
    const { key: satKey } = await balance(g, 'sat', 5);
    const topup = await post(g, '/v1/wallet/topup', { token }, satKey);
    expect(topup.body.error.code).toBe('token_spent');
    expect(g.deps.ledger.get(accountId)!.balance_msub).toBe((10 + done.credited) * 1000);
    expect(topupRows(g, accountId)).toBe(2);
  });

  it('a free balance refuses: money never goes on it', async () => {
    const key = newApiKey();
    g.deps.ledger.createAccountRaw(key, 'usd', null, true);
    const token = await mintToken(MINT_A, 'sat', 300);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
    expect(q.status).toBe(409);
    expect(q.body.error.code).toBe('wrong_balance');
    // The token is untouched: it still adds to a sat balance.
    const { key: satKey } = await balance(g, 'sat', 5);
    expect((await post(g, '/v1/wallet/topup', { token }, satKey)).body.credited).toBe(300);
  });
});

describe.skipIf(!up)('changing units: limits and settings', () => {
  it('the Lightning limit of the balance unit applies to the credit; the other-mint caps and policy do not', async () => {
    const g = await startGateway({
      env: {
        FORGE_FUND_MAX_USD: '50',
        FORGE_FOREIGN_POLICY: 'allowlist',
        FORGE_FOREIGN_MAX_SAT: '100',
        FORGE_FOREIGN_UNLISTED_MAX_SAT: '100',
        FORGE_FOREIGN_ENABLED: 'false',
      },
    });
    try {
      const { key } = await balance(g, 'usd', 10);
      // About 97 cents at the test rate: over the 50 cent limit.
      const big = await post(g, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_A, 'sat', 1000), unit: 'usd' }, key);
      expect(big.status).toBe(400);
      expect(big.body.error.code).toBe('amount_too_large');
      expect(big.body.error.message).toMatch(/limited to 50 usd/);
      // 400 sat is over both other-mint caps (100 sat), yet a change from Forge's own mint goes ahead.
      const token = await mintToken(MINT_A, 'sat', 400);
      const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
      expect(q.status).toBe(200);
      expect(q.body.foreign.credit).toBeLessThanOrEqual(50);
      await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
      expect((await waitFor(g, q.body.id, key)).credited).toBe(q.body.foreign.credit);
      // Too small to pay the fees.
      const tiny = await post(g, '/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_A, 'sat', 2), unit: 'usd' }, key);
      expect(tiny.status).toBe(400);
      expect(tiny.body.error.code).toBe('insufficient_amount');
    } finally {
      await g.close();
    }
  });

  it('FORGE_CONVERT_ENABLED=false: no change, and the top-up answers plain wrong_unit', async () => {
    const g = await startGateway({ env: { FORGE_CONVERT_ENABLED: 'false' } });
    try {
      const m = (await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json()) as any;
      expect(m.convert).toEqual({ enabled: false, units: [] });
      const { key } = await balance(g, 'usd', 10);
      const token = await mintToken(MINT_A, 'sat', 500);
      const r = await post(g, '/v1/wallet/topup', { token }, key);
      expect(r.body.error.code).toBe('wrong_unit');
      expect(r.body.convert).toBeUndefined();
      const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
      expect(q.status).toBe(400);
      expect(q.body.error.code).toBe('method_unavailable');
    } finally {
      await g.close();
    }
  });

  it('another trusted mint: its sat eCash is melted there into a Forge usd invoice', async () => {
    const g = await startGateway({ env: { FORGE_TRUSTED_MINTS: `${MINT_A},${MINT_B}` } });
    try {
      const { key } = await balance(g, 'usd', 10);
      const token = await mintToken(MINT_B, 'sat', 1500);
      const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
      expect(q.status).toBe(200);
      expect(q.body.foreign).toMatchObject({ mint: MINT_B, convert: true });
      expect(q.body.mint).toBe(MINT_A);
      await post(g, '/v1/wallet/fund/foreign/confirm', { id: q.body.id, token }, key);
      const done = await waitFor(g, q.body.id, key);
      expect(done.credited).toBe(q.body.foreign.credit);
      expect(await redeem(done.foreign.change_token, MINT_B, 'sat')).toBeGreaterThan(0);
    } finally {
      await g.close();
    }
  });
});

describe.skipIf(!up)('changing units: a crash at each state, then a restart, credits exactly once', () => {
  /** A usd balance and a quoted change of a sat token, on a gateway with the given faults. */
  async function quoted(opts: Parameters<typeof startGateway>[0] = {}) {
    const { faults, ...rest } = opts;
    const g = await startGateway(rest);
    const { key, accountId } = await balance(g, 'usd', 10);
    // Wallet faults start after the balance is open, so they hit only the change.
    if (faults) (g.deps.wallet as any).opts.faults = faults;
    const token = await mintToken(MINT_A, 'sat', 900);
    const q = await post(g, '/v1/wallet/fund/foreign/quote', { token, unit: 'usd' }, key);
    expect(q.status).toBe(200);
    return { g, key, accountId, token, id: q.body.id as string, credit: q.body.foreign.credit as number };
  }

  async function finishOn(dbPath: string, f: { id: string; accountId: string; credit: number; key: string }, opts: Parameters<typeof startGateway>[0] = {}) {
    const g2 = await startGateway({ dbPath, ...opts });
    try {
      const done = await tickUntilDone(g2, f.id);
      expect(done.state).toBe('done');
      expect(done.credited).toBe(f.credit);
      expect(g2.deps.ledger.get(f.accountId)!.balance_msub).toBe((10 + f.credit) * 1000);
      expect(topupRows(g2, f.accountId)).toBe(2);
      // Another pass of the poller, a status read and a second confirm add nothing.
      await g2.deps.funding.advance(f.id);
      await get(g2, `/v1/wallet/fund/${f.id}`, f.key);
      expect(g2.deps.ledger.get(f.accountId)!.balance_msub).toBe((10 + f.credit) * 1000);
      return { g2, done };
    } catch (e) {
      await g2.close();
      throw e;
    }
  }

  it('quoted: nothing is taken; after a restart the same quote confirms and credits once', async () => {
    const f = await quoted();
    await f.g.close();
    const g2 = await startGateway({ dbPath: f.g.dbPath });
    try {
      expect(g2.deps.db.prepare("SELECT COUNT(*) AS n FROM incoming WHERE purpose = 'foreign'").get()).toEqual({ n: 0 });
      const c = await post(g2, '/v1/wallet/fund/foreign/confirm', { id: f.id, token: f.token }, f.key);
      expect(c.status).toBe(200);
    } finally {
      await g2.close();
    }
    const { g2: g3 } = await finishOn(f.g.dbPath, f);
    await g3.close();
  });

  it('receiving: the swap at the mint went through but the write was lost; startup recovery and the poller finish it', async () => {
    const f = await quoted({ faults: { afterReceiveSwap: true } });
    const c = await post(f.g, '/v1/wallet/fund/foreign/confirm', { id: f.id, token: f.token }, f.key);
    expect(c.body.state).toBe('receiving');
    expect(f.g.deps.db.prepare("SELECT status FROM incoming WHERE request_id = ?").get(f.id)).toEqual({ status: 'prepared' });
    await f.g.close();
    const { g2 } = await finishOn(f.g.dbPath, f);
    await g2.close();
  });

  it('melting: the melt was paid but the write was lost; the restart reads the melt quote and credits once', async () => {
    const f = await quoted({ fundingFaults: { afterMelt: true } });
    const c = await post(f.g, '/v1/wallet/fund/foreign/confirm', { id: f.id, token: f.token }, f.key);
    expect(c.status).toBe(200);
    expect(c.body.state).toBe('melting');
    expect(f.g.deps.funding.get(f.id)!.f_melt_op).toBeTruthy();
    await f.g.close();
    const { g2, done } = await finishOn(f.g.dbPath, f);
    try {
      expect(await redeem(done.f_change_token!, MINT_A, 'sat')).toBeGreaterThan(0);
    } finally {
      await g2.close();
    }
  });

  it('pending: the invoice is paid and nothing is minted yet; the restart mints and credits once', async () => {
    const f = await quoted();
    // Stop the confirm right after the melt: the funding waits for the Forge invoice (pending).
    (f.g.deps.funding as any).checkQuote = async () => {};
    const c = await post(f.g, '/v1/wallet/fund/foreign/confirm', { id: f.id, token: f.token }, f.key);
    expect(c.body.state).toBe('pending');
    expect(f.g.deps.ledger.get(f.accountId)!.balance_msub).toBe(10_000);
    await f.g.close();
    const { g2 } = await finishOn(f.g.dbPath, f);
    await g2.close();
  });

  it.each([
    ['NUT-19 replay', false],
    ['NUT-09 restore', true],
  ])('minting: the Forge mint signed but the credit was not written; the restart recovers via %s and credits once', async (_n, noReplay) => {
    const f = await quoted({ fundingFaults: { afterMint: true } });
    await post(f.g, '/v1/wallet/fund/foreign/confirm', { id: f.id, token: f.token }, f.key);
    let row = f.g.deps.funding.get(f.id)!;
    for (let i = 0; i < 50 && row.state !== 'minting'; i++) {
      await f.g.deps.funding.advance(f.id).catch(() => {});
      row = f.g.deps.funding.get(f.id)!;
      if (row.state !== 'minting') await new Promise((res) => setTimeout(res, 200));
    }
    expect(row.state).toBe('minting');
    expect(f.g.deps.ledger.get(f.accountId)!.balance_msub).toBe(10_000);
    await f.g.close();
    const { g2 } = await finishOn(f.g.dbPath, f, { fundingFaults: { noReplay } });
    try {
      // The minted usd proofs are real: the balance can be taken out.
      const out = await post(g2, '/v1/wallet/refund', { amount: 10 + f.credit }, f.key);
      expect(out.status).toBe(200);
      expect(await redeem(out.body.token, MINT_A, 'usd')).toBe(10 + f.credit);
    } finally {
      await g2.close();
    }
  });

  it('done: the credit is written; a restart and the poller change nothing', async () => {
    const f = await quoted();
    await post(f.g, '/v1/wallet/fund/foreign/confirm', { id: f.id, token: f.token }, f.key);
    await waitFor(f.g, f.id, f.key);
    await f.g.close();
    const { g2 } = await finishOn(f.g.dbPath, f);
    await g2.close();
  });
});
