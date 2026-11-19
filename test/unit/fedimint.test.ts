// Fedimint notes in POST /v1/wallet/topup (docs/PAYMENTS.md, Fedimint notes; src/fedimint.ts), against a
// stand-in receiver over real HTTP (test/support/fakereceiver.ts). Every branch of the gateway's side of
// the receiver's contract: credit only on done and only net_msat, once; the gateway's row before the
// receive; a record with someone else's key credits nothing; pending and unknowns answer 503 and the
// sweep finishes them; issuance_failed is never credited. The real receiver and a real federation run in
// test/fedimint/topup.fedimint.test.ts.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { releaseIfEmpty } from '../../src/accounts.ts';
import { createApp, startupRecovery } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { type FedimintFaults, looksLikeFedimintNotes, receiveKey } from '../../src/fedimint.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { FakeReceiver, RECEIVER_TOKEN } from '../support/fakereceiver.ts';

setLogSilent(true);
const ROOT = resolve(import.meta.dirname, '..', '..');

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' } },
  models: [{ id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 100, output_usd_per_mtok: 1000, max_output_tokens: 256, price_verified: true }],
};

const FED = createHash('sha256').update('federation A').digest('hex');
const OTHER = createHash('sha256').update('federation B').digest('hex');

let rx: FakeReceiver;
const dirs: string[] = [];
beforeEach(async () => {
  rx = await new FakeReceiver().start();
  rx.joinFederation(FED, 'Alpha');
});
afterEach(async () => {
  await rx.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  vi.useRealTimers();
});

function gateway(o: { extra?: Record<string, string>; dbPath?: string; faults?: FedimintFaults; waitMs?: number; fedimint?: boolean } = {}) {
  const e: Record<string, string> = {
    FORGE_DB_PATH: o.dbPath ?? ':memory:',
    FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1',
    FORGE_RATE_LIMIT_RPM: '100000',
    FORGE_FOREIGN_DISCOVERY_RELAYS: '',
    FORGE_INVITE_ONLY: 'true',
    ...(o.fedimint === false ? {} : { FORGE_FEDIMINT_URL: rx.url, FORGE_FEDIMINT_TOKEN: RECEIVER_TOKEN }),
    ...o.extra,
  };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv, fedimint: { faults: o.faults, waitMs: o.waitMs ?? 0, pollMs: 10 } });
  const app = createApp(deps);
  const topup = async (body: object, headers: Record<string, string> = {}) => {
    const r = await app.request('http://gw.test/v1/wallet/topup', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const invite = () => deps.invites.create('t').code;
  /** The federation's row, as pnpm admin fedimint:join writes it. */
  const allow = (id = FED, state: 'active' | 'paused' = 'active', caps: { max?: number; cap?: number } = {}) =>
    deps.db
      .prepare("INSERT INTO federations (id, name, invite, modules, receives, state, max_sat, cap_sat, joined_at) VALUES (?, 'Alpha', 'fed11invite', '[\"mint\"]', '[\"mint\"]', ?, ?, ?, ?)")
      .run(id, state, caps.max ?? null, caps.cap ?? null, Date.now());
  const row = (notesId: string) => deps.db.prepare('SELECT * FROM incoming WHERE id = ?').get(`fm:${notesId}`) as any;
  const balance = (key: string) => deps.ledger.findByKey(key)?.balance_msub;
  const accounts = () => (deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  const receives = () => rx.calls.filter((c) => c === 'POST /receive').length;
  return { app, deps, topup, invite, allow, row, balance, accounts, receives, config };
}

describe('which tokens are Fedimint notes', () => {
  it('sends a Cashu token the Cashu way always, and takes base32 or base64 notes, whitespace ignored', () => {
    expect(looksLikeFedimintNotes('cashuBo2FteBtodHRwczovL21pbnQuZXhhbXBsZS5jb21hdWNzYXQ')).toBe(false);
    expect(looksLikeFedimintNotes('  cashuBabc123abc123abc123abc')).toBe(false);
    expect(looksLikeFedimintNotes('CASHUBabc123abc123abc123abc')).toBe(false);
    expect(looksLikeFedimintNotes('cashuAeyJ0b2tlbiI6W3sibWludCI6Imh0dHBzOi8v')).toBe(false);
    expect(looksLikeFedimintNotes('fedimint1qqqsxyz0123456789abcdefgh')).toBe(true);
    expect(looksLikeFedimintNotes('fedimint1qqqs xyz01234\n56789abcdefgh')).toBe(true);
    expect(looksLikeFedimintNotes('AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA=')).toBe(true);
    expect(looksLikeFedimintNotes('AQIDBAUGBwgJCgsM_-_DQ4PEBESExQVFhcYGRobHB0eHyA')).toBe(true);
    expect(looksLikeFedimintNotes('')).toBe(false);
    expect(looksLikeFedimintNotes('short')).toBe(false);
    expect(looksLikeFedimintNotes('not notes, a sentence with spaces and commas')).toBe(false);
    expect(looksLikeFedimintNotes('lnbc10u1p3xyz...invoice')).toBe(false);
  });
});

describe('with FORGE_FEDIMINT_URL unset', () => {
  it('takes no notes, asks no receiver, and lists no fedimint method', async () => {
    const g = gateway({ fedimint: false });
    expect(g.deps.fedimint).toBeUndefined();
    const n = rx.makeNotes(FED, 50_176);
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_token');
    expect(r.body.error.message).toBe('expected a cashuB token');
    expect(rx.calls).toEqual([]);
    const m = await (await g.app.request('http://gw.test/v1/wallet/fund/methods')).json();
    expect(m).not.toHaveProperty('fedimint');
    expect(g.accounts()).toBe(0);
  });

  it('treats an empty value as unset, and refuses a URL without a token or without sats', () => {
    expect(loadConfig({ FORGE_FEDIMINT_URL: '', FORGE_FEDIMINT_TOKEN: '', FORGE_DB_PATH: ':memory:' } as NodeJS.ProcessEnv, catalog).env.FORGE_FEDIMINT_URL).toBeUndefined();
    expect(() => loadConfig({ FORGE_FEDIMINT_URL: 'http://r:8790' } as NodeJS.ProcessEnv, catalog)).toThrow(/needs FORGE_FEDIMINT_TOKEN/);
    expect(() => loadConfig({ FORGE_FEDIMINT_URL: 'http://r:8790', FORGE_FEDIMINT_TOKEN: 't', FORGE_UNITS: 'usd' } as NodeJS.ProcessEnv, catalog)).toThrow(/sat in FORGE_UNITS/);
    const env = loadConfig({} as NodeJS.ProcessEnv, catalog).env;
    expect(env.FORGE_FEDIMINT_MAX_SAT).toBe(100_000);
    expect(env.FORGE_FEDIMINT_FEDERATION_CAP_SAT).toBe(1_000_000);
  });
});

describe('a Fedimint top-up', () => {
  it('opens a sat balance and credits exactly net_msat of the done record, once, writing its row before the receive', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 50_176, { fee_msat: 300 });
    const r = await g.topup({ token: `  ${n.notes.slice(0, 20)}\n${n.notes.slice(20)} `, invite: g.invite() });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ unit: 'sat', free: false, replay: false, credited_msub: 49_876, credited: 49.876, balance_msub: 49_876, fedimint: { federation_id: FED, notes_id: n.notes_id } });
    expect(r.body.key).toMatch(/^sk-forge-/);
    expect(g.balance(r.body.key)).toBe(49_876);
    // The receiver got the whitespace-free notes and this balance's key.
    expect(rx.receiveBodies).toEqual([{ notes: n.notes, key: receiveKey(r.body.account_id) }]);
    const row = g.row(n.notes_id);
    expect(row).toMatchObject({ purpose: 'fedimint', status: 'done', mint: `fedimint:${FED}`, unit: 'sat', amount: 50_176, account_id: r.body.account_id, notes: null, token_hash: `fm:${n.notes_id}` });
    expect(g.deps.db.prepare('SELECT kind, amount_msub, ref FROM ledger WHERE account_id = ?').all(r.body.account_id)).toEqual([{ kind: 'topup', amount_msub: 49_876, ref: `fm:${n.notes_id}` }]);
    // The same notes again with the same key: a replay, nothing credited, the receiver not asked again.
    const again = await g.topup({ token: n.notes }, { authorization: `Bearer ${r.body.key}` });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replay: true, credited: 0, credited_msub: 0, balance_msub: 49_876 });
    expect(g.receives()).toBe(1);
    // Into an existing sat balance, adding to it.
    const m = rx.makeNotes(FED, 10_000, { fee_msat: 0 });
    const more = await g.topup({ token: m.notes }, { authorization: `Bearer ${r.body.key}` });
    expect(more.body).toMatchObject({ credited_msub: 10_000, balance_msub: 59_876 });
    expect(more.body.key).toBeUndefined();
  });

  it('refuses the same notes for another balance, and gives that balance back', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 50_176);
    const first = await g.topup({ token: n.notes, invite: g.invite() });
    expect(first.status).toBe(200);
    const code = g.invite();
    const other = await g.topup({ token: n.notes, invite: code });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('token_spent');
    expect(g.accounts()).toBe(1);
    expect(g.deps.invites.lookup(code)!.status).toBe('open');
    expect(g.balance(first.body.key)).toBe(first.body.balance_msub);
    expect(g.receives()).toBe(1);
  });

  it('refuses notes someone else gave the receiver first: no credit, the row rejected', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 50_176);
    rx.receivedElsewhere(n);
    const code = g.invite();
    const r = await g.topup({ token: n.notes, invite: code });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('token_spent');
    expect(g.row(n.notes_id)).toMatchObject({ status: 'rejected', notes: null, error: 'given first by someone else' });
    expect(g.deps.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE kind = 'topup'").get()).toEqual({ n: 0 });
    expect(g.accounts()).toBe(0);
    expect(g.deps.invites.lookup(code)!.status).toBe('open');
  });

  it('refuses notes of a federation the receiver has not joined, or that has no active row, before opening a balance', async () => {
    const g = gateway();
    g.allow();
    const code = g.invite();
    const notJoined = await g.topup({ token: rx.makeNotes(OTHER, 50_000).notes, invite: code });
    expect(notJoined.status).toBe(400);
    expect(notJoined.body.error.code).toBe('federation_not_joined');
    expect(notJoined.body.fedimint).toEqual({ federation_id: OTHER, federation_prefix: OTHER.slice(0, 8) });
    // Joined by the receiver, but not in the gateway's list.
    rx.joinFederation(OTHER, 'Beta');
    const noRow = await g.topup({ token: rx.makeNotes(OTHER, 50_000).notes, invite: code });
    expect(noRow.body.error.code).toBe('federation_not_joined');
    expect(g.receives()).toBe(0);
    expect(g.accounts()).toBe(0);
    expect(g.deps.invites.lookup(code)!.status).toBe('open');
    expect(g.deps.db.prepare('SELECT COUNT(*) AS n FROM incoming').get()).toEqual({ n: 0 });
  });

  it('refuses a paused federation until it is resumed', async () => {
    const g = gateway();
    g.allow(FED, 'paused');
    const n = rx.makeNotes(FED, 50_176);
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('federation_paused');
    expect(g.receives()).toBe(0);
    g.deps.fedimint!.setState(FED, 'active');
    expect((await g.topup({ token: n.notes, invite: g.invite() })).status).toBe(200);
  });

  it('refuses notes it cannot take: unreadable, invalid signatures, a module not taken, a fee as big as the value', async () => {
    const g = gateway();
    g.allow();
    const bad = await g.topup({ token: 'fedimint1notreallynotesatall0000', invite: g.invite() });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('invalid_token');
    const forged = await g.topup({ token: rx.makeNotes(FED, 50_000, { valid: false }).notes, invite: g.invite() });
    expect(forged.body.error.code).toBe('invalid_token');
    const v2 = await g.topup({ token: rx.makeNotes(FED, 50_000, { module: 'mintv2' }).notes, invite: g.invite() });
    expect(v2.body.error.code).toBe('notes_unsupported');
    expect(g.receives()).toBe(0);
    // The fee is known only at the receive: refused there, nothing recorded, so the row goes too.
    const code = g.invite();
    const dust = rx.makeNotes(FED, 1_000, { fee_msat: 1_000 });
    const fee = await g.topup({ token: dust.notes, invite: code });
    expect(fee.status).toBe(400);
    expect(fee.body.error.code).toBe('insufficient_amount');
    expect(g.row(dust.notes_id)).toBeUndefined();
    expect(g.accounts()).toBe(0);
    expect(g.deps.invites.lookup(code)!.status).toBe('open');
  });

  it('refuses notes over the per-payment cap (the gateway-wide one, or a lower one of the federation)', async () => {
    const g = gateway({ extra: { FORGE_FEDIMINT_MAX_SAT: '50' } });
    g.allow(FED, 'active', { max: 1000 });
    const over = await g.topup({ token: rx.makeNotes(FED, 50_001).notes, invite: g.invite() });
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('amount_too_large');
    expect(over.body.max).toEqual({ sat: 50 });
    expect((await g.topup({ token: rx.makeNotes(FED, 50_000).notes, invite: g.invite() })).status).toBe(200);
    g.deps.db.prepare('UPDATE federations SET max_sat = 20').run();
    const own = await g.topup({ token: rx.makeNotes(FED, 30_000).notes, invite: g.invite() });
    expect(own.body.error.code).toBe('amount_too_large');
    expect(own.body.max).toEqual({ sat: 20 });
  });

  it("refuses notes that would take the federation's holdings over its cap, counting what is on its way", async () => {
    const g = gateway({ extra: { FORGE_FEDIMINT_FEDERATION_CAP_SAT: '100' } });
    g.allow();
    rx.federations.get(FED)!.balance_msat = 60_000;
    const full = await g.topup({ token: rx.makeNotes(FED, 50_000).notes, invite: g.invite() });
    expect(full.status).toBe(400);
    expect(full.body.error.code).toBe('federation_full');
    expect(g.receives()).toBe(0);
    // Exactly at the cap is taken.
    const fits = await g.topup({ token: rx.makeNotes(FED, 40_000, { fee_msat: 0 }).notes, invite: g.invite() });
    expect(fits.status).toBe(200);
    // A pending top-up counts against the room as well: balance 0, 70 on their way, 50 more is over 100.
    rx.federations.get(FED)!.balance_msat = 0;
    // A top-up finished in the same millisecond as a balance read counts as well (the check errs towards
    // refusing), so let the clock move on past the one just done.
    await new Promise((r) => setTimeout(r, 5));
    const pending = rx.makeNotes(FED, 70_000, { outcome: 'pending' });
    const p = await g.topup({ token: pending.notes, invite: g.invite() });
    expect(p.body.error.code).toBe('topup_pending');
    const over = await g.topup({ token: rx.makeNotes(FED, 50_000).notes, invite: g.invite() });
    expect(over.body.error.code).toBe('federation_full');
    // A federation's own cap overrides the gateway's.
    g.deps.db.prepare('UPDATE federations SET cap_sat = 1000').run();
    expect((await g.topup({ token: rx.makeNotes(FED, 50_000).notes, invite: g.invite() })).status).toBe(200);
  });

  it('refuses a dollar balance (notes land in sats) and asks for an invite for a new balance', async () => {
    const g = gateway();
    g.allow();
    const key = newApiKey();
    g.deps.ledger.createAccountRaw(key, 'usd', null);
    const n = rx.makeNotes(FED, 50_000);
    const usd = await g.topup({ token: n.notes }, { authorization: `Bearer ${key}` });
    expect(usd.status).toBe(400);
    expect(usd.body.error.code).toBe('wrong_unit');
    const none = await g.topup({ token: n.notes });
    expect(none.status).toBe(403);
    expect(none.body.error.code).toBe('invite_required');
    expect(g.receives()).toBe(0);
  });

  it('answers 503 fedimint_unavailable, with nothing opened or recorded, when the receiver cannot read the notes', async () => {
    const g = gateway();
    g.allow();
    rx.down = true;
    const r = await g.topup({ token: rx.makeNotes(FED, 50_000).notes, invite: g.invite() });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('fedimint_unavailable');
    expect(g.accounts()).toBe(0);
  });

  it('answers 409 token_in_flight to the same notes sent again while the first is at the receiver', async () => {
    const g = gateway();
    g.allow();
    rx.receiveDelayMs = 300;
    const n = rx.makeNotes(FED, 50_000);
    const key = newApiKey();
    g.deps.ledger.createAccountRaw(key, 'sat', null);
    const [a, b] = await Promise.all([g.topup({ token: n.notes }, { authorization: `Bearer ${key}` }), new Promise((r) => setTimeout(r, 50)).then(() => g.topup({ token: n.notes }, { authorization: `Bearer ${key}` }))]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('token_in_flight');
    expect(g.balance(key)).toBe(50_000 - 1234);
  });
});

describe('an outcome not known yet', () => {
  it('pending: 503 topup_pending with the key, the notes dropped once the receiver has them, and the sweep credits once', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 50_176, { outcome: 'pending', fee_msat: 176 });
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('topup_pending');
    expect(r.body.key).toMatch(/^sk-forge-/);
    // The receiver has a record: the gateway keeps only its row, not the notes.
    expect(g.row(n.notes_id)).toMatchObject({ status: 'prepared', notes: null });
    expect(g.balance(r.body.key)).toBe(0);
    // Still pending: the sweep asks by notes_id and changes nothing.
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 1, credited: 0 });
    expect(rx.calls.at(-1)).toBe(`GET /receive/${n.notes_id}`);
    rx.finish(n.notes_id, 'done');
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 1, credited: 1 });
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 0, credited: 0 });
    expect(g.balance(r.body.key)).toBe(50_000);
    const again = await g.topup({ token: n.notes }, { authorization: `Bearer ${r.body.key}` });
    expect(again.body).toMatchObject({ replay: true, balance_msub: 50_000 });
    expect(g.receives()).toBe(1);
  });

  it('pending for a moment: the request waits for done and credits at once', async () => {
    const g = gateway({ waitMs: 2000 });
    g.allow();
    const n = rx.makeNotes(FED, 20_000, { outcome: 'pending', fee_msat: 0 });
    setTimeout(() => rx.finish(n.notes_id, 'done'), 150);
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(200);
    expect(r.body.credited_msub).toBe(20_000);
  });

  it('the answer lost after the receiver recorded it: the notes are kept, and the sweep re-posts them and credits once', async () => {
    const g = gateway();
    g.allow();
    rx.loseReceiveAnswer = 1;
    const n = rx.makeNotes(FED, 50_000, { fee_msat: 0 });
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('topup_pending');
    expect(g.row(n.notes_id)).toMatchObject({ status: 'prepared', notes: n.notes });
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 1, credited: 1 });
    expect(rx.receiveBodies.map((b) => b.key)).toEqual([receiveKey(r.body.account_id), receiveKey(r.body.account_id)]);
    expect(g.row(n.notes_id)).toMatchObject({ status: 'done', notes: null });
    expect(g.balance(r.body.key)).toBe(50_000);
  });

  it('a 5xx from the receiver: 503, and the sweep finishes it', async () => {
    const g = gateway();
    g.allow();
    rx.fail500 = 1;
    const n = rx.makeNotes(FED, 30_000, { fee_msat: 0 });
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('topup_pending');
    expect(rx.records.has(n.notes_id)).toBe(false);
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 1, credited: 1 });
    expect(g.balance(r.body.key)).toBe(30_000);
  });

  it('the receiver down at the receive, then back: 503, the sweep waits, then credits', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 30_000, { fee_msat: 0 });
    // The receive itself gets no answer and records nothing; then the receiver stays down for a while.
    rx.dropReceive = 1;
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    rx.down = true;
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('topup_pending');
    expect(g.row(n.notes_id)).toMatchObject({ status: 'prepared', notes: n.notes });
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 1, credited: 0 });
    rx.down = false;
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 1, credited: 1 });
    expect(g.balance(r.body.key)).toBe(30_000);
  });

  it('the gateway dies after its row and before the receive: the restart posts the notes and credits once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-fm-'));
    dirs.push(dir);
    const dbPath = join(dir, 'f.db');
    const faulty = gateway({ dbPath, faults: { afterRow: true } });
    faulty.allow();
    const n = rx.makeNotes(FED, 40_000, { fee_msat: 0 });
    const r = await faulty.topup({ token: n.notes, invite: faulty.invite() });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('topup_pending');
    expect(rx.records.has(n.notes_id)).toBe(false);
    faulty.deps.db.close();
    const g = gateway({ dbPath });
    await startupRecovery(g.deps);
    expect(g.balance(r.body.key)).toBe(40_000);
    expect(g.row(n.notes_id).status).toBe('done');
    await startupRecovery(g.deps);
    expect(g.balance(r.body.key)).toBe(40_000);
    g.deps.db.close();
  });

  it('the gateway dies after the receive and before the credit: the restart reads the record and credits once', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-fm-'));
    dirs.push(dir);
    const dbPath = join(dir, 'f.db');
    const faulty = gateway({ dbPath, faults: { afterReceive: true } });
    faulty.allow();
    const n = rx.makeNotes(FED, 40_000, { fee_msat: 0 });
    const r = await faulty.topup({ token: n.notes, invite: faulty.invite() });
    expect(r.status).toBe(503);
    // The receiver had it done; the gateway had not credited it yet.
    expect(rx.records.get(n.notes_id)!.state).toBe('done');
    faulty.deps.db.close();
    const g = gateway({ dbPath });
    await startupRecovery(g.deps);
    expect(g.balance(r.body.key)).toBe(40_000);
    expect(g.receives()).toBe(2);
    g.deps.db.close();
  });

  it('the sweep runs by itself on its timer', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 10_000, { outcome: 'pending', fee_msat: 0 });
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(503);
    rx.finish(n.notes_id, 'done');
    g.deps.fedimint!.start(30);
    try {
      await vi.waitFor(() => expect(g.balance(r.body.key)).toBe(10_000), { timeout: 2000 });
    } finally {
      g.deps.fedimint!.stop();
    }
  });
});

describe('a receive that failed', () => {
  it('spent elsewhere first: 400 token_spent, the row rejected, nothing credited', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 30_000, { outcome: 'rejected' });
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('token_spent');
    expect(g.row(n.notes_id)).toMatchObject({ status: 'rejected', notes: null });
    expect(g.accounts()).toBe(0);
  });

  it('issuance_failed: never credited, held for an operator with the balance kept, and the sweep leaves it', async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 30_000, { outcome: 'issuance_failed' });
    const r = await g.topup({ token: n.notes, invite: g.invite() });
    expect(r.status).toBe(502);
    expect(r.body.error.code).toBe('issuance_failed');
    expect(r.body.key).toMatch(/^sk-forge-/);
    expect(g.row(n.notes_id)).toMatchObject({ status: 'stuck', notes: null });
    expect(g.row(n.notes_id).error).toMatch(/^issuance_failed/);
    expect(g.balance(r.body.key)).toBe(0);
    expect(releaseIfEmpty(g.deps.db, r.body.account_id)).toBe(false);
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 0, credited: 0 });
    const again = await g.topup({ token: n.notes }, { authorization: `Bearer ${r.body.key}` });
    expect(again.status).toBe(502);
    expect(g.deps.fedimint!.counts(FED)).toEqual({ pending: 0, stuck: 1, credited_msat: 0 });
  });
});

describe('the Cashu side is untouched', () => {
  it("leaves Fedimint rows to the Fedimint sweep: the wallet's recovery neither rejects nor deletes them", async () => {
    const g = gateway();
    g.allow();
    const n = rx.makeNotes(FED, 10_000, { outcome: 'pending' });
    expect((await g.topup({ token: n.notes, invite: g.invite() })).status).toBe(503);
    const w = await g.deps.wallet.recover();
    expect(w.incoming).toBe(0);
    expect(g.row(n.notes_id).status).toBe('prepared');
  });

  it('still sends a cashuB token the Cashu way with Fedimint on', async () => {
    const g = gateway();
    const r = await g.topup({ token: 'cashuBnotarealtokenatallbutlongenough', invite: g.invite() });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('invalid_token');
    expect(r.body.error.message).toBe('could not decode token');
    expect(rx.calls).toEqual([]);
  });
});

describe('GET /v1/wallet/fund/methods', () => {
  it('lists the active federations the receiver has joined', async () => {
    const g = gateway({ extra: { FORGE_FEDIMINT_MAX_SAT: '5000' } });
    const methods = async () => (await (await g.app.request('http://gw.test/v1/wallet/fund/methods')).json()).fedimint;
    expect(await methods()).toEqual({ enabled: false, unit: 'sat', max: 5000, federations: [] });
    g.allow(FED, 'active', { max: 1000 });
    g.allow(OTHER, 'active');
    const third = createHash('sha256').update('federation C').digest('hex');
    rx.joinFederation(third);
    g.allow(third, 'paused');
    // OTHER is not joined at the receiver; third is paused.
    expect(await methods()).toEqual({ enabled: true, unit: 'sat', max: 5000, federations: [{ id: FED, name: 'Alpha', max: 1000 }] });
  });

  it('says not enabled while the receiver cannot be asked and never was', async () => {
    const g = gateway();
    g.allow();
    rx.down = true;
    const m = (await (await g.app.request('http://gw.test/v1/wallet/fund/methods')).json()).fedimint;
    expect(m).toEqual({ enabled: false, unit: 'sat', max: 100_000, federations: [] });
  });
});

describe('pnpm admin fedimint:*', () => {
  it('joins by invite through the receiver, lists, pauses and resumes, never printing the invite', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-fm-cli-'));
    dirs.push(dir);
    const INVITE = 'fed11secretinvitecodeforthetest0000';
    rx.invites.set(INVITE, { id: OTHER, name: 'Beta' });
    const env = { ...process.env, FORGE_DB_PATH: join(dir, 'f.db'), FORGE_FOREIGN_DISCOVERY_RELAYS: '', TOKENFACTORY_API_KEY: 'x', FORGE_FEDIMINT_URL: rx.url, FORGE_FEDIMINT_TOKEN: RECEIVER_TOKEN };
    // Not spawnSync: the stand-in receiver answers from this process, so its event loop must keep running.
    const admin = (args: string[], input?: string, e: NodeJS.ProcessEnv = env) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
        const p = spawn(process.execPath, ['src/admin.ts', ...args], { cwd: ROOT, env: e });
        let stdout = '';
        let stderr = '';
        p.stdout.on('data', (d) => (stdout += d));
        p.stderr.on('data', (d) => (stderr += d));
        p.on('close', (status) => done({ status, stdout, stderr }));
        p.stdin.end(input ?? '');
      });
    const joined = await admin(['fedimint:join', '--max-sat', '2000', '--json'], `${INVITE}\n`);
    expect(joined.status, joined.stderr).toBe(0);
    expect(JSON.parse(joined.stdout)[0]).toMatchObject({ id: OTHER, name: 'Beta', state: 'active', receives: 'mint', max_sat: 2000, cap_sat: 1_000_000, pending: 0, stuck: 0 });
    expect(joined.stderr).toMatch(/Joined/);
    // Again, by argument: already in the list, its state and caps kept.
    expect((await admin(['fedimint:pause', OTHER])).stdout.trim()).toBe('paused');
    const again = await admin(['fedimint:join', INVITE, '--json']);
    expect(again.status, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)[0]).toMatchObject({ state: 'paused', max_sat: 2000 });
    const listed = await admin(['fedimint:list', '--json']);
    expect(JSON.parse(listed.stdout)).toEqual([expect.objectContaining({ id: OTHER, state: 'paused', joined: true, balance_msat: 0 })]);
    expect((await admin(['fedimint:resume', OTHER])).stdout.trim()).toBe('active');
    expect((await admin(['fedimint:pause', 'nope'])).status).toBe(1);
    const badInvite = await admin(['fedimint:join', 'fed11unknown']);
    expect(badInvite.status).toBe(1);
    expect(badInvite.stderr).toMatch(/could not join/);
    for (const out of [joined, again, listed, badInvite]) expect(out.stdout + out.stderr).not.toContain(INVITE);
    const off = await admin(['fedimint:list'], undefined, { ...env, FORGE_FEDIMINT_URL: '' });
    expect(off.status).toBe(1);
    expect(off.stderr).toMatch(/Fedimint is off/);
  });
});
