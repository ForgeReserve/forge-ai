/**
 * Free voice questions (docs/PAYMENTS.md, Free voice questions): a balance that cannot pay for turning a
 * recording into text gets it at no charge, a few times a day, and the operator pays the supplier.
 * Owner decision, 2026-11-15: hold to talk works on a $0 balance opened with an invite.
 *
 * Two limits, both per UTC day:
 *  - an allowance per balance (FORGE_FREE_VOICE_PER_DAY), and
 *  - the operator's budget (FORGE_FREE_VOICE_BUDGET_USD), counted at the supplier's cost.
 * Either at 0 turns the feature off.
 *
 * What is written down, and nothing more: for each day, the number of free requests and their summed
 * supplier cost (free_voice_days), and for each balance that used one today, a count keyed by an HMAC of
 * the balance id (free_voice_uses). The HMAC key is random, made for the day and kept in that day's row,
 * so counts survive a restart. When a new day starts, the old day's per-balance counts are deleted and
 * its key is forgotten: what is left of a past day is its two totals. No time of a request, no audio
 * and no text are stored here.
 *
 * A request takes its place in both counts before the supplier is called (so requests sent at once
 * cannot each pass the limit), and gives it back if the supplier fails: a failure is never counted.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { type DB, tx } from './db.ts';
import { dayKey } from './faucet.ts';

const DAY_MS = 86_400_000;

export const FREE_VOICE_LIMIT = 'free_voice_limit';

export class FreeVoiceError extends Error {
  readonly code = FREE_VOICE_LIMIT;
  readonly status = 402;
  readonly extra: { free_voice: FreeVoiceStatus };
  readonly retryAfter: number;
  constructor(message: string, status: FreeVoiceStatus, retryAfter: number) {
    super(message);
    this.extra = { free_voice: status };
    this.retryAfter = retryAfter;
  }
}

export interface FreeVoiceStatus {
  enabled: boolean;
  /** Free voice questions a balance gets per UTC day. */
  per_day: number;
  /** How many this balance has left today (0 when the operator's budget for today is used up). */
  left: number;
  /** When the counts start again: the next UTC midnight, in ms. */
  resets_at: number;
  /** Why none are left: this balance used its allowance, or the day's budget is used up. */
  reason?: 'allowance' | 'budget';
}

export interface FreeVoiceOptions {
  db: DB;
  perDay: number;
  budgetUsd: number;
  now?: () => number;
}

/** What a request holds while its supplier works: give it back if the supplier fails. */
export interface FreeVoiceTicket {
  release(): void;
  /** The balance's free voice questions left today, this one counted. */
  left: number;
}

interface DayRow {
  hash_key: string | null;
  used: number;
  spent_nusd: number;
}

export class FreeVoice {
  private readonly o: FreeVoiceOptions;
  private readonly now: () => number;
  private readonly budgetNano: number;

  constructor(o: FreeVoiceOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.budgetNano = Math.round(o.budgetUsd * 1e9);
  }

  get enabled(): boolean {
    return this.o.perDay > 0 && this.budgetNano > 0;
  }

  get perDay(): number {
    return this.o.perDay;
  }

  private static resetsAt(t: number): number {
    return Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
  }

  private static hash(key: string, accountId: string): string {
    return createHmac('sha256', Buffer.from(key, 'hex')).update(accountId).digest('base64url');
  }

  private row(day: string): DayRow | undefined {
    return this.o.db.prepare('SELECT hash_key, used, spent_nusd FROM free_voice_days WHERE day = ?').get(day) as DayRow | undefined;
  }

  private usedBy(day: string, key: string | null, accountId: string): number {
    if (!key) return 0;
    const r = this.o.db.prepare('SELECT used FROM free_voice_uses WHERE day = ? AND balance = ?').get(day, FreeVoice.hash(key, accountId)) as { used: number } | undefined;
    return r?.used ?? 0;
  }

  /**
   * This balance's free voice questions today. minCostNano: the least a request costs the operator (the
   * cheapest transcription), so `left` is 0 once the day's budget cannot pay for one more. Reads only.
   */
  status(accountId: string, minCostNano: number): FreeVoiceStatus {
    const t = this.now();
    const resets_at = FreeVoice.resetsAt(t);
    if (!this.enabled) return { enabled: false, per_day: 0, left: 0, resets_at };
    const day = dayKey(t);
    const r = this.row(day);
    const left = Math.max(0, this.o.perDay - this.usedBy(day, r?.hash_key ?? null, accountId));
    if (left === 0) return { enabled: true, per_day: this.o.perDay, left: 0, resets_at, reason: 'allowance' };
    if ((r?.spent_nusd ?? 0) + Math.max(0, minCostNano) > this.budgetNano) return { enabled: true, per_day: this.o.perDay, left: 0, resets_at, reason: 'budget' };
    return { enabled: true, per_day: this.o.perDay, left, resets_at };
  }

  /**
   * Takes one free voice question for this balance, costing the operator costNano. Throws
   * FreeVoiceError (402 free_voice_limit) when the balance's allowance or the day's budget is used up.
   */
  take(accountId: string, costNano: number): FreeVoiceTicket {
    const t = this.now();
    const day = dayKey(t);
    const resets_at = FreeVoice.resetsAt(t);
    const retry = Math.max(1, Math.ceil((resets_at - t) / 1000));
    const db = this.o.db;
    const cost = Math.max(0, Math.ceil(costNano));
    const { hash, used } = tx(db, () => {
      // A new day: the old days keep only their totals.
      db.prepare('DELETE FROM free_voice_uses WHERE day <> ?').run(day);
      db.prepare('UPDATE free_voice_days SET hash_key = NULL WHERE day <> ? AND hash_key IS NOT NULL').run(day);
      db.prepare('INSERT OR IGNORE INTO free_voice_days (day, hash_key, used, spent_nusd) VALUES (?, ?, 0, 0)').run(day, randomBytes(32).toString('hex'));
      const r = this.row(day)!;
      // A row whose key was forgotten (the clock went back over midnight) gets a new one.
      let key = r.hash_key;
      if (!key) {
        key = randomBytes(32).toString('hex');
        db.prepare('UPDATE free_voice_days SET hash_key = ? WHERE day = ?').run(key, day);
      }
      const h = FreeVoice.hash(key, accountId);
      const mine = this.usedBy(day, key, accountId);
      if (mine >= this.o.perDay) {
        throw new FreeVoiceError('free voice questions are used up for this balance today; type instead, or add funds', { enabled: true, per_day: this.o.perDay, left: 0, resets_at, reason: 'allowance' }, retry);
      }
      if (r.spent_nusd + cost > this.budgetNano) {
        throw new FreeVoiceError('free voice questions are used up for today; type instead, or add funds', { enabled: true, per_day: this.o.perDay, left: 0, resets_at, reason: 'budget' }, retry);
      }
      db.prepare('INSERT INTO free_voice_uses (day, balance, used) VALUES (?, ?, 1) ON CONFLICT (day, balance) DO UPDATE SET used = used + 1').run(day, h);
      db.prepare('UPDATE free_voice_days SET used = used + 1, spent_nusd = spent_nusd + ? WHERE day = ?').run(cost, day);
      return { hash: h, used: mine + 1 };
    });
    let released = false;
    return {
      left: Math.max(0, this.o.perDay - used),
      release: () => {
        if (released) return;
        released = true;
        tx(db, () => {
          db.prepare('UPDATE free_voice_uses SET used = used - 1 WHERE day = ? AND balance = ? AND used > 0').run(day, hash);
          db.prepare('DELETE FROM free_voice_uses WHERE day = ? AND balance = ? AND used <= 0').run(day, hash);
          db.prepare('UPDATE free_voice_days SET used = MAX(0, used - 1), spent_nusd = MAX(0, spent_nusd - ?) WHERE day = ?').run(cost, day);
        });
      },
    };
  }
}
