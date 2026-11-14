/**
 * The daily faucet (docs/FREE-TIER.md, layer 3): free vouchers of credits, given out at /free.
 *
 * How it limits use:
 *  - A fixed daily budget of vouchers (UTC days), released in drips through the day, so nobody can take
 *    the whole day at midnight. The count per day is the only thing written down (faucet_days): no
 *    address, no time of a claim.
 *  - Proof of work per claim: the browser finds a nonce whose SHA-256 over "<challenge>:<nonce>" starts
 *    with enough zero bits (the format the v2 app already uses for a Bellows, public/v2/core/pow.js).
 *    The difficulty rises when claims come faster than the drip.
 *  - A short limit per address, held in memory only, keyed by a keyed hash of the address with a key
 *    made fresh at each start. It is never written to disk or logged.
 *
 * Steps: challenge (a random string and the bits it needs), verify (the solution; spends the challenge
 * and gives a one-time ticket), claim (the ticket; mints the voucher). A ticket whose minting fails
 * can be claimed again; a used challenge or ticket is refused.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import type { DB } from './db.ts';

const DAY_MS = 86_400_000;
const TICKET_MS = 120_000;
const MAX_NONCE = 64;
/** The longest a challenge lives, however hard it is. */
const MAX_CHALLENGE_MS = 3_600_000;

export class FaucetError extends Error {
  readonly code: string;
  readonly status: number;
  readonly extra?: Record<string, unknown>;
  constructor(code: string, message: string, status = 400, extra?: Record<string, unknown>) {
    super(message);
    this.code = code;
    this.status = status;
    if (extra) this.extra = extra;
  }
}

export interface FaucetOptions {
  db: DB;
  daily: number;
  questions: number;
  drips: number;
  powBits: number;
  powMaxBits: number;
  perAddress: number;
  challengeMs: number;
  /** Mints one voucher of `questions` credits and returns its token. */
  issue: (questions: number) => Promise<string>;
  now?: () => number;
}

/** The UTC day of a time, as YYYY-MM-DD. */
export const dayKey = (t: number): string => new Date(t).toISOString().slice(0, 10);

/**
 * The drip at a moment: how many vouchers have been released so far today, how many can be claimed now,
 * how many are left today, and when the next drip and the next day start. Pure.
 */
export function dripState(o: { daily: number; drips: number; claimed: number; now: number }) {
  const dayStart = Math.floor(o.now / DAY_MS) * DAY_MS;
  const dripMs = DAY_MS / o.drips;
  const index = Math.min(o.drips - 1, Math.floor((o.now - dayStart) / dripMs));
  const released = Math.min(o.daily, Math.floor((o.daily * (index + 1)) / o.drips));
  const available = Math.max(0, released - o.claimed);
  const leftToday = Math.max(0, o.daily - o.claimed);
  const nextDripAt = index + 1 >= o.drips ? dayStart + DAY_MS : dayStart + Math.round((index + 1) * dripMs);
  return { released, available, leftToday, nextDripAt, nextDayAt: dayStart + DAY_MS, dripSize: o.daily / o.drips, dripMs };
}

/**
 * The proof-of-work difficulty: the base, plus one bit for each doubling of the claims in the last drip
 * period over one drip's size, up to max. Pure.
 */
export function powDifficulty(o: { base: number; max: number; recentClaims: number; dripSize: number }): number {
  if (o.recentClaims <= o.dripSize || o.dripSize <= 0) return o.base;
  return Math.min(o.max, o.base + Math.ceil(Math.log2(o.recentClaims / o.dripSize)));
}

export function leadingZeroBits(buf: Uint8Array): number {
  let n = 0;
  for (const byte of buf) {
    if (byte === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(byte) - 24;
  }
  return n;
}

/** Whether "<challenge>:<nonce>" is a solution for this challenge with at least `bits` zero bits. Pure. */
export function checkSolution(challenge: string, solution: string, bits: number): boolean {
  if (typeof solution !== 'string' || !solution.startsWith(`${challenge}:`)) return false;
  const nonce = solution.slice(challenge.length + 1);
  if (!nonce || nonce.length > MAX_NONCE || !/^[0-9a-z]+$/.test(nonce)) return false;
  return leadingZeroBits(createHash('sha256').update(solution, 'utf8').digest()) >= bits;
}

export class Faucet {
  private readonly o: FaucetOptions;
  private readonly now: () => number;
  private readonly challenges = new Map<string, { bits: number; expiresAt: number }>();
  private readonly spentChallenges = new Map<string, number>();
  private readonly tickets = new Map<string, { expiresAt: number }>();
  private readonly usedTickets = new Map<string, number>();
  private readonly claiming = new Set<string>();
  /** Per address: claims today. Keys are HMACs with a key that lives only in this process. */
  private readonly addresses = new Map<string, { day: string; count: number }>();
  private readonly addressKey = randomBytes(32);
  /**
   * Per address: claims that have passed the limit and are being minted now. They count against the
   * limit, so claims sent all at once cannot each pass it before any of them is counted.
   */
  private readonly addrInFlight = new Map<string, number>();
  /** Times of recent claims, for the difficulty. No address. */
  private recent: number[] = [];
  private inFlight = 0;

  constructor(o: FaucetOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
  }

  private claimedToday(t: number): number {
    const r = this.o.db.prepare('SELECT claimed FROM faucet_days WHERE day = ?').get(dayKey(t)) as { claimed: number } | undefined;
    return r?.claimed ?? 0;
  }

  private drip(t = this.now()) {
    return dripState({ daily: this.o.daily, drips: this.o.drips, claimed: this.claimedToday(t), now: t });
  }

  private bitsNow(t: number): number {
    const d = this.drip(t);
    this.recent = this.recent.filter((x) => x > t - d.dripMs);
    return powDifficulty({ base: this.o.powBits, max: this.o.powMaxBits, recentClaims: this.recent.length, dripSize: d.dripSize });
  }

  private addressId(address: string): string {
    return createHmac('sha256', this.addressKey).update(address).digest('base64url');
  }

  /** Claims today from this address, those being minted now included. */
  private addressCount(address: string, t: number): number {
    const id = this.addressId(address);
    const a = this.addresses.get(id);
    return (a && a.day === dayKey(t) ? a.count : 0) + (this.addrInFlight.get(id) ?? 0);
  }

  /**
   * How long a challenge of this difficulty may be worked on: the base time, doubled for each bit over
   * the base, since each bit doubles the expected work. At most an hour.
   */
  challengeLifetime(bits: number): number {
    const extra = Math.max(0, bits - this.o.powBits);
    return Math.max(this.o.challengeMs, Math.min(MAX_CHALLENGE_MS, this.o.challengeMs * 2 ** extra));
  }

  /** Drops what has run out, so the maps stay small. */
  private sweep(t: number) {
    for (const [k, v] of this.challenges) if (v.expiresAt <= t) this.challenges.delete(k);
    for (const [k, exp] of this.spentChallenges) if (exp <= t) this.spentChallenges.delete(k);
    for (const [k, v] of this.tickets) if (v.expiresAt <= t) this.tickets.delete(k);
    for (const [k, exp] of this.usedTickets) if (exp <= t) this.usedTickets.delete(k);
    const day = dayKey(t);
    for (const [k, v] of this.addresses) if (v.day !== day) this.addresses.delete(k);
  }

  /** What the page shows: questions left today, whether one can be claimed now, and when more come. */
  status() {
    const t = this.now();
    const d = this.drip(t);
    const available = Math.max(0, d.available - this.inFlight);
    return {
      enabled: true,
      questions: this.o.questions,
      vouchers_left_today: d.leftToday,
      questions_left_today: d.leftToday * this.o.questions,
      available_now: available,
      // When more come: the next drip, or tomorrow once today's budget is gone.
      next_at: d.leftToday > 0 ? d.nextDripAt : d.nextDayAt,
      bits: this.bitsNow(t),
    };
  }

  private refuseIfEmpty(t: number) {
    const d = this.drip(t);
    if (d.available - this.inFlight <= 0) {
      const next = d.leftToday > 0 ? d.nextDripAt : d.nextDayAt;
      throw new FaucetError('faucet_empty', 'no free questions left right now', 429, { next_at: next, retry_after: Math.max(1, Math.ceil((next - t) / 1000)) });
    }
  }

  private refuseIfLimited(address: string, t: number) {
    if (this.o.perAddress > 0 && this.addressCount(address, t) >= this.o.perAddress) {
      const next = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS;
      throw new FaucetError('faucet_limit', 'this connection has had its free questions for today', 429, { next_at: next, retry_after: Math.max(1, Math.ceil((next - t) / 1000)) });
    }
  }

  /** A new challenge. Refused when nothing can be claimed now, or this address has had its share today. */
  challenge(address: string): { challenge: string; bits: number; expires_at: number } {
    const t = this.now();
    this.sweep(t);
    this.refuseIfEmpty(t);
    this.refuseIfLimited(address, t);
    const challenge = randomBytes(16).toString('hex');
    const bits = this.bitsNow(t);
    const expiresAt = t + this.challengeLifetime(bits);
    this.challenges.set(challenge, { bits, expiresAt });
    return { challenge, bits, expires_at: expiresAt };
  }

  /** Checks a solution. Spends the challenge and hands out a one-time ticket for the claim. */
  verify(solution: unknown): { ticket: string; expires_at: number } {
    const t = this.now();
    const s = typeof solution === 'string' ? solution : '';
    const challenge = s.split(':')[0] ?? '';
    if (this.spentChallenges.has(challenge)) throw new FaucetError('challenge_used', 'this puzzle was already used; ask for a new one', 409);
    const c = this.challenges.get(challenge);
    if (!c) throw new FaucetError('challenge_unknown', 'unknown puzzle; ask for a new one', 400);
    if (c.expiresAt <= t) {
      this.challenges.delete(challenge);
      throw new FaucetError('challenge_expired', 'this puzzle is too old; ask for a new one', 410);
    }
    if (!checkSolution(challenge, s, c.bits)) throw new FaucetError('pow_invalid', 'the puzzle answer is wrong', 400);
    this.challenges.delete(challenge);
    this.spentChallenges.set(challenge, c.expiresAt);
    const ticket = randomBytes(24).toString('base64url');
    const expiresAt = t + TICKET_MS;
    this.tickets.set(ticket, { expiresAt });
    return { ticket, expires_at: expiresAt };
  }

  /** Spends a ticket for one voucher. If minting fails, the ticket stays good until it expires. */
  async claim(address: string, ticket: unknown): Promise<{ token: string; questions: number }> {
    const t = this.now();
    this.sweep(t);
    const id = typeof ticket === 'string' ? ticket : '';
    if (this.usedTickets.has(id) || this.claiming.has(id)) throw new FaucetError('claim_used', 'this voucher was already claimed', 409);
    const tk = this.tickets.get(id);
    if (!tk) throw new FaucetError('ticket_unknown', 'unknown or expired claim; solve a new puzzle', 400);
    this.refuseIfLimited(address, t);
    this.refuseIfEmpty(t);
    const addr = this.addressId(address);
    this.tickets.delete(id);
    this.claiming.add(id);
    this.inFlight++;
    // Hold this address's place before the wait, so parallel claims count against the limit.
    this.addrInFlight.set(addr, (this.addrInFlight.get(addr) ?? 0) + 1);
    let token: string;
    try {
      token = await this.o.issue(this.o.questions);
    } catch (e) {
      // Not minted: the ticket can be claimed again.
      this.tickets.set(id, tk);
      throw new FaucetError('faucet_unavailable', 'the voucher could not be made right now; try again', 503);
    } finally {
      this.inFlight--;
      this.claiming.delete(id);
      const left = (this.addrInFlight.get(addr) ?? 1) - 1;
      if (left > 0) this.addrInFlight.set(addr, left);
      else this.addrInFlight.delete(addr);
    }
    const day = dayKey(t);
    this.o.db.prepare('INSERT INTO faucet_days (day, claimed) VALUES (?, 1) ON CONFLICT (day) DO UPDATE SET claimed = claimed + 1').run(day);
    const a = this.addresses.get(addr);
    this.addresses.set(addr, { day, count: a && a.day === day ? a.count + 1 : 1 });
    this.recent.push(t);
    this.usedTickets.set(id, t + TICKET_MS);
    return { token, questions: this.o.questions };
  }
}
