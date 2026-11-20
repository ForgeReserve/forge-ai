// Fedimint top-ups end to end: the gateway against the REAL receiver binary (services/fedimint-receiver)
// and real local federations from its `devfed` binary (four guardians each, fake bitcoin, no real money).
// Nothing here is a stand-in: notes are made by a federation's own client, the receiver reissues them at
// the federation, and the gateway credits what the receiver's done record says.
//
// The last block drives the v2 app's own top-up client (public/v2/core: fedinote.js reads the notes,
// engine.js sends them, vault.js keeps them on the phone) against the same real gateway and receiver.
//
// Needs the two binaries built first (docs/FEDIMINT-RECEIVER.md, Tests):
//   cd services/fedimint-receiver && cargo build --features devfed --bins
//   pnpm test:fedimint
// FORGE_FEDIMINT_BIN_DIR names the directory that holds them (default: that crate's target/debug). A
// missing binary fails this file; it is never skipped.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { receiveKey } from '../../src/fedimint.ts';
import { createInvite, type Gateway, startGateway } from '../e2e/helpers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BIN_DIR = resolve(ROOT, process.env.FORGE_FEDIMINT_BIN_DIR ?? 'services/fedimint-receiver/target/debug');
const RECEIVER_BIN = join(BIN_DIR, 'fedimint-receiver');
const DEVFED_BIN = join(BIN_DIR, 'devfed');
const TOKEN = randomBytes(24).toString('hex');
const ADMIN_TOKEN = randomBytes(24).toString('hex');
const LONG = 180_000;

const procs = new Set<ChildProcess>();
const dirs: string[] = [];

/** Starts a binary and resolves with the JSON of its first stdout line (both print one when ready). */
function startProcess(bin: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ proc: ChildProcess; ready: any; stderr: () => string }> {
  const proc = spawn(bin, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.add(proc);
  let err = '';
  proc.stderr!.on('data', (d) => (err = (err + d).slice(-20_000)));
  proc.on('exit', () => procs.delete(proc));
  return new Promise((ok, fail) => {
    const lines = createInterface({ input: proc.stdout! });
    const timer = setTimeout(() => fail(new Error(`${bin} printed nothing within 120 s: ${err.slice(-2000)}`)), 120_000);
    lines.once('line', (l) => {
      clearTimeout(timer);
      ok({ proc, ready: JSON.parse(l), stderr: () => err });
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`${bin} exited (${code}) before it was ready: ${err.slice(-2000)}`));
    });
  });
}

const stop = (p: ChildProcess, signal: NodeJS.Signals = 'SIGKILL') =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill(signal);
  });

interface DevFed {
  proc: ChildProcess;
  invite: string;
  id: string;
  url: string;
  notes(amountMsat: number): Promise<{ notes: string; amount_msat: number }>;
  spend(notes: string): Promise<Response>;
}

async function devfed(): Promise<DevFed> {
  const { proc, ready } = await startProcess(DEVFED_BIN, ['--mints', 'mint'], {});
  const post = (path: string, body: object) => fetch(`${ready.url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return {
    proc,
    invite: ready.invite,
    id: ready.federation_id,
    url: ready.url,
    notes: async (amount_msat) => {
      const r = await post('/notes', { amount_msat, module: 'mint' });
      if (!r.ok) throw new Error(`devfed /notes: ${await r.text()}`);
      return r.json();
    },
    spend: (notes) => post('/spend', { notes }),
  };
}

/** The receiver, on a fixed data directory and (after the first start) a fixed address. */
class Receiver {
  proc?: ChildProcess;
  url = '';
  private listen = '127.0.0.1:0';
  readonly data = mkdtempSync(join(tmpdir(), 'forge-fm-receiver-'));
  logs = () => '';
  async start() {
    const { proc, ready, stderr } = await startProcess(RECEIVER_BIN, [], {
      FEDIMINT_RECEIVER_TOKEN: TOKEN,
      FEDIMINT_RECEIVER_LISTEN: this.listen,
      FEDIMINT_RECEIVER_DATA_DIR: this.data,
      RUST_LOG: 'info',
    });
    this.proc = proc;
    this.logs = stderr;
    this.listen = ready.listening;
    this.url = `http://${ready.listening}`;
  }
  async kill() {
    if (this.proc) await stop(this.proc);
  }
  async api(path: string): Promise<any> {
    const r = await fetch(`${this.url}${path}`, { headers: { authorization: `Bearer ${TOKEN}` } });
    return r.json();
  }
}

/** pnpm admin fedimint:* in a child process, on the gateway's database. */
function adminCli(dbPath: string, receiverUrl: string, args: string[], input = '') {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const p = spawn(process.execPath, ['src/admin.ts', ...args], {
      cwd: ROOT,
      env: { ...process.env, FORGE_DB_PATH: dbPath, FORGE_FOREIGN_DISCOVERY_RELAYS: '', TOKENFACTORY_API_KEY: 'x', FORGE_FEDIMINT_URL: receiverUrl, FORGE_FEDIMINT_TOKEN: TOKEN },
    });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => done({ status, stdout, stderr }));
    p.stdin.end(input);
  });
}

const j = (b: object) => JSON.stringify(b);

// The v2 app's client code, as the eCash box uses it (public/v2/modules/fund/ecash/index.js, app.js wallet.topup).
const FN: any = await import('../../public/v2/core/fedinote.js' as string);
const VAULT: any = await import('../../public/v2/core/vault.js' as string);
const ENGINE: any = await import('../../public/v2/core/engine.js' as string);
/** The phone's storage: a Map, as localStorage keeps strings. */
function phoneStorage() {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
}

describe('Fedimint top-ups against the real receiver and a real federation', () => {
  let fed: DevFed;
  let stranger: DevFed;
  const rx = new Receiver();
  let dbPath = '';
  let g: Gateway;

  const gw = (o: Parameters<typeof startGateway>[0] = {}) =>
    startGateway({
      dbPath: dbPath || undefined,
      ...o,
      env: { FORGE_FEDIMINT_URL: rx.url, FORGE_FEDIMINT_TOKEN: TOKEN, FORGE_INVITE_ONLY: 'true', FORGE_ADMIN_TOKEN_HASH: createHash('sha256').update(ADMIN_TOKEN).digest('hex'), FORGE_ADMIN_RATE_LIMIT_RPM: '100000', ...o.env },
    });
  const topup = async (gateway: Gateway, body: object, key?: string) => {
    const r = await fetch(`${gateway.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: j(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const balanceOf = async (gateway: Gateway, key: string) => (await (await fetch(`${gateway.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json()).balance_msub as number;
  const fedBalance = async () => (await rx.api(`/federations/${fed.id}/balance`)).balance_msat as number;
  /** The gateway's newest Fedimint row. */
  const latestRow = (gateway: Gateway) =>
    gateway.deps.db.prepare("SELECT id, status FROM incoming WHERE purpose = 'fedimint' ORDER BY created_at DESC LIMIT 1").get() as { id: string; status: string };
  /** Sweeps until the newest Fedimint row is done (a real federation takes a moment); returns how many sweeps credited. */
  const sweepUntilDone = async (gateway: Gateway) => {
    let credited = 0;
    for (let i = 0; i < 120 && latestRow(gateway).status === 'prepared'; i++) {
      credited += (await gateway.deps.fedimint!.sweep()).credited;
      if (latestRow(gateway).status === 'prepared') await new Promise((res) => setTimeout(res, 250));
    }
    expect(latestRow(gateway).status).toBe('done');
    return credited;
  };
  const accounts = (gateway: Gateway) => (gateway.deps.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n;
  /** The operator's admin API (/admin/api, src/fedimint-admin.ts), as the admin page calls it. */
  const admin = async (gateway: Gateway, path: string, body?: object) => {
    const r = await fetch(`${gateway.url}/admin/api${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-forge-admin-token': ADMIN_TOKEN, ...(body ? { origin: gateway.url, 'content-type': 'application/json' } : {}) },
      body: body ? j(body) : undefined,
    });
    return { status: r.status, body: (await r.json()) as any };
  };

  beforeAll(async () => {
    for (const b of [RECEIVER_BIN, DEVFED_BIN]) {
      if (!existsSync(b)) throw new Error(`${b} is missing: build it first (cd services/fedimint-receiver && cargo build --features devfed --bins), or set FORGE_FEDIMINT_BIN_DIR`);
    }
    [fed, stranger] = await Promise.all([devfed(), devfed()]);
    await rx.start();
    g = await gw();
    dbPath = g.dbPath;
    dirs.push(rx.data);
  }, LONG);

  afterAll(async () => {
    await g?.close().catch(() => {});
    await Promise.all([...procs].map((p) => stop(p)));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, LONG);

  it('joins the federation through pnpm admin fedimint:join, and lists it in the fund methods', async () => {
    const r = await adminCli(dbPath, rx.url, ['fedimint:join', '--json'], `${fed.invite}\n`);
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)[0]).toMatchObject({ id: fed.id, state: 'active', receives: 'mint', max_sat: 100_000, cap_sat: 1_000_000 });
    expect(r.stdout + r.stderr).not.toContain(fed.invite);
    const m = await (await fetch(`${g.url}/v1/wallet/fund/methods`)).json();
    expect(m.fedimint).toMatchObject({ enabled: true, unit: 'sat', max: 100_000, federations: [{ id: fed.id, max: 100_000 }] });
    // The receiver's log never carried the invite either (it was never sent anywhere else).
    expect(rx.logs()).not.toContain(fed.invite);
  }, LONG);

  let first: { key: string; notes: string; net: number };
  it('credits a top-up once, for exactly the net value of the done record', async () => {
    const before = await fedBalance();
    const n = await fed.notes(50_000);
    const r = await topup(g, { token: n.notes, invite: createInvite(g) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rec = await rx.api(`/receive/${r.body.fedimint.notes_id}`);
    expect(rec).toMatchObject({ state: 'done', key: receiveKey(r.body.account_id), gross_msat: n.amount_msat, federation_id: fed.id });
    // The test federation charges a fee to reissue: the balance gets the net, never the face value.
    expect(rec.fee_msat).toBeGreaterThan(0);
    expect(rec.net_msat).toBe(n.amount_msat - rec.fee_msat);
    expect(r.body).toMatchObject({ unit: 'sat', replay: false, credited_msub: rec.net_msat, balance_msub: rec.net_msat });
    expect(await balanceOf(g, r.body.key)).toBe(rec.net_msat);
    expect(await fedBalance()).toBe(before + rec.net_msat);
    first = { key: r.body.key, notes: n.notes, net: rec.net_msat };
  }, LONG);

  it('takes the same notes again from the same balance as a replay, and from another balance not at all', async () => {
    const again = await topup(g, { token: first.notes }, first.key);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ replay: true, credited_msub: 0, balance_msub: first.net });
    const n = accounts(g);
    const code = createInvite(g);
    const other = await topup(g, { token: first.notes, invite: code });
    expect(other.status).toBe(400);
    expect(other.body.error.code).toBe('token_spent');
    expect(accounts(g)).toBe(n);
    expect(g.deps.invites.lookup(code)!.status).toBe('open');
    expect(await balanceOf(g, first.key)).toBe(first.net);
  }, LONG);

  it('refuses notes of a federation it has not joined, and leaves them unspent', async () => {
    const n = await stranger.notes(20_000);
    const r = await topup(g, { token: n.notes, invite: createInvite(g) });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('federation_not_joined');
    // Still the holder's: the federation that issued them takes them back.
    expect((await stranger.spend(n.notes)).ok).toBe(true);
  }, LONG);

  it('refuses a paused federation, and takes its notes again once resumed', async () => {
    expect((await adminCli(dbPath, rx.url, ['fedimint:pause', fed.id])).stdout.trim()).toBe('paused');
    const n = await fed.notes(10_000);
    const paused = await topup(g, { token: n.notes }, first.key);
    expect(paused.status).toBe(400);
    expect(paused.body.error.code).toBe('federation_paused');
    expect((await adminCli(dbPath, rx.url, ['fedimint:resume', fed.id])).stdout.trim()).toBe('active');
    const ok = await topup(g, { token: n.notes }, first.key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    first.net = ok.body.balance_msub;
  }, LONG);

  it('refuses notes over the per-payment cap and over the federation holdings cap', async () => {
    expect((await adminCli(dbPath, rx.url, ['fedimint:join', '--max-sat', '20'], fed.invite)).status).toBe(0);
    const big = await fed.notes(30_000);
    const over = await topup(g, { token: big.notes }, first.key);
    expect(over.status).toBe(400);
    expect(over.body.error.code).toBe('amount_too_large');
    expect(over.body.max).toEqual({ sat: 20 });
    // Holdings: room for 10 sat more than the federation holds now.
    const held = await fedBalance();
    expect((await adminCli(dbPath, rx.url, ['fedimint:join', '--max-sat', '100000', '--cap-sat', String(Math.ceil(held / 1000) + 10)], fed.invite)).status).toBe(0);
    const full = await topup(g, { token: big.notes }, first.key);
    expect(full.status).toBe(400);
    expect(full.body.error.code).toBe('federation_full');
    expect(await fedBalance()).toBe(held);
    expect((await adminCli(dbPath, rx.url, ['fedimint:join', '--cap-sat', '1000000'], fed.invite)).status).toBe(0);
    const ok = await topup(g, { token: big.notes }, first.key);
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    first.net = ok.body.balance_msub;
  }, LONG);

  it.each([
    ['after its row, before the receive', { afterRow: true }],
    ['after the receive answered, before the credit', { afterReceive: true }],
  ])('credits once when the gateway dies %s', async (_when, faults) => {
    await g.close();
    const faulty = await gw({ fedimint: { faults } });
    const n = await fed.notes(15_000);
    const r = await topup(faulty, { token: n.notes }, first.key);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('topup_pending');
    expect(await balanceOf(faulty, first.key)).toBe(first.net);
    await faulty.close();
    // Restart on the same database: startup recovery asks about the row (the federation may still be
    // working, so it may be pending then), and the sweep credits the done record once.
    g = await gw();
    await sweepUntilDone(g);
    const row = latestRow(g);
    const rec = await rx.api(`/receive/${row.id.slice(3)}`);
    expect(rec.state).toBe('done');
    expect(await balanceOf(g, first.key)).toBe(first.net + rec.net_msat);
    // The same notes again: a replay, and a second restart credits nothing more.
    expect((await topup(g, { token: n.notes }, first.key)).body).toMatchObject({ replay: true, credited_msub: 0 });
    await g.close();
    g = await gw();
    expect(await balanceOf(g, first.key)).toBe(first.net + rec.net_msat);
    first.net += rec.net_msat;
  }, LONG);

  it('answers 503 while the receiver is down, and the sweep credits once it is back', async () => {
    // A request that does not wait: the federation is still working when it answers.
    await g.close();
    g = await gw({ fedimint: { waitMs: 0 } });
    const n = await fed.notes(12_000);
    const r = await topup(g, { token: n.notes }, first.key);
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('topup_pending');
    // The receiver has the notes on record, so the gateway no longer holds them.
    expect(g.deps.db.prepare('SELECT status, notes FROM incoming WHERE id = ?').get(latestRow(g).id)).toEqual({ status: 'prepared', notes: null });
    // The receiver is killed at once, and stays down for a sweep.
    await rx.kill();
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 1, credited: 0 });
    // The same notes sent again: the gateway finds its own row by the notes id it works out from them,
    // with no receiver to ask, and says they are on their way.
    const resent = await topup(g, { token: n.notes }, first.key);
    expect(resent.status).toBe(503);
    expect(resent.body.error.code).toBe('topup_pending');
    // Down: new notes are refused before anything is taken.
    const m = await fed.notes(5_000);
    const down = await topup(g, { token: m.notes }, first.key);
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe('fedimint_unavailable');
    expect(await balanceOf(g, first.key)).toBe(first.net);
    // Back, on the same data directory and address: the sweep finds the receive done and credits it once.
    await rx.start();
    expect(await sweepUntilDone(g)).toBe(1);
    const row = latestRow(g);
    const rec = await rx.api(`/receive/${row.id.slice(3)}`);
    expect(rec.state).toBe('done');
    expect(await balanceOf(g, first.key)).toBe(first.net + rec.net_msat);
    expect(await g.deps.fedimint!.sweep()).toEqual({ checked: 0, credited: 0 });
    first.net += rec.net_msat;
    // The notes refused while it was down were never taken: they still go in now (this gateway does not
    // wait for the federation, so it answers pending and the sweep finishes it).
    const late = await topup(g, { token: m.notes }, first.key);
    expect(late.body.error?.code ?? 'credited').toMatch(/^(credited|topup_pending)$/);
    await sweepUntilDone(g);
    const lateRec = await rx.api(`/receive/${latestRow(g).id.slice(3)}`);
    expect(await balanceOf(g, first.key)).toBe(first.net + lateRec.net_msat);
  }, LONG);

  describe("the v2 app's top-up client against the real gateway", () => {
    // Fresh state for the phone: its own vault and its own sat balance key.
    const vault = VAULT.createVault(phoneStorage());
    let appKey: string | null = null;
    const setKey = (k: string, unit?: string) => {
      expect(unit ?? 'sat').toBe('sat');
      appKey = k;
    };
    const appEngine = (gateway: Gateway) => ENGINE.createEngine({ base: gateway.url });
    /** What the eCash box does with notes once the phone has read them and decided to send them. */
    const send = async (gateway: Gateway, notes: string, invite?: string) => {
      const notesId = await FN.notesIdOf(notes);
      return VAULT.topupWithVault({ engine: appEngine(gateway), vault, token: notes, key: appKey, invite, setKey, extra: { kind: 'fedimint', notesId } });
    };

    it('reads the methods and the notes as the gateway and the receiver do, and is credited once', async () => {
      // A gateway that waits for the federation, as in production (the test before left one that does not).
      await g.close();
      g = await gw();
      const methods = await appEngine(g).fundMethods();
      const n = await fed.notes(25_000);
      const read = FN.readFedimint(n.notes);
      expect(read).toMatchObject({ ok: true, module: 'mint', amountMsat: n.amount_msat, prefix: fed.id.slice(0, 8) });
      const check = FN.fedimintCheck(read, methods);
      expect(check).toMatchObject({ verdict: 'send', federation: { id: fed.id, max: 100_000 }, maxSat: 100_000 });
      const before = await fedBalance();
      const r = await send(g, read.notes, createInvite(g));
      expect(r).toMatchObject({ unit: 'sat', replay: false });
      expect(appKey).toMatch(/^sk-forge-/);
      // The id the phone works out is the one the gateway and the receiver use.
      const notesId = await FN.notesIdOf(read.notes);
      expect(g.deps.db.prepare('SELECT status FROM incoming WHERE id = ?').get(`fm:${notesId}`)).toEqual({ status: 'done' });
      const rec = await rx.api(`/receive/${notesId}`);
      expect(rec).toMatchObject({ state: 'done', gross_msat: n.amount_msat });
      expect(Math.round(r.credited * 1000)).toBe(rec.net_msat);
      expect(await balanceOf(g, appKey!)).toBe(rec.net_msat);
      expect(await fedBalance()).toBe(before + rec.net_msat);
      // Credited: gone from the phone.
      expect(vault.incoming()).toEqual([]);
      // The same notes again: a replay, nothing more, and nothing left on the phone.
      expect(await send(g, read.notes)).toMatchObject({ replay: true, credited: 0 });
      expect(vault.incoming()).toEqual([]);
      expect(await balanceOf(g, appKey!)).toBe(rec.net_msat);
    }, LONG);

    it('decides notes of a federation it was not given are not taken, and reads the gateway the same way', async () => {
      const n = await stranger.notes(8_000);
      const read = FN.readFedimint(n.notes);
      // On the phone: nothing would be sent.
      expect(FN.fedimintCheck(read, await appEngine(g).fundMethods()).verdict).toBe('not_taken');
      // Sent anyway, the gateway agrees, and the phone keeps them as still the person's.
      const e = await send(g, read.notes).catch((x: any) => x);
      expect(e).toMatchObject({ code: 'federation_not_joined', status: 400, retryable: false });
      expect(FN.fedimintAnswer(e)).toEqual({ kind: 'yours', key: 'fund.ecash.fm.notTaken' });
      expect(vault.incoming()).toMatchObject([{ token: read.notes, state: 'refused', code: 'federation_not_joined', kind: 'fedimint' }]);
      // Still theirs: their own federation takes them back.
      expect((await stranger.spend(n.notes)).ok).toBe(true);
      vault.discard(vault.incoming()[0].id);
    }, LONG);

    it('keeps notes pending through topup_pending and a receiver that is down, and is credited once when it is back', async () => {
      await g.close();
      // A gateway that does not wait for the federation: the first answer is topup_pending.
      g = await gw({ fedimint: { waitMs: 0 } });
      const start = await balanceOf(g, appKey!);
      const n = await fed.notes(9_000);
      const e = await send(g, n.notes).catch((x: any) => x);
      expect(e).toMatchObject({ code: 'topup_pending', status: 503, retryable: true });
      expect(FN.fedimintAnswer(e).kind).toBe('pending');
      expect(vault.incoming()).toMatchObject([{ token: n.notes, state: 'pending', code: 'topup_pending' }]);
      // The receiver goes down. The app sends the same notes again (as it does on start and when the
      // connection comes back): the gateway finds their row without the receiver and answers
      // topup_pending, and the phone keeps them pending.
      await rx.kill();
      expect(await VAULT.retryPending({ engine: appEngine(g), vault, getKey: () => appKey, setKey })).toBe(0);
      expect(vault.incoming()).toMatchObject([{ token: n.notes, state: 'pending', code: 'topup_pending' }]);
      expect(await balanceOf(g, appKey!)).toBe(start);
      // Back: the app's retries finish it, once.
      await rx.start();
      for (let i = 0; i < 120 && vault.incoming().length; i++) {
        await VAULT.retryPending({ engine: appEngine(g), vault, getKey: () => appKey, setKey });
        if (vault.incoming().length) await new Promise((res) => setTimeout(res, 250));
      }
      expect(vault.incoming()).toEqual([]);
      const rec = await rx.api(`/receive/${await FN.notesIdOf(n.notes)}`);
      expect(rec.state).toBe('done');
      expect(await balanceOf(g, appKey!)).toBe(start + rec.net_msat);
      // Nothing more on any later try.
      expect(await send(g, n.notes)).toMatchObject({ replay: true, credited: 0 });
      expect(await balanceOf(g, appKey!)).toBe(start + rec.net_msat);
    }, LONG);
  });

  describe("the operator's admin against the real receiver", () => {
    const fedView = async (id = fed.id) => (await admin(g, '/fedimint')).body.federations.find((f: any) => f.id === id);

    it('reconciles to the msat: the receiver holds exactly what the gateway credited, and the fees are face value less credited', async () => {
      await g.close();
      g = await gw();
      const r = await admin(g, '/fedimint');
      expect(r.status).toBe(200);
      const v = r.body;
      expect(v.receiver).toMatchObject({ ok: true, error: null, joined: 1 });
      const f = v.federations[0];
      const credited = (g.deps.db.prepare("SELECT SUM(amount_msub) AS s FROM ledger WHERE kind = 'topup' AND ref LIKE 'fm:%'").get() as { s: number }).s;
      expect(f).toMatchObject({ id: fed.id, state: 'active', joined: true, receiver_balance_msat: await fedBalance(), gateway: { credited_msat: credited, sent_msat: 0 }, count: { prepared: 0, stuck: 0 } });
      expect(f.count.done).toBeGreaterThanOrEqual(8);
      // A real federation charges a fee to reissue: it is the face value less what was credited.
      expect(f.gateway.fees_msat).toBeGreaterThan(0);
      expect(f.gateway.received_msat - f.gateway.credited_msat).toBe(f.gateway.fees_msat);
      expect(f.reconciliation).toMatchObject({ status: 'ok', flag: false, difference_msat: 0, expected_msat: credited });
      // Every sat balance here was funded with notes, and the gateway holds no Cashu sat: take out would
      // fail, and the rebalance asks for all of it from this federation.
      expect(v.coverage).toMatchObject({ cashu_sat: 0, shortfall_sat: v.coverage.liabilities_sat });
      expect(v.coverage.liabilities_sat).toBeGreaterThan(0);
      expect(v.coverage.warnings).toEqual(['take_out_short', 'largest_balance_short']);
      expect(v.rebalance).toMatchObject({ need_sat: v.coverage.liabilities_sat, suggested_sat: v.coverage.liabilities_sat, from: [{ federation_id: fed.id }], possible: false });
      expect(JSON.stringify(v)).not.toContain(fed.invite);
    }, LONG);

    it('joins a federation by invite, pauses and resumes it, and changes its holdings cap, which the top-up follows', async () => {
      const joined = await admin(g, '/fedimint/federations', { invite: stranger.invite, cap_sat: 50 });
      expect(joined.status, JSON.stringify(joined.body)).toBe(200);
      expect(joined.body).toMatchObject({ id: stranger.id, state: 'active', created: true, already_joined: false, caps: { cap_sat: 50 } });
      expect(JSON.stringify(joined.body)).not.toContain(stranger.invite);
      expect(rx.logs()).not.toContain(stranger.invite);
      // Over its cap of 50 sat: refused, nothing taken.
      const big = await stranger.notes(60_000);
      expect((await topup(g, { token: big.notes }, first.key)).body.error.code).toBe('federation_full');
      expect((await admin(g, `/fedimint/federations/${stranger.id}/cap`, { cap_sat: null })).body).toMatchObject({ cap_default: true, caps: { cap_sat: 1_000_000 } });
      expect((await admin(g, `/fedimint/federations/${stranger.id}/pause`, {})).body).toEqual({ id: stranger.id, state: 'paused' });
      expect((await topup(g, { token: big.notes }, first.key)).body.error.code).toBe('federation_paused');
      expect((await admin(g, `/fedimint/federations/${stranger.id}/resume`, {})).body).toEqual({ id: stranger.id, state: 'active' });
      const ok = await topup(g, { token: big.notes }, first.key);
      expect(ok.status, JSON.stringify(ok.body)).toBe(200);
      const s = await fedView(stranger.id);
      expect(s).toMatchObject({ joined: true, count: { done: 1 }, gateway: { credited_msat: ok.body.credited_msub }, receiver_balance_msat: ok.body.credited_msub, reconciliation: { status: 'ok', difference_msat: 0 } });
    }, LONG);

    it('Check now finishes a top-up left on its way, once, and the federation reconciles after', async () => {
      await g.close();
      g = await gw({ fedimint: { waitMs: 0 } });
      const n = await fed.notes(11_000);
      const r = await topup(g, { token: n.notes }, first.key);
      expect(r.body.error.code).toBe('topup_pending');
      const id = latestRow(g).id.slice(3);
      expect((await admin(g, '/fedimint')).body.attention).toMatchObject([{ notes_id: id, federation_id: fed.id, status: 'prepared' }]);
      let check: any;
      for (let i = 0; i < 120; i++) {
        check = (await admin(g, `/fedimint/receipts/${id}/check`, {})).body;
        if (check.status !== 'prepared') break;
        // While it waits, the receiver may already hold it: the difference is explained by it, never flagged.
        expect((await fedView()).reconciliation.flag).toBe(false);
        await new Promise((res) => setTimeout(res, 250));
      }
      expect(check).toMatchObject({ status: 'done', credited: true, record: { state: 'done', ours: true }, receiver_error: null });
      const rec = await rx.api(`/receive/${id}`);
      expect((await admin(g, `/fedimint/receipts/${id}/check`, {})).body).toMatchObject({ status: 'done', credited: false });
      expect((await admin(g, '/fedimint')).body.attention).toEqual([]);
      expect(await fedView()).toMatchObject({ receiver_balance_msat: await fedBalance(), reconciliation: { status: 'ok', difference_msat: 0 } });
      expect(rec.state).toBe('done');
    }, LONG);
  });
});
