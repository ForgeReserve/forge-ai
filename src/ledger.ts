import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Unit } from './config.ts';
import { type DB, now, tx } from './db.ts';

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
  constructor(db: DB) {
    this.db = db;
  }

  findByKey(key: string): Account | undefined {
    return this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at FROM accounts WHERE key_hash = ?').get(sha256(key)) as
      | Account
      | undefined;
  }

  get(id: string): Account | undefined {
    return this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at FROM accounts WHERE id = ?').get(id) as Account | undefined;
  }

  /** Must run inside a transaction when combined with other writes. */
  createAccountRaw(key: string, unit: Unit, inviteId: string | null): Account {
    const id = 'acct_' + randomUUID();
    this.db
      .prepare('INSERT INTO accounts (id, key_hash, unit, balance_msub, invite_id, created_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(id, sha256(key), unit, inviteId, now());
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
      return id;
    });
  }

  /**
   * Settles a reservation: charges min(actual, reserved) and releases the rest.
   * Idempotent: a second call on a settled reservation returns the first result.
   */
  settle(reservationId: string, actualMsub: number, ref: string): { charged: number; balance: number } {
    return tx(this.db, () => {
      const r = this.db.prepare('SELECT * FROM reservations WHERE id = ?').get(reservationId) as any;
      if (!r) throw new Error('unknown reservation');
      if (r.status !== 'active') {
        return { charged: r.charged_msub ?? 0, balance: this.get(r.account_id)!.balance_msub };
      }
      const charged = Math.max(0, Math.min(Math.ceil(actualMsub), r.amount_msub));
      if (charged > 0) {
        this.db.prepare('UPDATE accounts SET balance_msub = balance_msub - ? WHERE id = ?').run(charged, r.account_id);
        this.db.prepare("INSERT INTO ledger (account_id, kind, amount_msub, ref, created_at) VALUES (?, 'charge', ?, ?, ?)").run(r.account_id, -charged, ref, now());
      }
      this.db.prepare("UPDATE reservations SET status = 'settled', charged_msub = ?, settled_at = ? WHERE id = ?").run(charged, now(), reservationId);
      return { charged, balance: this.get(r.account_id)!.balance_msub };
    });
  }

  /** On startup: reservations left active by a crash are released without charge. */
  releaseStale(olderThanMs: number): number {
    const res = this.db
      .prepare("UPDATE reservations SET status = 'released', charged_msub = 0, settled_at = ? WHERE status = 'active' AND created_at <= ?")
      .run(now(), now() - olderThanMs);
    return Number(res.changes);
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
    const rows = this.db.prepare('SELECT id, unit, balance_msub, invite_id, created_at FROM accounts ORDER BY created_at').all() as unknown as Account[];
    return rows.map((a) => ({ ...a, reserved_msub: this.reservedMsub(a.id) }));
  }

  /** Total customer liability per unit, in msub. */
  liabilities(): Record<string, number> {
    const rows = this.db.prepare('SELECT unit, COALESCE(SUM(balance_msub), 0) AS s FROM accounts GROUP BY unit').all() as Array<{ unit: string; s: number }>;
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
