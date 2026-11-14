import { describe, expect, it, vi } from 'vitest';
import { openDb, tx } from '../../src/db.ts';
import { setLogSilent } from '../../src/log.ts';
import { Invites, isApiKeyShape, Ledger, newApiKey, sha256 } from '../../src/ledger.ts';

function setup() {
  const db = openDb(':memory:');
  const ledger = new Ledger(db);
  const key = newApiKey();
  const a = tx(db, () => {
    const a = ledger.createAccountRaw(key, 'usd', null);
    ledger.creditRaw(a.id, 10_000, 'topup', null);
    return a;
  });
  return { db, ledger, key, a };
}

describe('ledger', () => {
  it('stores only a hash of the key', () => {
    const { db, key } = setup();
    const row: any = db.prepare('SELECT key_hash FROM accounts').get();
    expect(row.key_hash).toBe(sha256(key));
    expect(JSON.stringify(db.prepare('SELECT * FROM accounts').all())).not.toContain(key);
    expect(isApiKeyShape(key)).toBe(true);
  });

  it('reserve then settle charges actual and releases the rest', () => {
    const { ledger, a } = setup();
    const r = ledger.reserve(a.id, 6000);
    expect(ledger.available(a.id)).toBe(4000);
    expect(() => ledger.reserve(a.id, 4001)).toThrow(/balance too low/);
    const s = ledger.settle(r, 1234, 'req');
    expect(s.charged).toBe(1234);
    expect(s.balance).toBe(10_000 - 1234);
    expect(ledger.available(a.id)).toBe(10_000 - 1234);
  });

  it('caps the charge at the reservation and is idempotent', () => {
    const { ledger, a } = setup();
    const r = ledger.reserve(a.id, 500);
    expect(ledger.settle(r, 9999, 'req').charged).toBe(500);
    expect(ledger.settle(r, 9999, 'req').charged).toBe(500);
    expect(ledger.get(a.id)!.balance_msub).toBe(9500);
  });

  it('concurrent reservations cannot overdraw', () => {
    const { ledger, a } = setup();
    ledger.reserve(a.id, 5000);
    ledger.reserve(a.id, 5000);
    expect(() => ledger.reserve(a.id, 1)).toThrow();
  });

  it('the stale sweep never releases a reservation this process is still serving', () => {
    const { ledger, a } = setup();
    const r = ledger.reserve(a.id, 5000);
    expect(ledger.releaseStale(0)).toBe(0);
    expect(ledger.available(a.id)).toBe(5000);
    // The request completes after the sweep: it is charged what it used.
    const s = ledger.settle(r, 1234, 'req');
    expect(s.charged).toBe(1234);
    expect(ledger.get(a.id)!.balance_msub).toBe(10_000 - 1234);
    expect(ledger.available(a.id)).toBe(10_000 - 1234);
  });

  it('releases abandoned reservations (no live owner, as after a restart) without charge', () => {
    const { db, ledger, a } = setup();
    ledger.reserve(a.id, 5000);
    // A fresh process over the same database owns no reservation.
    const restarted = new Ledger(db);
    expect(restarted.releaseStale(0)).toBe(1);
    expect(restarted.available(a.id)).toBe(10_000);
    expect(restarted.get(a.id)!.balance_msub).toBe(10_000);
  });

  it('honours the age cutoff for abandoned reservations', () => {
    const { db, ledger, a } = setup();
    ledger.reserve(a.id, 5000);
    expect(new Ledger(db).releaseStale(60_000)).toBe(0);
    expect(ledger.available(a.id)).toBe(5000);
  });

  it('a request whose reservation was released is still charged what it used', () => {
    const { db, ledger, a } = setup();
    const r = ledger.reserve(a.id, 5000);
    expect(new Ledger(db).releaseStale(0)).toBe(1);
    const s = ledger.settle(r, 1234, 'req');
    expect(s.charged).toBe(1234);
    expect(s.shortfall).toBe(0);
    expect(ledger.get(a.id)!.balance_msub).toBe(10_000 - 1234);
    const row: any = db.prepare('SELECT status, charged_msub, shortfall_msub FROM reservations WHERE id = ?').get(r);
    expect(row).toEqual({ status: 'settled', charged_msub: 1234, shortfall_msub: 0 });
    // Idempotent like any settlement.
    expect(ledger.settle(r, 1234, 'req').charged).toBe(1234);
    expect(ledger.get(a.id)!.balance_msub).toBe(10_000 - 1234);
  });

  it('a late charge is capped at what the balance covers and the shortfall is recorded', () => {
    const { db, ledger, a } = setup();
    const r = ledger.reserve(a.id, 8000);
    expect(new Ledger(db).releaseStale(0)).toBe(1);
    // The freed balance was spent elsewhere meanwhile: 7000 is held by another request.
    ledger.reserve(a.id, 7000);
    const s = ledger.settle(r, 6000, 'req');
    expect(s.charged).toBe(3000);
    expect(s.shortfall).toBe(3000);
    expect(ledger.get(a.id)!.balance_msub).toBe(7000);
    const row: any = db.prepare('SELECT status, charged_msub, shortfall_msub FROM reservations WHERE id = ?').get(r);
    expect(row).toEqual({ status: 'settled', charged_msub: 3000, shortfall_msub: 3000 });
  });

  it('the settled_after_release warning carries no account-tied value', () => {
    const { db, ledger, a } = setup();
    const r = ledger.reserve(a.id, 5000);
    expect(new Ledger(db).releaseStale(0)).toBe(1);
    const lines: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => {
      lines.push(String(chunk));
      return true;
    });
    setLogSilent(false);
    try {
      ledger.settle(r, 1234, 'req-late');
    } finally {
      setLogSilent(process.env.FORGE_LOG_SILENT === '1');
      spy.mockRestore();
    }
    const warn = lines.map((l) => JSON.parse(l)).find((l) => l.msg === 'settled_after_release');
    expect(warn).toMatchObject({ reservation_id: r, ref: 'req-late', owed_msub: 1234, charged_msub: 1234, shortfall_msub: 0 });
    expect(warn).not.toHaveProperty('account_id');
    expect(Object.values(warn)).not.toContain(a.id);
  });

  it('a settled reservation is no longer protected from the sweep bookkeeping', () => {
    const { ledger, a } = setup();
    const r = ledger.reserve(a.id, 5000);
    ledger.settle(r, 100, 'req');
    expect(ledger.isLive(r)).toBe(false);
    expect(ledger.releaseStale(0)).toBe(0);
  });

  it('disown hands a reservation to the abandoned-request sweep', () => {
    const { ledger, a } = setup();
    const r = ledger.reserve(a.id, 5000);
    expect(ledger.isLive(r)).toBe(true);
    ledger.disown(r);
    expect(ledger.releaseStale(0)).toBe(1);
    expect(ledger.available(a.id)).toBe(10_000);
  });

  it('debit refuses to go negative', () => {
    const { db, ledger, a } = setup();
    expect(() => tx(db, () => ledger.debitRaw(a.id, 10_001, 'refund', 'x'))).toThrow();
    tx(db, () => ledger.debitRaw(a.id, 10_000, 'refund', 'x'));
    expect(ledger.get(a.id)!.balance_msub).toBe(0);
  });
});

describe('invites', () => {
  it('redeem once, nut24 checks, revoke', () => {
    const db = openDb(':memory:');
    const inv = new Invites(db);
    const ledger = new Ledger(db);
    const { id, code } = inv.create('x');
    expect(inv.checkForNut24(code)).toBe(true);
    expect(inv.checkForNut24('nope')).toBe(false);
    expect(inv.checkForNut24(undefined)).toBe(false);
    const a = ledger.createAccountRaw(newApiKey(), 'usd', null);
    tx(db, () => inv.redeemRaw(code, a.id));
    expect(() => tx(db, () => inv.redeemRaw(code, a.id))).toThrow(/already/);
    expect(inv.revoke(id)).toBe(true);
    expect(inv.checkForNut24(code)).toBe(false);
    expect(JSON.stringify(db.prepare('SELECT * FROM invites').all())).not.toContain(code);
  });
});
