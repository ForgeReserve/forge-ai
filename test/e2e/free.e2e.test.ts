import { createHash } from 'node:crypto';
import { getTokenMetadata } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintCredits } from '../../src/credits.ts';
import { leadingZeroBits } from '../../src/faucet.ts';
import { revenue } from '../../src/revenue.ts';
import { chatBody, createInvite, creditMintUp, type Gateway, MINT_A, MINT_C, MINT_CREDIT, mintsUp, mintToken, readSse, redeem, startGateway } from './helpers.ts';

// The free tier (docs/FREE-TIER.md) against the local credit mint (pnpm mint:up): credits make a free
// balance, a free balance pays one credit per question on the free model list and within the caps,
// comes out only as credits, and money and credits never turn into each other. Then the faucet.

let g: Gateway;
let off: Gateway;
let clock = Date.UTC(2026, 11, 2, 10);

const FREE_ENV = {
  FORGE_INVITE_ONLY: 'true',
  FORGE_CREDIT_MINT: MINT_CREDIT,
  FORGE_FREE_MODELS: 'mock-echo,mock-fail',
  FORGE_FREE_MAX_INPUT_TOKENS: '300',
  FORGE_FREE_MAX_OUTPUT_TOKENS: '100',
  FORGE_FAUCET_ENABLED: 'true',
  FORGE_FAUCET_DAILY_VOUCHERS: '4',
  FORGE_FAUCET_DRIPS_PER_DAY: '1',
  FORGE_FAUCET_PER_ADDRESS: '2',
  FORGE_FAUCET_POW_BITS: '6',
  FORGE_FAUCET_POW_MAX_BITS: '8',
  FORGE_FAUCET_CHALLENGE_SECONDS: '60',
  // So the tests can stand in for several addresses.
  FORGE_TRUST_PROXY: 'true',
  // The local test mints are on http, as in the other-mint funding tests.
  FORGE_FOREIGN_ALLOW_INSECURE: 'true',
};

beforeAll(async () => {
  if (!(await mintsUp()) || !(await creditMintUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: FREE_ENV, audio: true, faucetNow: () => clock });
  off = await startGateway({ env: { FORGE_INVITE_ONLY: 'false' } });
}, 60_000);

afterAll(async () => {
  await g?.close();
  await off?.close();
});

const credits = async (n: number) => (await mintCredits({ issueUrl: MINT_CREDIT, publicUrl: MINT_CREDIT, unit: 'usd', amounts: [n] }))[0]!;
const post = (path: string, body: unknown, headers: Record<string, string> = {}, gw = g) =>
  fetch(`${gw.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const balance = async (key: string) => (await (await fetch(`${g.url}/v1/wallet`, { headers: auth(key) })).json()) as any;

/** A free balance with `n` credits. */
async function freeBalance(n = 3): Promise<string> {
  const r = await post('/v1/wallet/topup', { token: await credits(n) });
  expect(r.status).toBe(200);
  return ((await r.json()) as any).key;
}

describe('credits make a free balance', () => {
  it('opens a free balance from a credit voucher, without an invite, and lists the free rules', async () => {
    const r = await post('/v1/wallet/topup', { token: await credits(3) });
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b).toMatchObject({ unit: 'usd', free: true, credited: 3, balance_msub: 3000 });
    expect(b.key).toMatch(/^sk-forge-/);
    expect(await balance(b.key)).toMatchObject({ free: true, balance_msub: 3000, refundable: 3 });
    const m = (await (await fetch(`${g.url}/v1/models`)).json()) as any;
    expect(m.free).toEqual({ mint: MINT_CREDIT, unit: 'usd', models: ['mock-echo', 'mock-fail'], max_input_tokens: 300, max_output_tokens: 100, faucet: { questions: 3 } });
    // The credit mint is never offered as a mint to pay in.
    expect(m.mints).toEqual([MINT_A]);
    const methods = (await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json()) as any;
    expect(methods.free).toEqual({ enabled: true, questions: 3 });
  });

  it('is off without a credit mint: a credit voucher is from a mint the engine does not take', async () => {
    const r = await post('/v1/wallet/topup', { token: await credits(1) }, {}, off);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe('untrusted_mint');
    expect(((await (await fetch(`${off.url}/v1/models`)).json()) as any).free).toBeNull();
  });

  it('refuses credits from an expired keyset', async () => {
    const token = await credits(1);
    // Every keyset the gateway has seen at the credit mint, dated 91 days back.
    const ids = (g.deps.db.prepare('SELECT keyset_id FROM credit_keysets').all() as Array<{ keyset_id: string }>).map((r) => r.keyset_id);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) g.deps.db.prepare('UPDATE credit_keysets SET first_seen = ? WHERE keyset_id = ?').run(Date.now() - 91 * 86_400_000, id);
    try {
      const r = await post('/v1/wallet/topup', { token });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe('credits_expired');
      // Not taken: still good at the credit mint.
      expect(await redeem(token, MINT_CREDIT, 'usd')).toBe(1);
    } finally {
      for (const id of ids) g.deps.db.prepare('UPDATE credit_keysets SET first_seen = ? WHERE keyset_id = ?').run(Date.now(), id);
    }
  });
});

describe('a free balance pays free questions only', () => {
  it('charges exactly one credit for an answered question on a free model, streamed or not', async () => {
    const key = await freeBalance(3);
    const r = await post('/v1/chat/completions', chatBody('mock-echo'), auth(key));
    expect(r.status).toBe(200);
    expect(r.headers.get('x-forge-charged-msub')).toBe('1000');
    expect(r.headers.get('x-forge-balance-msub')).toBe('2000');
    const s = await post('/v1/chat/completions', { model: 'mock-echo', messages: [{ role: 'user', content: 'Hi' }], stream: true }, auth(key));
    const { forge } = await readSse(s);
    expect(forge).toMatchObject({ charged_msub: 1000, balance_msub: 1000 });
  });

  it('caps the answer when the question does not say how long, and refuses a question over the caps', async () => {
    const key = await freeBalance(2);
    const r = await post('/v1/chat/completions', { model: 'mock-echo', messages: [{ role: 'user', content: 'Hi' }] }, auth(key));
    expect(r.status).toBe(200);
    const asked = await post('/v1/chat/completions', chatBody('mock-echo', { max_tokens: 101 }), auth(key));
    expect(asked.status).toBe(400);
    expect(((await asked.json()) as any).error.code).toBe('free_too_much_output');
    const long = await post('/v1/chat/completions', chatBody('mock-echo', { messages: [{ role: 'user', content: 'x'.repeat(2000) }] }), auth(key));
    expect(long.status).toBe(400);
    expect(((await long.json()) as any).error.code).toBe('free_too_long');
    expect((await balance(key)).balance_msub).toBe(1000);
  });

  it('refuses to spend credits on a paid model, and charges nothing', async () => {
    const key = await freeBalance(1);
    const r = await post('/v1/chat/completions', chatBody('mock-slow'), auth(key));
    expect(r.status).toBe(403);
    expect((await r.json()) as any).toMatchObject({ error: { code: 'not_free_model' }, free_models: ['mock-echo', 'mock-fail'] });
    const speech = await post('/v1/audio/speech', { model: 'mock-speech', input: 'Hello.' }, auth(key));
    expect(speech.status).toBe(403);
    expect(((await speech.json()) as any).error.code).toBe('not_free_model');
    expect((await balance(key)).balance_msub).toBe(1000);
  });

  it('gives the credit back when the model fails', async () => {
    const key = await freeBalance(1);
    const r = await post('/v1/chat/completions', chatBody('mock-fail'), auth(key));
    expect(r.status).toBe(502);
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    expect((await balance(key)).balance_msub).toBe(1000);
  });

  it('refuses credits paid per request without a balance', async () => {
    const r = await post('/v1/chat/completions', chatBody('mock-echo'), { 'x-cashu': await credits(1), 'x-forge-invite': createInvite(g) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe('credits_need_balance');
  });
});

describe('credits never become money, and money never becomes credits', () => {
  it('takes a free balance out only as credits from the credit mint', async () => {
    const key = await freeBalance(3);
    const r = await post('/v1/wallet/refund', { amount: 2 }, auth(key));
    expect(r.status).toBe(200);
    const b = (await r.json()) as any;
    expect(b).toMatchObject({ amount: 2, unit: 'usd', free: true, status: 'done' });
    expect(getTokenMetadata(b.token).mint).toBe(MINT_CREDIT);
    expect(await redeem(b.token, MINT_CREDIT, 'usd')).toBe(2);
    expect((await balance(key)).balance_msub).toBe(1000);
  });

  it('refuses money on a free balance and credits on a paid balance, and spends neither', async () => {
    const freeKey = await freeBalance(1);
    const money = await mintToken(MINT_A, 'usd', 50);
    const r1 = await post('/v1/wallet/topup', { token: money }, auth(freeKey));
    expect(r1.status).toBe(409);
    expect(((await r1.json()) as any).error.code).toBe('wrong_balance');

    const paid = (await (await post('/v1/wallet/topup', { token: money, invite: createInvite(g) })).json()) as any;
    expect(paid).toMatchObject({ free: false, credited: 50 });
    const voucher = await credits(2);
    const r2 = await post('/v1/wallet/topup', { token: voucher }, auth(paid.key));
    expect(r2.status).toBe(409);
    expect(((await r2.json()) as any).error.code).toBe('wrong_balance');
    expect(await redeem(voucher, MINT_CREDIT, 'usd')).toBe(2);
    expect((await balance(paid.key)).balance_msub).toBe(50_000);
  });

  it('refuses every other way of putting money on a free balance', async () => {
    const key = await freeBalance(1);
    const ln = await post('/v1/wallet/fund/lightning', { amount: 10, unit: 'usd' }, auth(key));
    expect(ln.status).toBe(409);
    expect(((await ln.json()) as any).error.code).toBe('wrong_balance');
  });

  it('refuses to melt credits into a paid balance through other-mint funding', async () => {
    const r = await post('/v1/wallet/fund/foreign/quote', { token: await credits(2), unit: 'usd', invite: createInvite(g) });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe('credits_not_money');
    // A real other mint still works the same way as before.
    const other = await post('/v1/wallet/fund/foreign/quote', { token: await mintToken(MINT_C, 'usd', 100), unit: 'usd', invite: createInvite(g) });
    expect(other.status).toBe(200);
  });

  it('leaves credits and free balances out of revenue', async () => {
    const r = revenue(g.deps, 'usd');
    expect(r.holdings.some((h) => h.mint === MINT_CREDIT)).toBe(false);
    const paidMsub = (g.deps.db.prepare('SELECT COALESCE(SUM(balance_msub), 0) AS s FROM accounts WHERE free = 0').get() as { s: number }).s;
    expect(r.liabilities_msub).toBe(paidMsub);
  });
});

/** Solves a faucet puzzle in the test. */
function solve(challenge: string, bits: number): string {
  for (let i = 0; ; i++) {
    const s = `${challenge}:${i.toString(36)}`;
    if (leadingZeroBits(createHash('sha256').update(s).digest()) >= bits) return s;
  }
}
function wrong(challenge: string, bits: number): string {
  for (let i = 0; ; i++) {
    const s = `${challenge}:${i.toString(36)}`;
    if (leadingZeroBits(createHash('sha256').update(s).digest()) < bits) return s;
  }
}

const from = (ip: string) => ({ 'x-forwarded-for': ip });
async function challenge(ip: string) {
  return (await (await post('/v1/free/challenge', {}, from(ip))).json()) as any;
}
async function ticketFor(ip: string) {
  const c = await challenge(ip);
  const v = await post('/v1/free/verify', { solution: solve(c.challenge, c.bits) }, from(ip));
  expect(v.status).toBe(200);
  return ((await v.json()) as any).ticket as string;
}

describe('the faucet', () => {
  it('is not there while it is off', async () => {
    expect((await fetch(`${off.url}/v1/free`)).status).toBe(404);
    expect((await post('/v1/free/challenge', {}, {}, off)).status).toBe(404);
    expect((await post('/v1/free/claim', { ticket: 'x' }, {}, off)).status).toBe(404);
    expect((await fetch(`${off.url}/free`)).status).toBe(404);
    expect((await fetch(`${off.url}/v2/free/free.js`)).status).toBe(404);
    expect(((await (await fetch(`${off.url}/v1/wallet/fund/methods`)).json()) as any).free).toEqual({ enabled: false, questions: null });
  });

  it('serves the /free page while it is on', async () => {
    const r = await fetch(`${g.url}/free`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('/v2/free/free.js');
    expect((await fetch(`${g.url}/v2/free/free.js`)).status).toBe(200);
  });

  it('gives a voucher of 3 credits for a solved puzzle, which adds 3 free questions', async () => {
    const s = (await (await fetch(`${g.url}/v1/free`)).json()) as any;
    expect(s).toMatchObject({ enabled: true, questions: 3, vouchers_left_today: 4, questions_left_today: 12, available_now: 4 });
    const ticket = await ticketFor('198.51.100.1');
    const r = await post('/v1/free/claim', { ticket }, from('198.51.100.1'));
    expect(r.status).toBe(200);
    const v = (await r.json()) as any;
    expect(v).toMatchObject({ questions: 3, mint: MINT_CREDIT, unit: 'usd' });
    expect(getTokenMetadata(v.token).mint).toBe(MINT_CREDIT);
    const t = (await (await post('/v1/wallet/topup', { token: v.token })).json()) as any;
    expect(t).toMatchObject({ free: true, credited: 3 });
    // A replayed claim gets nothing.
    const again = await post('/v1/free/claim', { ticket }, from('198.51.100.1'));
    expect(again.status).toBe(409);
    expect(((await again.json()) as any).error.code).toBe('claim_used');
  });

  it('refuses a wrong answer, a replayed puzzle and a stale puzzle', async () => {
    const ip = '198.51.100.2';
    const c = await challenge(ip);
    const bad = await post('/v1/free/verify', { solution: wrong(c.challenge, c.bits) }, from(ip));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.code).toBe('pow_invalid');
    const good = solve(c.challenge, c.bits);
    expect((await post('/v1/free/verify', { solution: good }, from(ip))).status).toBe(200);
    const replay = await post('/v1/free/verify', { solution: good }, from(ip));
    expect(replay.status).toBe(409);
    expect(((await replay.json()) as any).error.code).toBe('challenge_used');
    const old = await challenge(ip);
    clock += 61_000;
    const stale = await post('/v1/free/verify', { solution: solve(old.challenge, old.bits) }, from(ip));
    expect(stale.status).toBe(410);
    expect(((await stale.json()) as any).error.code).toBe('challenge_expired');
  });

  it('limits each address per day, then runs out and says when more come', async () => {
    const ip = '198.51.100.3';
    for (let i = 0; i < 2; i++) expect((await post('/v1/free/claim', { ticket: await ticketFor(ip) }, from(ip))).status).toBe(200);
    const limited = await post('/v1/free/challenge', {}, from(ip));
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as any).error.code).toBe('faucet_limit');
    // One voucher of today's four is left: another address takes it, then the faucet is empty.
    expect((await post('/v1/free/claim', { ticket: await ticketFor('198.51.100.4') }, from('198.51.100.4'))).status).toBe(200);
    const empty = await post('/v1/free/challenge', {}, from('198.51.100.5'));
    expect(empty.status).toBe(429);
    const body = (await empty.json()) as any;
    expect(body.error.code).toBe('faucet_empty');
    expect(body.next_at).toBe(Date.UTC(2026, 11, 3));
    expect(Number(empty.headers.get('retry-after'))).toBeGreaterThan(0);
    expect((await (await fetch(`${g.url}/v1/free`)).json()) as any).toMatchObject({ vouchers_left_today: 0, available_now: 0, next_at: Date.UTC(2026, 11, 3) });
    // Nothing about an address was written down: only the count for the day.
    expect(g.deps.db.prepare('SELECT * FROM faucet_days').all()).toEqual([{ day: '2026-12-02', claimed: 4 }]);
  });
});
