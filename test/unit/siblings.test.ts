// Two balances (docs/PAYMENTS.md, Two balances): the key of a paid balance opens the balance in the other
// unit once, with no invite and no pass use (X-Forge-Sibling, src/accounts.ts siblingProof), and that is
// bounded: one per proving balance, none from a sibling, a free or a frozen key, or one not used yet.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { openAccount, releaseIfEmpty, SIBLING_HEADER, siblingProof } from '../../src/accounts.ts';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { Invites, Ledger, LedgerError, newApiKey, Passes } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);
const PUBLIC = join(resolve(import.meta.dirname, '..', '..'), 'public');

const setup = () => {
  const db = openDb(':memory:');
  return { db, ledger: new Ledger(db), invites: new Invites(db), passes: new Passes(db) };
};
type D = ReturnType<typeof setup>;

/** A usd balance opened with an invite and used (a ledger line), as a phone holds after its first top-up. */
function usedBalance(d: D, unit: 'usd' | 'sat' = 'usd') {
  const { code } = d.invites.create();
  const o = openAccount({ ...d, inviteOnly: true }, { unit, invite: code });
  d.ledger.creditRaw(o.account.id, 1000, 'topup', null);
  return { key: o.generatedKey!, id: o.account.id, code };
}

const siblingOf = (d: D, id: string) => (d.db.prepare('SELECT sibling_of FROM accounts WHERE id = ?').get(id) as { sibling_of: string | null }).sibling_of;
const count = (d: D) => (d.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
const open = (d: D, sibling: string, unit: 'usd' | 'sat' = 'sat') => openAccount({ ...d, inviteOnly: true }, { unit, sibling });

describe('opening the balance in the other unit with a sibling key', () => {
  it('opens it with no invite, stores only the id of the balance that proved it, and spends nothing', () => {
    const d = setup();
    const p = usedBalance(d);
    const before = d.db.prepare('SELECT status, account_id FROM invites').all();
    const o = open(d, p.key);
    expect(o.created).toBe(true);
    expect(o.account.unit).toBe('sat');
    expect(o.generatedKey).toMatch(/^sk-forge-/);
    expect(siblingOf(d, o.account.id)).toBe(p.id);
    // No invite or pass on the sibling, and the invite stays bound to the first balance only.
    expect(d.db.prepare('SELECT invite_id, pass_id FROM accounts WHERE id = ?').get(o.account.id)).toEqual({ invite_id: null, pass_id: null });
    expect(d.db.prepare('SELECT status, account_id FROM invites').all()).toEqual(before);
    // The first balance is unchanged: it links to nothing.
    expect(siblingOf(d, p.id)).toBeNull();
  });

  it('works from a sat balance to usd as well, and from a balance an event pass opened, with no pass use', () => {
    const d = setup();
    const s = usedBalance(d, 'sat');
    expect(open(d, s.key, 'usd').account.unit).toBe('usd');
    const pass = d.passes.create({ maxUses: 1, expiresAt: Date.now() + 3600_000 });
    const viaPass = openAccount({ ...d, inviteOnly: true }, { unit: 'usd', invite: pass.code });
    d.ledger.creditRaw(viaPass.account.id, 0, 'open', null);
    expect(open(d, viaPass.generatedKey!).account.unit).toBe('sat');
    expect(d.passes.lookup(pass.code)!.uses).toBe(1);
  });

  it('opens at most one per proving balance, even when two opens race', () => {
    const d = setup();
    const p = usedBalance(d);
    open(d, p.key);
    expect(() => open(d, p.key)).toThrow(/opened its balance in the other unit already/);
    expect(count(d)).toBe(2);
    // The rule is checked again inside the transaction, and the unique index backs it.
    const d2 = setup();
    const p2 = usedBalance(d2);
    const first = siblingProof(d2.db, d2.ledger, p2.key, 'sat');
    expect(first.id).toBe(p2.id);
    open(d2, p2.key);
    expect(() => d2.db.prepare('UPDATE accounts SET sibling_of = ? WHERE id = ?').run(p2.id, p2.id)).toThrow(/UNIQUE/);
  });

  it('proves nothing from a sibling, so the chain stops at two balances per invite', () => {
    const d = setup();
    const p = usedBalance(d);
    const s = open(d, p.key);
    d.ledger.creditRaw(s.account.id, 1000, 'topup', null);
    expect(() => open(d, s.generatedKey!, 'usd')).toThrow(/opened this way itself/);
    expect(count(d)).toBe(2);
  });

  it('proves nothing from a free, frozen, unknown or unused key, or one in the same unit', () => {
    const d = setup();
    const free = openAccount({ ...d, inviteOnly: true }, { unit: 'usd', free: true });
    d.ledger.creditRaw(free.account.id, 3000, 'topup', null);
    expect(() => open(d, free.generatedKey!)).toThrow(/free-question balance proves nothing/);
    const frozen = usedBalance(d);
    d.ledger.setFrozen(frozen.id, true);
    expect(() => open(d, frozen.key)).toThrow(/frozen/);
    expect(() => open(d, 'sk-forge-' + 'x'.repeat(30))).toThrow(/unknown balance key/);
    // Opened, but its first funding is still on its way: it could be released and its invite reopened.
    const { code } = d.invites.create();
    const fresh = openAccount({ ...d, inviteOnly: true }, { unit: 'usd', invite: code });
    expect(() => open(d, fresh.generatedKey!)).toThrow(/not been used yet/);
    const used = usedBalance(d);
    expect(() => open(d, used.key, 'usd')).toThrow(/in usd already/);
    // Every refusal is 403 sibling_refused, and opened nothing.
    try {
      open(d, frozen.key);
    } catch (e) {
      expect(e).toBeInstanceOf(LedgerError);
      expect((e as LedgerError).code).toBe('sibling_refused');
      expect((e as LedgerError).status).toBe(403);
    }
    expect(count(d)).toBe(4);
  });

  it('released empty (its first funding failed), it gives nothing back and frees the place for one more', () => {
    const d = setup();
    const p = usedBalance(d);
    const s = open(d, p.key);
    const invitesBefore = d.db.prepare('SELECT status, account_id FROM invites').all();
    expect(releaseIfEmpty(d.db, s.account.id)).toBe(true);
    expect(d.db.prepare('SELECT status, account_id FROM invites').all()).toEqual(invitesBefore);
    expect(count(d)).toBe(1);
    expect(open(d, p.key).created).toBe(true);
    // The balance that proved is never released: it has a ledger line.
    expect(releaseIfEmpty(d.db, p.id)).toBe(false);
  });

  it('opens with a key the phone chose, and the same key and header again find that balance (a lost answer)', () => {
    const d = setup();
    const p = usedBalance(d);
    const mine = newApiKey();
    const first = openAccount({ ...d, inviteOnly: true }, { unit: 'sat', key: mine, sibling: p.key });
    expect(first).toMatchObject({ created: true, generatedKey: undefined });
    // The retry after a lost answer: the same key with the same header is the same balance, never a 403.
    const again = openAccount({ ...d, inviteOnly: true }, { unit: 'sat', key: mine, sibling: p.key });
    expect(again).toMatchObject({ created: false });
    expect(again.account.id).toBe(first.account.id);
    expect(count(d)).toBe(2);
  });

  it('falls back to an invite sent beside a refused sibling key, and refuses when there is none', () => {
    const d = setup();
    const p = usedBalance(d);
    open(d, p.key);
    const { code } = d.invites.create();
    const o = openAccount({ ...d, inviteOnly: true }, { unit: 'sat', sibling: p.key, invite: code });
    expect(o.created).toBe(true);
    expect(d.db.prepare('SELECT invite_id, sibling_of FROM accounts WHERE id = ?').get(o.account.id)).toEqual({ invite_id: d.invites.lookup(code)!.id, sibling_of: null });
    expect(d.invites.lookup(code)!.status).toBe('redeemed');
    expect(() => openAccount({ ...d, inviteOnly: true }, { unit: 'sat', sibling: p.key })).toThrow(/other unit already/);
    // A good sibling key is used first: the invite beside it is left open.
    const q = usedBalance(d);
    const { code: spare } = d.invites.create();
    expect(siblingOf(d, openAccount({ ...d, inviteOnly: true }, { unit: 'sat', sibling: q.key, invite: spare }).account.id)).toBe(q.id);
    expect(d.invites.lookup(spare)!.status).toBe('open');
  });

  it('answers a clash on the unique index (a second writer) as 403 sibling_refused, and opens nothing', () => {
    const d = setup();
    const p = usedBalance(d);
    open(d, p.key);
    // Hide the existing sibling from the checks, as a writer they did not see would be.
    const real = d.db.prepare.bind(d.db);
    const spy = vi.spyOn(d.db, 'prepare').mockImplementation((sql: string) => (/WHERE sibling_of = \?/.test(sql) ? ({ get: () => undefined } as any) : real(sql)));
    try {
      expect(() => open(d, p.key)).toThrow(expect.objectContaining({ code: 'sibling_refused', status: 403 }));
    } finally {
      spy.mockRestore();
    }
    expect(count(d)).toBe(2);
  });

  it('stores nothing while the gateway is not invite-only: any key opens there', () => {
    const d = setup();
    const p = usedBalance(d);
    const o = openAccount({ ...d, inviteOnly: false }, { unit: 'sat', sibling: p.key });
    expect(siblingOf(d, o.account.id)).toBeNull();
  });

  it('adds the column and the index to a database from before two balances (migration)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-siblings-'));
    try {
      const file = join(dir, 'old.db');
      // The accounts table as it was before, with a balance on it.
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, unit TEXT NOT NULL, balance_msub INTEGER NOT NULL DEFAULT 0 CHECK (balance_msub >= 0), invite_id TEXT, pass_id TEXT, created_at INTEGER NOT NULL, frozen_at INTEGER, free INTEGER NOT NULL DEFAULT 0);
        INSERT INTO accounts (id, key_hash, unit, balance_msub, created_at) VALUES ('acct_old', 'h', 'usd', 5, 1);`);
      old.close();
      const db = openDb(file);
      expect(db.prepare("SELECT balance_msub, sibling_of FROM accounts WHERE id = 'acct_old'").get()).toEqual({ balance_msub: 5, sibling_of: null });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'accounts_sibling'").get()).toBeTruthy();
      db.close();
      openDb(file).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the routes', () => {
  const catalog = {
    suppliers: { mock: { type: 'mock', tier: 'standard' } },
    models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 100, output_usd_per_mtok: 1000, max_output_tokens: 256, price_verified: true }],
  };
  function gateway() {
    const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_RATE_LIMIT_RPM: '100000', FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_INVITE_ONLY: 'true' };
    const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
    const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
    const app = createApp({ ...deps, publicDir: PUBLIC });
    const post = (path: string, body: object, headers: Record<string, string> = {}) => app.request(`http://gw.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { app, deps, post };
  }

  it('advertises the rule in /v1/wallet/fund/methods, and lets the header through CORS', async () => {
    const g = gateway();
    const m = await (await g.app.request('http://gw.test/v1/wallet/fund/methods')).json();
    expect(m.sibling).toEqual({ enabled: true, header: SIBLING_HEADER });
    const pre = await g.app.request('http://gw.test/v1/wallet/topup', { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-forge-sibling' } });
    expect((pre.headers.get('access-control-allow-headers') ?? '').toLowerCase()).toContain('x-forge-sibling');
  });

  it('opens the sibling on a funding route, and releases it when the quote cannot be made', async () => {
    const g = gateway();
    const d = { db: g.deps.db, ledger: g.deps.ledger, invites: g.deps.invites, passes: g.deps.passes };
    const p = usedBalance(d);
    const n = () => (g.deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
    // The mint is not there, so no invoice is made, and the sibling the route opened is given back.
    const r = await g.post('/v1/wallet/fund/lightning', { amount: 100, unit: 'sat' }, { [SIBLING_HEADER]: p.key });
    expect(r.ok).toBe(false);
    expect((await r.json()).error.code).not.toBe('sibling_refused');
    expect(n()).toBe(1);
    // Without the header and without an invite, a new balance needs an invite as before.
    const none = await g.post('/v1/wallet/fund/lightning', { amount: 100, unit: 'sat' });
    expect(none.status).toBe(403);
    expect((await none.json()).error.code).toBe('invite_required');
    // A refused proof says so, before any mint is asked.
    g.deps.ledger.setFrozen(p.id, true);
    const frozen = await g.post('/v1/wallet/fund/lightning', { amount: 100, unit: 'sat' }, { [SIBLING_HEADER]: p.key });
    expect(frozen.status).toBe(403);
    expect((await frozen.json()).error.code).toBe('sibling_refused');
  });
});
