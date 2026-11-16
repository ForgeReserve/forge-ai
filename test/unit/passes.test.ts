// Event passes (docs/ADMIN.md, Event passes): one code behind one QR code (/j#<pass>) that opens up to N
// balances at 0 for the free models, through POST /v1/wallet/open only, until it expires. Plus the /j page
// and /.well-known/assetlinks.json that send the link to the web app or the Android app.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openAccount, releaseIfEmpty } from '../../src/accounts.ts';
import { createApp } from '../../src/app.ts';
import { certFingerprint, loadConfig } from '../../src/config.ts';
import { openDb } from '../../src/db.ts';
import { buildDeps } from '../../src/deps.ts';
import { ANDROID_PACKAGES, assetLinks } from '../../src/download.ts';
import { Invites, Ledger, LedgerError, Passes, passExpiry, sha256 } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(true);
const ROOT = resolve(import.meta.dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');
const DAY = 24 * 3600 * 1000;
// The debug keystore's certificate on the build Mac (keytool -list -v -keystore ~/.android/debug.keystore
// -storepass android), as .env.example shows it. Only a sample here: the gateway reads its own from the env.
const DEBUG_CERT = '52:03:19:6E:1A:8A:4C:1A:C6:E3:25:78:9A:6B:ED:31:48:FA:A6:64:5C:D3:7F:A4:07:D5:C1:92:EE:3B:5C:01';

const catalog = {
  suppliers: { mock: { type: 'mock', tier: 'standard' }, freebie: { type: 'mock', tier: 'standard' } },
  models: [
    { id: 'mock-echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: 100, output_usd_per_mtok: 1000, max_output_tokens: 256, price_verified: true },
    { id: 'free-echo', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'test', max_output_tokens: 256 },
  ],
};

function gateway(extra: Record<string, string> = {}) {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_RATE_LIMIT_RPM: '100000', FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_INVITE_ONLY: 'true', ...extra };
  const config = loadConfig(e as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: PUBLIC });
  const post = (path: string, body: object, headers: Record<string, string> = {}) =>
    app.request(`http://gw.test${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const open = (invite: string | undefined, headers: Record<string, string> = {}) => post('/v1/wallet/open', invite === undefined ? {} : { invite }, headers);
  const pass = (uses = 3, days = 10, label = 't') => deps.passes.create({ maxUses: uses, expiresAt: Date.now() + days * DAY, label });
  const uses = (id: string) => (deps.db.prepare('SELECT uses FROM passes WHERE id = ?').get(id) as { uses: number }).uses;
  const accounts = () => (deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  return { app, deps, post, open, pass, uses, accounts };
}

const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const ask = (model: string) => ({ model, messages: [{ role: 'user', content: 'Say hello' }], max_tokens: 64 });

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('an event pass on POST /v1/wallet/open', () => {
  it('opens a balance at 0 per use, whose key answers on a free model, and counts each use', async () => {
    const g = gateway();
    const p = g.pass(3);
    const keys: string[] = [];
    for (let i = 1; i <= 3; i++) {
      const r = await g.open(p.code);
      expect(r.status).toBe(200);
      const body = await r.json();
      expect(body).toMatchObject({ created: true, balance_msub: 0, unit: 'usd', free_models: ['free-echo'] });
      expect(body.key).toMatch(/^sk-forge-/);
      keys.push(body.key);
      expect(g.uses(p.id)).toBe(i);
      // Bound to the pass, not to an invite.
      expect(g.deps.db.prepare('SELECT pass_id, invite_id FROM accounts WHERE id = ?').get(body.account_id)).toEqual({ pass_id: p.id, invite_id: null });
    }
    expect(new Set(keys).size).toBe(3);
    const chat = await g.post('/v1/chat/completions', ask('free-echo'), auth(keys[0]!));
    expect(chat.status).toBe(200);
    expect(chat.headers.get('x-forge-charged-msub')).toBe('0');
    // A paid model still needs funds.
    expect((await g.post('/v1/chat/completions', ask('mock-echo'), auth(keys[0]!))).status).toBe(402);
  });

  it('is refused once used up, with its own code, and opens nothing more', async () => {
    const g = gateway();
    const p = g.pass(2);
    expect((await g.open(p.code)).status).toBe(200);
    expect((await g.open(p.code)).status).toBe(200);
    const before = g.accounts();
    const r = await g.open(p.code);
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('pass_used_up');
    expect(g.accounts()).toBe(before);
    expect(g.uses(p.id)).toBe(2);
  });

  it('is refused from its expiry on, with its own code', async () => {
    const g = gateway();
    const p = g.pass(10, 1);
    expect((await g.open(p.code)).status).toBe(200);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(p.expires_at);
    const r = await g.open(p.code);
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('pass_expired');
    expect(g.uses(p.id)).toBe(1);
  });

  it('is refused once revoked, by id or by code', async () => {
    const g = gateway();
    const a = g.pass();
    const b = g.pass();
    expect(g.deps.passes.revoke(a.id)).toBe(true);
    expect(g.deps.passes.revoke(b.code)).toBe(true);
    expect(g.deps.passes.revoke('nope')).toBe(false);
    for (const code of [a.code, b.code]) {
      const r = await g.open(code);
      expect(r.status).toBe(403);
      expect((await r.json()).error.code).toBe('invite_invalid');
    }
  });

  it('answers a key the gateway knows as it is and counts no use', async () => {
    const g = gateway();
    const p = g.pass(1);
    const first = await (await g.open(p.code)).json();
    expect(g.uses(p.id)).toBe(1);
    // Used up now, but a known key is still answered: no use is counted and nothing new is opened.
    const again = await g.open(p.code, auth(first.key));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ account_id: first.account_id, created: false, balance_msub: 0 });
    expect(g.uses(p.id)).toBe(1);
  });

  it('works with FORGE_INVITE_ONLY off too, as an invite does there', async () => {
    const g = gateway({ FORGE_INVITE_ONLY: 'false' });
    const p = g.pass(1);
    expect((await g.open(p.code)).status).toBe(200);
    expect(g.uses(p.id)).toBe(1);
  });

  it('never counts past its cap, even when two opens race for the last use', () => {
    const g = gateway();
    const p = g.pass(1);
    const d = { db: g.deps.db, ledger: g.deps.ledger, invites: g.deps.invites, passes: g.deps.passes, inviteOnly: true };
    // Both looked the pass up while one use was left; the second is refused inside its transaction.
    const looked = g.deps.passes.lookup(p.code)!;
    vi.spyOn(g.deps.passes, 'lookup').mockReturnValue(looked);
    expect(openAccount(d, { invite: p.code, unit: 'usd' }).created).toBe(true);
    const before = g.accounts();
    expect(() => openAccount(d, { invite: p.code, unit: 'usd' })).toThrow(expect.objectContaining({ code: 'pass_used_up' }));
    expect(g.accounts()).toBe(before);
    expect(g.uses(p.id)).toBe(1);
  });
});

describe('an event pass is not an invite anywhere else', () => {
  it('does not open a balance for a funded top-up (Lightning)', async () => {
    const g = gateway();
    const p = g.pass();
    const r = await g.post('/v1/wallet/fund/lightning', { amount: 100, unit: 'usd', invite: p.code });
    expect(r.status).toBe(403);
    expect((await r.json()).error.code).toBe('invite_required');
    expect(g.uses(p.id)).toBe(0);
    expect(g.accounts()).toBe(0);
  });

  it('does not stand in for X-Forge-Invite on a NUT-24 request, where an invite does', async () => {
    const g = gateway();
    const p = g.pass();
    const withPass = await g.post('/v1/chat/completions', ask('mock-echo'), { 'x-forge-invite': p.code });
    expect(withPass.status).toBe(403);
    expect((await withPass.json()).error.code).toBe('invite_required');
    // The same request with a real invite is asked to pay instead.
    const withInvite = await g.post('/v1/chat/completions', ask('mock-echo'), { 'x-forge-invite': g.deps.invites.create('t').code });
    expect(withInvite.status).toBe(402);
    expect(g.deps.invites.checkForNut24(p.code)).toBe(false);
    expect(g.uses(p.id)).toBe(0);
  });

  it('opens nothing through openAccount without the passes (every caller but /v1/wallet/open)', () => {
    const db = openDb(':memory:');
    const passes = new Passes(db);
    const p = passes.create({ maxUses: 5, expiresAt: Date.now() + DAY });
    const d = { db, ledger: new Ledger(db), invites: new Invites(db), inviteOnly: true };
    expect(() => openAccount(d, { invite: p.code, unit: 'usd' })).toThrow(expect.objectContaining({ code: 'invite_required' }));
    // Nor does a free (credits) balance ever touch it.
    expect(openAccount({ ...d, passes }, { invite: p.code, unit: 'usd', free: true }).created).toBe(true);
    expect(passes.lookup(p.code)!.uses).toBe(0);
  });
});

describe('giving a balance back (releaseIfEmpty)', () => {
  it('gives the pass its use back, and the pass works again', () => {
    const db = openDb(':memory:');
    const passes = new Passes(db);
    const d = { db, ledger: new Ledger(db), invites: new Invites(db), passes, inviteOnly: true };
    const p = passes.create({ maxUses: 1, expiresAt: Date.now() + DAY });
    // A balance opened by the pass with no ledger line yet (as if the first funding of it failed).
    const o = openAccount(d, { invite: p.code, unit: 'usd' });
    expect(passes.lookup(p.code)!.uses).toBe(1);
    expect(() => openAccount(d, { invite: p.code, unit: 'usd' })).toThrow(expect.objectContaining({ code: 'pass_used_up' }));
    expect(releaseIfEmpty(db, o.account.id)).toBe(true);
    expect(passes.lookup(p.code)!.uses).toBe(0);
    // Released twice (already gone) changes nothing; a use is never given back below 0.
    expect(releaseIfEmpty(db, o.account.id)).toBe(false);
    expect(passes.lookup(p.code)!.uses).toBe(0);
    expect(openAccount(d, { invite: p.code, unit: 'usd' }).created).toBe(true);
    expect(passes.lookup(p.code)!.uses).toBe(1);
  });

  it('keeps a balance POST /v1/wallet/open opened, and its use counted', async () => {
    const g = gateway();
    const p = g.pass(2);
    const r = await (await g.open(p.code)).json();
    expect(releaseIfEmpty(g.deps.db, r.account_id)).toBe(false);
    expect(g.uses(p.id)).toBe(1);
  });

  it('leaves invites as they were: an invite is still reopened, and no pass is touched', () => {
    const db = openDb(':memory:');
    const passes = new Passes(db);
    const invites = new Invites(db);
    const p = passes.create({ maxUses: 3, expiresAt: Date.now() + DAY });
    const d = { db, ledger: new Ledger(db), invites, passes, inviteOnly: true };
    openAccount(d, { invite: p.code, unit: 'usd' });
    const code = invites.create('t').code;
    const o = openAccount(d, { invite: code, unit: 'usd' });
    expect(releaseIfEmpty(db, o.account.id)).toBe(true);
    expect(invites.lookup(code)!.status).toBe('open');
    expect(passes.lookup(p.code)!.uses).toBe(1);
  });
});

describe('the passes table', () => {
  it('stores only a hash of the code', () => {
    const db = openDb(':memory:');
    const p = new Passes(db).create({ maxUses: 2, expiresAt: Date.now() + DAY, label: 'hrf' });
    expect(p.code).toMatch(/^pass-[A-Za-z0-9_-]{16}$/);
    const row = db.prepare('SELECT * FROM passes').get() as Record<string, unknown>;
    expect(row).toMatchObject({ id: p.id, code_hash: sha256(p.code), label: 'hrf', status: 'open', max_uses: 2, uses: 0, expires_at: p.expires_at });
    expect(JSON.stringify(row)).not.toContain(p.code);
  });

  it('refuses a pass with no use or one that has already expired', () => {
    const passes = new Passes(openDb(':memory:'));
    expect(() => passes.create({ maxUses: 0, expiresAt: Date.now() + DAY })).toThrow(LedgerError);
    expect(() => passes.create({ maxUses: 1.5, expiresAt: Date.now() + DAY })).toThrow(LedgerError);
    expect(() => passes.create({ maxUses: 1, expiresAt: Date.now() - 1 })).toThrow(/expire in the future/);
    expect(() => passes.create({ maxUses: 1, expiresAt: NaN })).toThrow(LedgerError);
  });

  it('is added to a database from before passes, with accounts.pass_id (migration)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-passes-'));
    try {
      const file = join(dir, 'old.db');
      // The accounts table as release-1115 has it, with a balance on it, and no passes table.
      const old = new DatabaseSync(file);
      old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, unit TEXT NOT NULL, balance_msub INTEGER NOT NULL DEFAULT 0 CHECK (balance_msub >= 0), invite_id TEXT, created_at INTEGER NOT NULL, frozen_at INTEGER, free INTEGER NOT NULL DEFAULT 0);
        INSERT INTO accounts (id, key_hash, unit, balance_msub, created_at) VALUES ('acct_old', 'h', 'usd', 5, 1);`);
      old.close();
      const db = openDb(file);
      const cols = (db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>).map((c) => c.name);
      expect(cols).toContain('pass_id');
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'passes'").get()).toBeTruthy();
      expect(db.prepare("SELECT balance_msub, pass_id FROM accounts WHERE id = 'acct_old'").get()).toEqual({ balance_msub: 5, pass_id: null });
      // The old balance still releases as before (no pass to give a use back to).
      expect(releaseIfEmpty(db, 'acct_old')).toBe(false);
      db.prepare("UPDATE accounts SET balance_msub = 0 WHERE id = 'acct_old'").run();
      expect(releaseIfEmpty(db, 'acct_old')).toBe(true);
      db.close();
      // Opening it again changes nothing.
      openDb(file).close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads --expires: a date alone is the start of that day in UTC, an ISO time as given', () => {
    expect(passExpiry('2026-12-05')).toBe(Date.UTC(2026, 11, 5));
    expect(passExpiry('2026-12-05T12:00Z')).toBe(Date.UTC(2026, 11, 5, 12));
    expect(passExpiry('2026-12-05T06:00:00-05:00')).toBe(Date.UTC(2026, 11, 5, 11));
    expect(passExpiry('soon')).toBeNaN();
    expect(passExpiry(undefined)).toBeNaN();
  });
});

describe('pnpm admin passes:*', () => {
  it('creates a pass, prints its code and link once, lists it with its uses, and revokes it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-passes-cli-'));
    try {
      const env = { ...process.env, FORGE_DB_PATH: join(dir, 'f.db'), FORGE_FOREIGN_DISCOVERY_RELAYS: '', TOKENFACTORY_API_KEY: 'x' };
      const admin = (...args: string[]) => spawnSync(process.execPath, ['src/admin.ts', ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 30_000 });
      const made = admin('passes:create', '--uses', '500', '--expires', '2099-12-05', '--label', 'hrf', '--json');
      expect(made.status, made.stderr).toBe(0);
      const [row] = JSON.parse(made.stdout);
      expect(row).toMatchObject({ uses: 500, expires: '2099-12-05T00:00:00.000Z' });
      expect(row.link).toBe(`https://ai.forge-reserve.com/j#${row.code}`);
      expect(made.stderr).toMatch(/shown once/);
      const site = admin('passes:create', '--uses', '5', '--expires', '2099-01-01', '--site', 'https://staging.example/', '--json');
      expect(JSON.parse(site.stdout)[0].link).toMatch(/^https:\/\/staging\.example\/j#pass-/);
      const listed = JSON.parse(admin('passes:list', '--json').stdout);
      expect(listed).toHaveLength(2);
      expect(listed[0]).toMatchObject({ id: row.id, label: 'hrf', status: 'open', max_uses: 500, uses: 0, expires_at: '2099-12-05T00:00:00.000Z' });
      expect(JSON.stringify(listed)).not.toContain(row.code);
      expect(admin('passes:revoke', row.code).stdout.trim()).toBe('revoked');
      expect(JSON.parse(admin('passes:list', '--json').stdout)[0].status).toBe('revoked');
      // Refused: no uses, no date, a date gone by.
      expect(admin('passes:create', '--uses', '0', '--expires', '2099-01-01').status).toBe(1);
      expect(admin('passes:create', '--uses', '5').status).toBe(1);
      const past = admin('passes:create', '--uses', '5', '--expires', '2020-01-01');
      expect(past.status).toBe(1);
      expect(past.stderr).toMatch(/expire in the future/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('GET /.well-known/assetlinks.json', () => {
  it('is 404 while no certificate is set', async () => {
    const r = await gateway().app.request('http://gw.test/.well-known/assetlinks.json');
    expect(r.status).toBe(404);
  });

  it('links both apps to the certificates set, as JSON, with no redirect', async () => {
    const plain = DEBUG_CERT.replaceAll(':', '').toLowerCase();
    const g = gateway({ FORGE_ANDROID_CERT_SHA256: `${plain}, AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99` });
    const r = await g.app.request('http://gw.test/.well-known/assetlinks.json');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^application\/json/);
    expect(r.headers.get('location')).toBeNull();
    const body = await r.json();
    expect(body).toEqual(assetLinks([DEBUG_CERT, 'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99']));
    expect(body.map((s: any) => s.target.package_name)).toEqual(['com.forgereserve.ai', 'com.forgereserve.ai.privatevoice']);
    expect(ANDROID_PACKAGES).toEqual(['com.forgereserve.ai', 'com.forgereserve.ai.privatevoice']);
    for (const s of body) {
      expect(s.relation).toEqual(['delegate_permission/common.handle_all_urls']);
      expect(s.target.namespace).toBe('android_app');
      expect(s.target.sha256_cert_fingerprints[0]).toBe(DEBUG_CERT);
    }
  });

  it('refuses a fingerprint that is not one', () => {
    expect(certFingerprint(DEBUG_CERT.toLowerCase())).toBe(DEBUG_CERT);
    expect(() => loadConfig({ FORGE_ANDROID_CERT_SHA256: 'AB:CD', FORGE_FOREIGN_DISCOVERY_RELAYS: '' } as NodeJS.ProcessEnv, catalog)).toThrow(/FORGE_ANDROID_CERT_SHA256/);
  });
});

describe('GET /j', () => {
  it('serves the event page (the pass stays in the fragment, so the server never sees it)', async () => {
    const g = gateway();
    for (const path of ['/j', '/j/']) {
      const r = await g.app.request(`http://gw.test${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/text\/html/);
      const html = await r.text();
      expect(html).toContain('/v2/join/join.js');
      expect(html).toContain('<meta name="theme-color" content="#0B0D10">');
    }
    expect((await g.app.request('http://gw.test/v2/join/view.js')).status).toBe(200);
  });
});

describe('the /j page and the web app read a pass the same way (public/v2/join/view.js, core/join.js)', async () => {
  const V: any = await import('../../public/v2/join/view.js' as string);
  const J: any = await import('../../public/v2/core/join.js' as string);
  const PASS = 'pass-AbC_123-xyz0Q9wE';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36';

  it('takes the pass from the fragment, in either form, and nothing that is not one', () => {
    expect(J.passFrom(`#${PASS}`)).toBe(PASS);
    expect(J.passFrom(`#join=${PASS}`)).toBe(PASS);
    expect(J.passFrom(PASS)).toBe(PASS);
    for (const bad of ['', '#', '#/', '#join=', '#short', '#pass-<script>', '#pass-%ZZ', `#${'a'.repeat(129)}`, '#/funds/add', null, undefined]) expect(J.passFrom(bad), String(bad)).toBeNull();
    expect(J.isJoinHash(`#join=${PASS}`)).toBe(true);
    expect(J.isJoinHash('#join=bad<')).toBe(true);
    expect(J.isJoinHash('#/start')).toBe(false);
    expect(J.webJoin(PASS)).toBe(`/v2/#join=${PASS}`);
    expect(V.passFrom).toBe(J.passFrom);
  });

  it('opens a balance only on a phone with no balance key', () => {
    expect(J.joinPlan({ pass: PASS, hasKey: false })).toBe('open');
    expect(J.joinPlan({ pass: PASS, hasKey: true })).toBe('keep');
    expect(J.joinPlan({ pass: null, hasKey: false })).toBe('none');
  });

  it('sends an iPhone or a computer straight to the web app, Android to the two steps, no pass to /download', () => {
    expect(V.joinRoute({ hash: `#${PASS}`, ua: IPHONE })).toEqual({ go: `/v2/#join=${PASS}` });
    expect(V.joinRoute({ hash: `#${PASS}`, ua: MAC })).toEqual({ go: `/v2/#join=${PASS}` });
    expect(V.joinRoute({ hash: `#${PASS}`, ua: ANDROID })).toEqual({ show: PASS });
    // Android, but the site has no APK to offer: the web app.
    expect(V.joinRoute({ hash: `#${PASS}`, ua: ANDROID, apks: 0 })).toEqual({ go: `/v2/#join=${PASS}` });
    expect(V.joinRoute({ hash: '', ua: ANDROID })).toEqual({ go: '/download' });
    expect(V.joinRoute({ hash: '#nope<', ua: IPHONE })).toEqual({ go: '/download' });
  });

  it('opens the app with an intent link Android reads back as the event link', () => {
    const fallback = V.noAppUrl({ origin: 'https://ai.forge-reserve.com', pass: PASS });
    expect(fallback).toBe(`https://ai.forge-reserve.com/j?app=none#${PASS}`);
    for (const pkg of Object.values(V.PACKAGES) as string[]) {
      const link: string = V.openAppUrl({ host: 'ai.forge-reserve.com', pass: PASS, pkg, fallback });
      expect(link).toBe(`intent://ai.forge-reserve.com/j#${PASS}#Intent;scheme=https;package=${pkg};S.browser_fallback_url=${encodeURIComponent(fallback)};end`);
      // As Intent.parseUri reads it: the intent part starts at the LAST '#', which must be '#Intent;'
      // (the fallback's own '#' is percent-encoded), and the data is what comes before it, with the
      // scheme put back. That data is the event link JoinRules.kt takes.
      const cut = link.lastIndexOf('#');
      expect(link.startsWith('#Intent;', cut)).toBe(true);
      expect(link.endsWith(';end')).toBe(true);
      const extras = Object.fromEntries(
        link
          .slice(cut + '#Intent;'.length, -';end'.length)
          .split(';')
          .map((kv) => kv.split('=')),
      );
      expect(extras).toEqual({ scheme: 'https', package: pkg, 'S.browser_fallback_url': encodeURIComponent(fallback) });
      expect(decodeURIComponent(extras['S.browser_fallback_url'])).toBe(fallback);
      const data = `${extras.scheme}:${link.slice('intent:'.length, cut)}`;
      expect(data).toBe(`https://ai.forge-reserve.com/j#${PASS}`);
      expect(J.passFrom(new URL(data).hash)).toBe(PASS);
    }
    expect(V.PACKAGES).toEqual({ android: 'com.forgereserve.ai', graphene: 'com.forgereserve.ai.privatevoice' });
  });

  it('names the same apps the site links (assetlinks.json) and the manifest filters', async () => {
    const { readFileSync } = await import('node:fs');
    expect(Object.values(V.PACKAGES)).toEqual([...ANDROID_PACKAGES]);
    const manifest = readFileSync(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
    const filter = manifest.slice(manifest.indexOf('<intent-filter android:autoVerify="true">'), manifest.indexOf('</intent-filter>', manifest.indexOf('android:autoVerify')));
    expect(filter).toContain('android.intent.action.VIEW');
    expect(filter).toContain('android.intent.category.BROWSABLE');
    expect(filter).toContain('<data android:scheme="https" />');
    expect(filter).toContain('<data android:host="ai.forge-reserve.com" />');
    expect(filter).toContain('<data android:path="/j" />');
    expect(filter).not.toContain('forgereserve.org');
    const main = readFileSync(join(ROOT, 'android/app/src/main/java/com/forgereserve/ai/MainActivity.kt'), 'utf8');
    expect(main).toContain('registerPlugin(JoinPlugin::class.java)');
  });
});
