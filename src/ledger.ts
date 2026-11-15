import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Unit } from './config.ts';
import { type DB, now, tx } from './db.ts';
import { log } from './log.ts';

export const KEY_PREFIX = 'sk-forge-';

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function newApiKey(): string {
  return KEY_PREFIX + randomBytes(24).toString('base64url');
}

export function isApiKeyShape(k: string): boolean {
  return /^sk-forge-[A-Za-z0-9_-]{24,64}$/.test(k);
}

export interface Account {
  id: string;
  unit: Unit;
  balance_msub: number;
  invite_id: string | null;
  created_at: number;
  /** 1 for a free balance: funded with credits, pays only free questions, refunds only as credits. */
  free: number;
}

export class LedgerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export class Ledger {
  readonly db: DB;
  /**
   * Reservations this process is still serving. Held in memory on purpose: after a restart nothing
   * is live, so every reservation left active is abandoned and the sweep may release it.
   */
  private readonly live = new Set<string>();
  constructor(db: DB) {
    this.db = db;
  }

  findByKey(key: string): Account | undefined {
    return this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at, free FROM accounts WHERE key_hash = ?').get(sha256(key)) as
      | Account
      | undefined;
  }

  get(id: string): Account | undefined {
    return this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at, free FROM accounts WHERE id = ?').get(id) as Account | undefined;
  }

  /** Must run inside a transaction when combined with other writes. */
  createAccountRaw(key: string, unit: Unit, inviteId: string | null, free = false): Account {
    const id = 'acct_' + randomUUID();
    this.db
      .prepare('INSERT INTO accounts (id, key_hash, unit, balance_msub, invite_id, created_at, free) VALUES (?, ?, ?, 0, ?, ?, ?)')
      .run(id, sha256(key), unit, inviteId, now(), free ? 1 : 0);
    return this.get(id)!;
  }

  /** Raw credit; caller provides the transaction. */
  creditRaw(accountId: string, msub: number, kind: string, ref: string | null) {
    this.db.prepare('UPDATE accounts SET balance_msub = balance_msub + ? WHERE id = ?').run(msub, accountId);
    this.db.prepare('INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(accountId, kind, msub, ref, now());
  }

  reservedMsub(accountId: string): number {
    const r = this.db.prepare("SELECT COALESCE(SUM(amount_msub), 0) AS s FROM reservations WHERE account_id = ? AND status = 'active'").get(accountId) as {
      s: number;
    };
    return r.s;
  }

  available(accountId: string): number {
    const a = this.get(accountId);
    if (!a) return 0;
    return a.balance_msub - this.reservedMsub(accountId);
  }

  /** Atomically holds msub against the balance. Throws insufficient_balance. */
  reserve(accountId: string, msub: number): string {
    return tx(this.db, () => {
      const a = this.get(accountId);
      if (!a) throw new LedgerError('invalid_key', 'unknown account', 401);
      if (this.isFrozen(accountId)) throw new LedgerError('account_frozen', 'this balance is frozen by the operator; refunds still work', 403);
      const avail = a.balance_msub - this.reservedMsub(accountId);
      if (avail < msub) {
        throw new LedgerError('insufficient_balance', `balance too low: need ${msub} msub, available ${avail} msub`, 402);
      }
      const id = 'res_' + randomUUID();
      this.db.prepare("INSERT INTO reservations (id, account_id, amount_msub, status, created_at) VALUES (?, ?, ?, 'active', ?)").run(id, accountId, msub, now());
      this.live.add(id);
      return id;
    });
  }

  /** True while the request that made this reservation is still being served by this process. */
  isLive(reservationId: string): boolean {
    return this.live.has(reservationId);
  }

  /**
   * The owning request ended without settling (an error escaped the handler): the reservation is
   * abandoned and the stale sweep releases it. A later settle() still charges.
   */
  disown(reservationId: string) {
    this.live.delete(reservationId);
  }

  /**
   * Settles a reservation: charges min(actual, reserved) and releases the rest.
   * Idempotent: a second call on a settled reservation returns the first result.
   * A reservation the stale sweep already released is still charged min(actual, reserved), capped at
   * what the balance now covers (balance less other active reservations); any shortfall is recorded
   * on the reservation and logged.
   */
  settle(reservationId: string, actualMsub: number, ref: string): { charged: number; balance: number; shortfall: number } {
    try {
      return tx(this.db, () => {
        const r = this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId) as any;
        if (!r) throw new Error('unknown reservation');
        if (r.status !== 'active' && r.status !== 'released') {
          return { charged: r.charged_msub ?? 0, balance: this.get(r.account_id)!.balance_msub, shortfall: r.shortfall_msub ?? 0 };
        }
        const owed = Math.max(0, Math.min(Math.ceil(actualMsub), r.amount_msub));
        let charged = owed;
        if (r.status === 'released') {
          const a = this.get(r.account_id)!;
          charged = Math.min(owed, Math.max(0, a.balance_msub - this.reservedMsub(r.account_id)));
        }
        const shortfall = owed - charged;
        if (charged > 0) {
          this.db.prepare('UPDATE accounts SET balance_msub = balance_msub - ? WHERE id = ?').run(charged, r.account_id);
          this.db.prepare("INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, 'charge', ?, ?, ?)").run(r.account_id, -charged, ref, now());
        }
        this.db
          .prepare("UPDATE reservations SET status = 'settled', charged_msub = ?, shortfall_msub = ?, settled_at = ? WHERE id = ?")
          .run(charged, shortfall, now(), reservationId);
        if (r.status === 'released') {
          log.warn('settled_after_release', { reservation_id: reservationId, ref, owed_msub: owed, charged_msub: charged, shortfall_msub: shortfall });
        }
        return { charged, balance: this.get(r.account_id)!.balance_msub, shortfall };
      });
    } finally {
      this.live.delete(reservationId);
    }
  }

  /**
   * Releases, without charge, active reservations older than olderThanMs that no request in this
   * process owns: those left by a crash or restart, or disowned by a request that ended without
   * settling. A reservation still being served is never released, however old.
   */
  releaseStale(olderThanMs: number): number {
    return tx(this.db, () => {
      const rows = this.db.prepare("SELECT id FROM reservations WHERE status = 'active' AND created_at <= ?").all(now() - olderThanMs) as Array<{ id: string }>;
      const release = this.db.prepare("UPDATE reservations SET status = 'released', charged_msub = 0, settled_at = ? WHERE id = ? AND status = 'active'");
      let n = 0;
      for (const { id } of rows) {
        if (this.live.has(id)) continue;
        n += Number(release.run(now(), id).changes);
      }
      return n;
    });
  }

  /** Debits whole units for a refund; caller provides the transaction. Returns msub debited. */
  debitRaw(accountId: string, msub: number, kind: string, ref: string) {
    const r = this.db.prepare('UPDATE accounts SET balance_msub = balance_msub - ? WHERE id = ? AND balance_msub >= ?').run(msub, accountId, msub);
    if (Number(r.changes) !== 1) throw new LedgerError('insufficient_balance', 'balance changed, retry', 409);
    this.db.prepare('INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, ?, ?, ?, ?)').run(accountId, kind, -msub, ref, now());
  }

  isFrozen(accountId: string): boolean {
    const r = this.db.prepare('SELECT frozen_at FROM accounts WHERE id = ?').get(accountId) as { frozen_at: number | null } | undefined;
    return !!r?.frozen_at;
  }

  /** Operator freeze: blocks reserve() (all spending). Refunds (debitRaw) and credits still work. */
  setFrozen(accountId: string, frozen: boolean): boolean {
    const r = this.db.prepare('UPDATE accounts SET frozen_at = ? WHERE id = ?').run(frozen ? now() : null, accountId);
    return Number(r.changes) > 0;
  }

  list(): Array<Account & { reserved_msub: number }> {
    const rows = this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at, free FROM accounts ORDER BY created_at').all() as unknown as Account[];
    return rows.map((a) => ({ ...a, reserved_msub: this.reservedMsub(a.id) }));
  }

  /** Total customer liability per unit, in msub. Free balances hold credits, not money, so they are not counted. */
  liabilities(): Record<string, number> {
    const rows = this.db.prepare('SELECT unit, COALESCE(SUM(balance_msub), 0) AS s FROM accounts WHERE free = 0 GROUP BY unit').all() as Array<{ unit: string; s: number }>;
    return Object.fromEntries(rows.map((r) => [r.unit, r.s]));
  }
}

export class Invites {
  readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  create(label?: string): { id: string; code: string } {
    const code = 'inv-' + randomBytes(12).toString('base64url');
    const id = 'invite_' + randomUUID();
    this.db.prepare("INSERT INTO invites (id, code_hash, label, status, created_at) VALUES (?, ?, ?, 'open', ?)").run(id, sha256(code), label ?? null, now());
    return { id, code };
  }

  lookup(code: string): { id: string; status: string; account_id: string | null } | undefined {
    return this.db.prepare('SELECT id, status, account_id FROM invites WHERE code_hash = ?').get(sha256(code)) as any;
  }

  /** Valid for NUT-24 use: exists and is not revoked. Counts uses. */
  checkForNut24(code: string | undefined): boolean {
    if (!code) return false;
    const inv = this.lookup(code);
    if (!inv || inv.status === 'revoked') return false;
    this.db.prepare('UPDATE invites SET nut24_uses = nut24_uses + 1 WHERE id = ?').run(inv.id);
    return true;
  }

  /** Redeems once, binding the invite to an account. Caller provides the transaction. */
  redeemRaw(code: string, accountId: string): string {
    const inv = this.lookup(code);
    if (!inv || inv.status === 'revoked') throw new LedgerError('invite_invalid', 'invite code is not valid', 403);
    if (inv.status === 'redeemed') throw new LedgerError('invite_used', 'invite code was already redeemed', 403);
    this.db.prepare("UPDATE invites SET status = 'redeemed', account_id = ?, redeemed_at = ? WHERE id = ?").run(accountId, now(), inv.id);
    return inv.id;
  }

  revoke(idOrCode: string): boolean {
    const r = this.db.prepare("UPDATE invites SET status = 'revoked' WHERE id = ? OR code_hash = ?").run(idOrCode, sha256(idOrCode));
    return Number(r.changes) > 0;
  }

  list() {
    return this.db.prepare('SELECT id, label, status, account_id, nut24_uses, created_at, redeemed_at FROM invites ORDER BY created_at').all();
  }
}

/**
 * A pass's expiry as `pnpm admin passes:create --expires` takes it: a date alone (2026-12-05) is that
 * day's start in UTC; a full ISO time is taken as given. Returns ms, or NaN when it is not a date.
 */
export function passExpiry(v: string | undefined): number {
  if (!v) return NaN;
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T00:00:00Z` : v);
}

export interface Pass {
  id: string;
  label: string | null;
  status: 'open' | 'revoked';
  max_uses: number;
  uses: number;
  expires_at: number;
  created_at: number;
}

/**
 * Event passes (docs/ADMIN.md, Event passes): one code for a room full of people, behind one QR code
 * (`/j#<code>`). Each use opens one balance at 0 for the free models, through POST /v1/wallet/open only:
 * a pass never stands in for an invite on a funded top-up or a NUT-24 request. Refused once max_uses
 * balances were opened with it, from expires_at on, and once revoked. Only a SHA-256 of the code is stored.
 */
export class Passes {
  readonly db: DB;
  constructor(db: DB) {
    this.db = db;
  }

  create(p: { maxUses: number; expiresAt: number; label?: string }): { id: string; code: string; expires_at: number } {
    if (!Number.isInteger(p.maxUses) || p.maxUses < 1) throw new LedgerError('invalid_request', 'a pass needs at least one use');
    if (!Number.isFinite(p.expiresAt) || p.expiresAt <= now()) throw new LedgerError('invalid_request', 'a pass must expire in the future');
    // 96 random bits, short enough that the QR code stays easy to scan from a projected slide.
    const code = 'pass-' + randomBytes(12).toString('base64url');
    const id = 'pass_' + randomUUID();
    this.db
      .prepare("INSERT INTO passes (id, code_hash, label, status, max_uses, uses, expires_at, created_at) VALUES (?, ?, ?, 'open', ?, 0, ?, ?)")
      .run(id, sha256(code), p.label ?? null, p.maxUses, Math.floor(p.expiresAt), now());
    return { id, code, expires_at: Math.floor(p.expiresAt) };
  }

  lookup(code: string): Pass | undefined {
    return this.db.prepare('SELECT id, label, status, max_uses, uses, expires_at, created_at FROM passes WHERE code_hash = ?').get(sha256(code)) as Pass | undefined;
  }

  /** Why a pass opens nothing now, as a LedgerError, or null when it may open a balance. */
  refusal(p: Pass): LedgerError | null {
    if (p.status !== 'open') return new LedgerError('invite_invalid', 'invite code is not valid', 403);
    if (now() >= p.expires_at) return new LedgerError('pass_expired', 'this event pass has expired', 403);
    if (p.uses >= p.max_uses) return new LedgerError('pass_used_up', 'this event pass was used as many times as it allows', 403);
    return null;
  }

  /**
   * Counts one use, in one statement, so two opens at the cap cannot both pass. Caller provides the
   * transaction (the balance is created in it). Throws the refusal when the pass opens nothing now.
   */
  useRaw(id: string): void {
    const r = this.db.prepare("UPDATE passes SET uses = uses + 1 WHERE id = ? AND status = 'open' AND uses < max_uses AND expires_at > ?").run(id, now());
    if (Number(r.changes) === 1) return;
    const p = this.db.prepare('SELECT id, label, status, max_uses, uses, expires_at, created_at FROM passes WHERE id = ?').get(id) as Pass | undefined;
    throw (p && this.refusal(p)) ?? new LedgerError('invite_invalid', 'invite code is not valid', 403);
  }

  revoke(idOrCode: string): boolean {
    const r = this.db.prepare("UPDATE passes SET status = 'revoked' WHERE id = ? OR code_hash = ?").run(idOrCode, sha256(idOrCode));
    return Number(r.changes) > 0;
  }

  list(): Pass[] {
    return this.db.prepare('SELECT id, label, status, max_uses, uses, expires_at, created_at FROM passes ORDER BY created_at').all() as unknown as Pass[];
  }
}
