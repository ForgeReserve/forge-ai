import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { FreeVoice, FreeVoiceError } from '../../src/free-voice.ts';

// Free voice questions (docs/PAYMENTS.md, Free voice questions): the per-balance allowance and the
// operator's budget, per UTC day, and what is written down to count them.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 10, 15, 9, 30);
/** One transcription at the supplier's cost: $0.01, in nano-USD. */
const COST = 10_000_000;

function make(o: { perDay?: number; budgetUsd?: number } = {}) {
  const db = openDb(':memory:');
  let t = T0;
  const fv = new FreeVoice({ db, perDay: o.perDay ?? 20, budgetUsd: o.budgetUsd ?? 5, now: () => t });
  return { db, fv, at: (ms: number) => (t = ms), now: () => t };
}

const refusal = (f: () => unknown): FreeVoiceError => {
  try {
    f();
  } catch (e) {
    if (e instanceof FreeVoiceError) return e;
    throw e;
  }
  throw new Error('expected a FreeVoiceError');
};

describe('settings', () => {
  const catalog = { suppliers: { mock: { type: 'mock', tier: 'standard' } }, models: [{ id: 'm', supplier: 'mock', upstream: 'm', input_usd_per_mtok: 1, output_usd_per_mtok: 1 }] };
  it('defaults to 20 a balance a day and a $5.00 budget, and refuses bad values', () => {
    const c = loadConfig({}, catalog);
    expect(c.env.FORGE_FREE_VOICE_PER_DAY).toBe(20);
    expect(c.env.FORGE_FREE_VOICE_BUDGET_USD).toBe(5);
    expect(loadConfig({ FORGE_FREE_VOICE_PER_DAY: '0', FORGE_FREE_VOICE_BUDGET_USD: '0' }, catalog).env.FORGE_FREE_VOICE_PER_DAY).toBe(0);
    expect(() => loadConfig({ FORGE_FREE_VOICE_PER_DAY: '-1' }, catalog)).toThrow(/FORGE_FREE_VOICE_PER_DAY/);
    expect(() => loadConfig({ FORGE_FREE_VOICE_PER_DAY: '2.5' }, catalog)).toThrow(/FORGE_FREE_VOICE_PER_DAY/);
    expect(() => loadConfig({ FORGE_FREE_VOICE_BUDGET_USD: '-0.01' }, catalog)).toThrow(/FORGE_FREE_VOICE_BUDGET_USD/);
    expect(() => loadConfig({ FORGE_FREE_VOICE_BUDGET_USD: 'lots' }, catalog)).toThrow(/FORGE_FREE_VOICE_BUDGET_USD/);
  });

  it('is off when either limit is 0', () => {
    expect(make({ perDay: 0 }).fv.enabled).toBe(false);
    expect(make({ budgetUsd: 0 }).fv.enabled).toBe(false);
    expect(make().fv.enabled).toBe(true);
    expect(make({ perDay: 0 }).fv.status('acct', COST)).toMatchObject({ enabled: false, left: 0 });
  });
});

describe('the allowance per balance', () => {
  it('gives each balance its allowance a day, and refuses the next with free_voice_limit', () => {
    const { fv } = make();
    for (let i = 1; i <= 20; i++) expect(fv.take('acct_a', COST).left).toBe(20 - i);
    const e = refusal(() => fv.take('acct_a', COST));
    expect(e.code).toBe('free_voice_limit');
    expect(e.status).toBe(402);
    expect(e.extra.free_voice).toEqual({ enabled: true, per_day: 20, left: 0, resets_at: Date.UTC(2026, 10, 16), reason: 'allowance' });
    expect(e.retryAfter).toBe((Date.UTC(2026, 10, 16) - T0) / 1000);
    expect(fv.status('acct_a', COST)).toMatchObject({ left: 0, reason: 'allowance' });
    // Another balance has its own allowance.
    expect(fv.status('acct_b', COST)).toEqual({ enabled: true, per_day: 20, left: 20, resets_at: Date.UTC(2026, 10, 16) });
    expect(fv.take('acct_b', COST).left).toBe(19);
  });

  it('gives a question back when it is released (the supplier failed)', () => {
    const { fv, db } = make({ perDay: 2 });
    fv.take('acct', COST);
    const t = fv.take('acct', COST);
    expect(fv.status('acct', COST).left).toBe(0);
    t.release();
    t.release(); // twice changes nothing
    expect(fv.status('acct', COST).left).toBe(1);
    expect(db.prepare('SELECT used, spent_nusd FROM free_voice_days').get()).toEqual({ used: 1, spent_nusd: COST });
  });
});

describe("the operator's budget", () => {
  it('counts the supplier cost of every balance together, and refuses once the day is spent', () => {
    const { fv } = make({ budgetUsd: 0.05 });
    for (let i = 0; i < 5; i++) fv.take(`acct_${i}`, COST);
    const e = refusal(() => fv.take('acct_new', COST));
    expect(e.extra.free_voice).toMatchObject({ left: 0, reason: 'budget' });
    // The app is told before recording: none left for anyone today.
    expect(fv.status('acct_new', COST)).toMatchObject({ enabled: true, left: 0, reason: 'budget' });
    // A cheaper request that still fits is served.
    const { fv: fv2 } = make({ budgetUsd: 0.015 });
    fv2.take('a', COST);
    expect(() => fv2.take('b', COST)).toThrow(FreeVoiceError);
    expect(fv2.take('b', 5_000_000).left).toBe(19);
  });
});

describe('UTC days', () => {
  it('starts both counts again at midnight UTC, and keeps only the totals of a past day', () => {
    const { fv, db, at } = make({ perDay: 1, budgetUsd: 0.01 });
    fv.take('acct', COST);
    expect(() => fv.take('acct', COST)).toThrow(FreeVoiceError);
    at(Date.UTC(2026, 10, 15, 23, 59, 59));
    expect(() => fv.take('other', COST)).toThrow(FreeVoiceError); // the budget is today's
    at(Date.UTC(2026, 10, 16, 0, 0, 1));
    expect(fv.status('acct', COST)).toEqual({ enabled: true, per_day: 1, left: 1, resets_at: Date.UTC(2026, 10, 17) });
    expect(fv.take('acct', COST).left).toBe(0);
    const days = db.prepare('SELECT day, hash_key, used, spent_nusd FROM free_voice_days ORDER BY day').all() as any[];
    // Yesterday: its totals, and its key forgotten. Today: its key.
    expect(days[0]).toEqual({ day: '2026-11-15', hash_key: null, used: 1, spent_nusd: COST });
    expect(days[1]).toMatchObject({ day: '2026-11-16', used: 1, spent_nusd: COST });
    expect(days[1].hash_key).toMatch(/^[0-9a-f]{64}$/);
    // Yesterday's per-balance counts are gone.
    expect(db.prepare('SELECT DISTINCT day FROM free_voice_uses').all()).toEqual([{ day: '2026-11-16' }]);
  });
});

describe('what is stored', () => {
  it('keeps counts under a keyed hash of the balance: no balance id, no time of a request', () => {
    const { fv, db } = make();
    const id = 'acct_0123456789abcdef';
    fv.take(id, COST);
    fv.take(id, COST);
    fv.take('acct_other', COST);
    const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols('free_voice_days')).toEqual(['day', 'hash_key', 'used', 'spent_nusd']);
    expect(cols('free_voice_uses')).toEqual(['day', 'balance', 'used']);
    const uses = db.prepare('SELECT * FROM free_voice_uses ORDER BY used DESC').all() as any[];
    expect(uses.map((u) => u.used)).toEqual([2, 1]);
    for (const u of uses) {
      expect(u.balance).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(u.balance).not.toContain('acct');
    }
    const all = JSON.stringify([db.prepare('SELECT * FROM free_voice_days').all(), uses]);
    expect(all).not.toContain(id);
    expect(all).not.toContain('acct_other');
    expect(all).not.toContain(String(T0).slice(0, 8));
  });
});
