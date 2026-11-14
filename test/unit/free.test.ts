import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { checkFreeQuestion, CreditKeysets, freeRules, split } from '../../src/credits.ts';
import { openDb } from '../../src/db.ts';
import { checkSolution, dayKey, dripState, Faucet, FaucetError, leadingZeroBits, powDifficulty } from '../../src/faucet.ts';
import { Ledger } from '../../src/ledger.ts';

// The free tier (docs/FREE-TIER.md): the rules for credits and the faucet's limits, without a mint.

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [
    { id: 'free-model', supplier: 'mock', upstream: 'x', input_usd_per_mtok: 1, output_usd_per_mtok: 1, max_output_tokens: 4096 },
    { id: 'paid-model', supplier: 'mock', upstream: 'y', input_usd_per_mtok: 1, output_usd_per_mtok: 1, max_output_tokens: 1000 },
    { id: 'small-model', supplier: 'mock', upstream: 'z', input_usd_per_mtok: 1, output_usd_per_mtok: 1, max_output_tokens: 800 },
  ],
};
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A nonce that does not solve a challenge. */
function wrong(challenge: string, bits: number): string {
  for (let i = 0; ; i++) {
    const s = `${challenge}:${i.toString(36)}`;
    if (leadingZeroBits(createHash('sha256').update(s).digest()) < bits) return s;
  }
}

/** Solves a challenge in the test (few bits only). */
function solve(challenge: string, bits: number): string {
  for (let i = 0; ; i++) {
    const s = `${challenge}:${i.toString(36)}`;
    if (leadingZeroBits(createHash('sha256').update(s).digest()) >= bits) return s;
  }
}

describe('free tier settings', () => {
  it('is off by default: no credit mint, no faucet', () => {
    const c = loadConfig({}, catalog);
    expect(c.creditMint).toBeUndefined();
    expect(c.env.FORGE_FAUCET_ENABLED).toBe(false);
    expect(freeRules(c)).toBeUndefined();
  });

  it('keeps the proposed defaults: gpt-oss and gemma, 4,000 in, 1,500 out, 90 days, 1,000 vouchers of 3, 24 drips, 3 a day per address', () => {
    const e = loadConfig({}, catalog).env;
    expect(e.FORGE_FREE_MODELS).toEqual(['tinfoil/gpt-oss-120b', 'tinfoil/gemma4-31b']);
    expect([e.FORGE_FREE_MAX_INPUT_TOKENS, e.FORGE_FREE_MAX_OUTPUT_TOKENS, e.FORGE_CREDIT_KEYSET_DAYS]).toEqual([4000, 1500, 90]);
    expect([e.FORGE_FAUCET_DAILY_VOUCHERS, e.FORGE_FAUCET_QUESTIONS, e.FORGE_FAUCET_DRIPS_PER_DAY, e.FORGE_FAUCET_PER_ADDRESS]).toEqual([1000, 3, 24, 3]);
    expect(e.FORGE_CREDIT_UNIT).toBe('usd');
  });

  it('refuses a faucet without a credit mint, and a credit mint that is also a money mint', () => {
    expect(() => loadConfig({ FORGE_FAUCET_ENABLED: 'true' }, catalog)).toThrow(/FORGE_CREDIT_MINT/);
    expect(() => loadConfig({ FORGE_TRUSTED_MINTS: 'https://m.example', FORGE_CREDIT_MINT: 'https://m.example/' }, catalog)).toThrow(/never money/);
    expect(() => loadConfig({ FORGE_CREDIT_MINT: 'https://c.example', FORGE_FAUCET_POW_BITS: '20', FORGE_FAUCET_POW_MAX_BITS: '10' }, catalog)).toThrow(/MAX_BITS/);
  });

  it('lists only free models that are in the catalog', () => {
    const c = loadConfig({ FORGE_CREDIT_MINT: 'https://credits.example/', FORGE_FREE_MODELS: 'free-model,gone-model' }, catalog);
    expect(freeRules(c)).toMatchObject({ mint: 'https://credits.example', unit: 'usd', models: ['free-model'] });
  });
});

describe('a free question', () => {
  const rules = freeRules(loadConfig({ FORGE_CREDIT_MINT: 'https://credits.example', FORGE_FREE_MODELS: 'free-model,small-model' }, catalog))!;
  const model = (id: string) => catalog.models.find((m) => m.id === id)!;

  it('is refused on a model that is not on the free list', () => {
    expect(checkFreeQuestion(rules, model('paid-model'), 10, undefined)).toMatchObject({ ok: false, status: 403, code: 'not_free_model' });
  });
  it('is refused when its input is over the cap', () => {
    expect(checkFreeQuestion(rules, model('free-model'), 4001, undefined)).toMatchObject({ ok: false, code: 'free_too_long' });
    expect(checkFreeQuestion(rules, model('free-model'), 4000, undefined)).toEqual({ ok: true, maxOut: 1500 });
  });
  it('is refused when it asks for more output than the cap, and gets the cap when it does not say', () => {
    expect(checkFreeQuestion(rules, model('free-model'), 10, 1501)).toMatchObject({ ok: false, code: 'free_too_much_output' });
    expect(checkFreeQuestion(rules, model('free-model'), 10, 200)).toEqual({ ok: true, maxOut: 200 });
    // A model with a smaller limit keeps its own.
    expect(checkFreeQuestion(rules, model('small-model'), 10, undefined)).toEqual({ ok: true, maxOut: 800 });
  });
});

describe('credit keysets', () => {
  it('are taken for the set days after the gateway first saw them, or until the mint final expiry', () => {
    const db = openDb(':memory:');
    const k = new CreditKeysets(db, 90);
    const t0 = Date.UTC(2026, 0, 1);
    k.note(['00aa'], t0);
    k.note(['00aa'], t0 + DAY); // first seen stays
    expect(k.expired('00aa', undefined, t0 + 89 * DAY)).toBe(false);
    expect(k.expired('00aa', undefined, t0 + 90 * DAY)).toBe(true);
    // The mint's own final_expiry (seconds) wins when it comes first.
    expect(k.expired('00aa', (t0 + 10 * DAY) / 1000, t0 + 10 * DAY)).toBe(true);
    expect(k.expired('00aa', (t0 + 200 * DAY) / 1000, t0 + 50 * DAY)).toBe(false);
    // A keyset never seen before starts its days now.
    expect(k.expired('00bb', undefined, t0 + 500 * DAY)).toBe(false);
  });
});

describe('free balances in the ledger', () => {
  it('are not counted as money owed to customers', () => {
    const db = openDb(':memory:');
    const l = new Ledger(db);
    const paid = l.createAccountRaw('sk-forge-' + 'a'.repeat(32), 'usd', null);
    const free = l.createAccountRaw('sk-forge-' + 'b'.repeat(32), 'usd', null, true);
    l.creditRaw(paid.id, 5000, 'topup', null);
    l.creditRaw(free.id, 3000, 'topup', null);
    expect(l.get(free.id)!.free).toBe(1);
    expect(l.get(paid.id)!.free).toBe(0);
    expect(l.liabilities()).toEqual({ usd: 5000 });
  });
});

describe('voucher pieces', () => {
  it('splits into powers of two', () => {
    expect(split(3)).toEqual([2, 1]);
    expect(split(8)).toEqual([8]);
    expect(split(13)).toEqual([8, 4, 1]);
  });
});

describe('faucet maths', () => {
  it('releases the day in drips, and says when more come', () => {
    const day = Date.UTC(2026, 11, 2);
    const at = (h: number, claimed: number) => dripState({ daily: 1000, drips: 24, claimed, now: day + h * HOUR });
    expect(at(0, 0)).toMatchObject({ released: 41, available: 41, leftToday: 1000, nextDripAt: day + HOUR });
    expect(at(0.5, 41)).toMatchObject({ available: 0, leftToday: 959 });
    expect(at(1, 41)).toMatchObject({ released: 83, available: 42 });
    expect(at(23.9, 0)).toMatchObject({ released: 1000, available: 1000, nextDripAt: day + DAY });
    expect(at(23.9, 1000)).toMatchObject({ available: 0, leftToday: 0, nextDayAt: day + DAY });
    expect(dayKey(day + 23.9 * HOUR)).toBe('2026-12-02');
  });

  it('raises the difficulty one bit per doubling over the drip, up to the most', () => {
    expect(powDifficulty({ base: 20, max: 24, recentClaims: 40, dripSize: 41 })).toBe(20);
    expect(powDifficulty({ base: 20, max: 24, recentClaims: 82, dripSize: 41 })).toBe(21);
    expect(powDifficulty({ base: 20, max: 24, recentClaims: 83, dripSize: 41 })).toBe(22);
    expect(powDifficulty({ base: 20, max: 24, recentClaims: 100_000, dripSize: 41 })).toBe(24);
  });

  it('checks a solution: the right challenge, a short nonce, enough zero bits', () => {
    const s = solve('abc', 8);
    expect(checkSolution('abc', s, 8)).toBe(true);
    expect(checkSolution('abd', s, 8)).toBe(false);
    expect(checkSolution('abc', 'abc:', 0)).toBe(false);
    expect(checkSolution('abc', `abc:${'0'.repeat(65)}`, 0)).toBe(false);
    expect(checkSolution('abc', 'abc:NOT-A-NONCE', 0)).toBe(false);
    expect(checkSolution('abc', wrong('abc', 8), 8)).toBe(false);
  });
});

describe('the faucet', () => {
  const make = (o: Partial<ConstructorParameters<typeof Faucet>[0]> = {}) => {
    let now = Date.UTC(2026, 11, 2, 10);
    let n = 0;
    const db = openDb(':memory:');
    const f = new Faucet({
      db,
      daily: 48,
      questions: 3,
      drips: 24,
      powBits: 6,
      powMaxBits: 10,
      perAddress: 3,
      challengeMs: 60_000,
      issue: async (q) => `cashuBvoucher${q}-${++n}`,
      now: () => now,
      ...o,
    });
    const claimOne = async (addr = 'a') => {
      const c = f.challenge(addr);
      const v = f.verify(solve(c.challenge, c.bits));
      return f.claim(addr, v.ticket);
    };
    return { f, db, claimOne, tick: (ms: number) => (now += ms), set: (t: number) => (now = t) };
  };
  const code = async (p: Promise<unknown> | (() => unknown)) => {
    try {
      await (typeof p === 'function' ? p() : p);
    } catch (e) {
      return (e as FaucetError).code;
    }
    return 'ok';
  };

  it('gives a voucher for a solved puzzle and counts it for the day, without the address', async () => {
    const { f, db, claimOne } = make();
    expect(f.status()).toMatchObject({ enabled: true, questions: 3, vouchers_left_today: 48, questions_left_today: 144, available_now: 22 });
    expect(await claimOne()).toEqual({ token: 'cashuBvoucher3-1', questions: 3 });
    expect(db.prepare('SELECT * FROM faucet_days').all()).toEqual([{ day: '2026-12-02', claimed: 1 }]);
    expect(f.status().questions_left_today).toBe(141);
  });

  it('refuses a wrong answer, a stale puzzle, a reused puzzle and a reused claim', async () => {
    const { f, tick } = make();
    const c = f.challenge('a');
    expect(await code(() => f.verify(wrong(c.challenge, c.bits)))).toBe('pow_invalid');
    expect(await code(() => f.verify('nope:1'))).toBe('challenge_unknown');
    const v = f.verify(solve(c.challenge, c.bits));
    expect(await code(() => f.verify(solve(c.challenge, c.bits)))).toBe('challenge_used');
    await f.claim('a', v.ticket);
    expect(await code(f.claim('a', v.ticket))).toBe('claim_used');
    expect(await code(f.claim('a', 'made-up'))).toBe('ticket_unknown');
    const old = f.challenge('a');
    tick(61_000);
    expect(await code(() => f.verify(solve(old.challenge, old.bits)))).toBe('challenge_expired');
  });

  it('limits each address per day in memory, and opens again the next day', async () => {
    const { f, claimOne, tick } = make();
    for (let i = 0; i < 3; i++) await claimOne('1.2.3.4');
    expect(await code(() => f.challenge('1.2.3.4'))).toBe('faucet_limit');
    // Another address is not held back.
    expect(await code(claimOne('5.6.7.8'))).toBe('ok');
    tick(DAY);
    expect(await code(claimOne('1.2.3.4'))).toBe('ok');
  });

  it('keeps no address in a form that could be read back', async () => {
    const { f, claimOne } = make();
    await claimOne('203.0.113.9');
    const seen = JSON.stringify([...((f as any).addresses as Map<string, unknown>).keys()]);
    expect(seen).not.toContain('203.0.113.9');
  });

  it('says when more come once the drip is used up, and when the day is used up', async () => {
    const { f, claimOne, set } = make({ perAddress: 0, daily: 4, drips: 2 });
    set(Date.UTC(2026, 11, 2, 1));
    await claimOne();
    await claimOne();
    try {
      f.challenge('a');
      throw new Error('not refused');
    } catch (e) {
      expect(e).toBeInstanceOf(FaucetError);
      expect((e as FaucetError).code).toBe('faucet_empty');
      expect((e as FaucetError).extra?.next_at).toBe(Date.UTC(2026, 11, 2, 12));
    }
    set(Date.UTC(2026, 11, 2, 13));
    await claimOne();
    await claimOne();
    expect(f.status()).toMatchObject({ vouchers_left_today: 0, available_now: 0, next_at: Date.UTC(2026, 11, 3) });
  });

  it('does not spend a claim or the budget when the voucher cannot be made', async () => {
    let fail = true;
    const { f, db } = make({ issue: async () => (fail ? Promise.reject(new Error('mint down')) : 'cashuBok') });
    const c = f.challenge('a');
    const v = f.verify(solve(c.challenge, c.bits));
    expect(await code(f.claim('a', v.ticket))).toBe('faucet_unavailable');
    expect(db.prepare('SELECT * FROM faucet_days').all()).toEqual([]);
    fail = false;
    expect(await f.claim('a', v.ticket)).toEqual({ token: 'cashuBok', questions: 3 });
  });

  it('raises the difficulty when claims come faster than the drip', async () => {
    const { f, claimOne } = make({ perAddress: 0, daily: 480 });
    expect(f.status().bits).toBe(6);
    // The drip is 20 an hour: 30 claims within the hour is one doubling short of 40.
    for (let i = 0; i < 30; i++) await claimOne();
    expect(f.status().bits).toBe(7);
    for (let i = 0; i < 11; i++) await claimOne();
    expect(f.status().bits).toBe(8);
  });
});
