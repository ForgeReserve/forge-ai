// The recovery drill end to end (docs/FEDIMINT-RECEIVER.md, Backup and recovery): the gateway, the REAL
// receiver binary and a real local federation from `devfed`. Top-ups are credited, two are caught on
// their way (one the gateway never heard back about, one it was told was pending), the gateway's invites
// are exported with src/fedimint-invites.ts, the receiver's data directory is destroyed, and the wallet is
// rebuilt from its words and the invites with `fedimint-receiver recover`. Then: the balance is back to the
// msat, the gateway credits nothing twice and refuses nothing the wallet holds, and what it cannot decide
// waits for the operator with the numbers to decide it.
//
// Needs the two binaries, as topup.fedimint.test.ts does (FORGE_FEDIMINT_BIN_DIR).
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, startGateway } from '../e2e/helpers.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const BIN_DIR = resolve(ROOT, process.env.FORGE_FEDIMINT_BIN_DIR ?? 'services/fedimint-receiver/target/debug');
const RECEIVER_BIN = join(BIN_DIR, 'fedimint-receiver');
const DEVFED_BIN = join(BIN_DIR, 'devfed');
const TOKEN = randomBytes(24).toString('hex');
// A BIP39 test vector: this federation lives only in this test.
const WORDS = 'legal winner thank year wave sausage worth useful legal winner thank yellow';
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

/** Runs a command to its end, with `input` on its stdin. */
function run(bin: string, args: string[], env: NodeJS.ProcessEnv, input = ''): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const p = spawn(bin, args, { cwd: ROOT, env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => done({ status, stdout, stderr }));
    p.stdin.end(input);
  });
}

const stop = (p: ChildProcess) =>
  new Promise<void>((r) => {
    if (p.exitCode !== null || p.signalCode !== null) return r();
    p.once('exit', () => r());
    p.kill('SIGKILL');
  });

/** The receiver, on a fixed data directory and (after the first start) a fixed address, with the words from the environment. */
class Receiver {
  proc?: ChildProcess;
  url = '';
  private listen = '127.0.0.1:0';
  readonly data = join(mkdtempSync(join(tmpdir(), 'forge-fm-drill-')), 'data');
  logs = () => '';
  readonly env = () => ({ FEDIMINT_RECEIVER_DATA_DIR: this.data, FEDIMINT_RECEIVER_MNEMONIC: WORDS, RUST_LOG: 'info' });
  async start() {
    const { proc, ready, stderr } = await startProcess(RECEIVER_BIN, [], { ...this.env(), FEDIMINT_RECEIVER_TOKEN: TOKEN, FEDIMINT_RECEIVER_LISTEN: this.listen });
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

/** pnpm admin in a child process, on the gateway's database. */
function admin(dbPath: string, receiverUrl: string, args: string[], input = '') {
  return run(
    process.execPath,
    ['src/admin.ts', ...args],
    { ...process.env, FORGE_DB_PATH: dbPath, FORGE_FOREIGN_DISCOVERY_RELAYS: '', TOKENFACTORY_API_KEY: 'x', FORGE_FEDIMINT_URL: receiverUrl, FORGE_FEDIMINT_TOKEN: TOKEN },
    input,
  );
}

describe('the recovery drill: the receiver loses its data and comes back from its words and the invites', () => {
  let fed: { invite: string; id: string; url: string; proc: ChildProcess };
  const rx = new Receiver();
  let dbPath = '';
  let g: Gateway;
  const tmp = mkdtempSync(join(tmpdir(), 'forge-fm-drill-files-'));

  const gw = (o: Parameters<typeof startGateway>[0] = {}) =>
    startGateway({ dbPath: dbPath || undefined, ...o, env: { FORGE_FEDIMINT_URL: rx.url, FORGE_FEDIMINT_TOKEN: TOKEN, FORGE_INVITE_ONLY: 'true', ...o.env } });
  const notes = async (amount_msat: number): Promise<{ notes: string; amount_msat: number }> => {
    const r = await fetch(`${fed.url}/notes`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ amount_msat, module: 'mint' }) });
    if (!r.ok) throw new Error(`devfed /notes: ${await r.text()}`);
    return r.json() as any;
  };
  const topup = async (gateway: Gateway, body: object, key?: string) => {
    const r = await fetch(`${gateway.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
    return { status: r.status, body: (await r.json()) as any };
  };
  const balanceOf = async (gateway: Gateway, key: string) => (await (await fetch(`${gateway.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json()).balance_msub as number;
  const fedBalance = async () => (await rx.api(`/federations/${fed.id}/balance`)).balance_msat as number;
  const row = (id: string) => g.deps.db.prepare('SELECT status, notes, error FROM incoming WHERE id = ?').get(id) as { status: string; notes: string | null; error: string | null };
  /** Waits until the receiver's record of a receive has ended. */
  const settled = async (notesId: string) => {
    for (let i = 0; i < 240; i++) {
      const r = await rx.api(`/receive/${notesId}`);
      if (r.state && r.state !== 'pending') return r;
      await new Promise((res) => setTimeout(res, 250));
    }
    throw new Error(`receive ${notesId} still pending`);
  };

  beforeAll(async () => {
    for (const b of [RECEIVER_BIN, DEVFED_BIN]) {
      if (!existsSync(b)) throw new Error(`${b} is missing: build it first (cd services/fedimint-receiver && cargo build --features devfed --bins), or set FORGE_FEDIMINT_BIN_DIR`);
    }
    const { proc, ready } = await startProcess(DEVFED_BIN, ['--mints', 'mint'], {});
    fed = { proc, invite: ready.invite, id: ready.federation_id, url: ready.url };
    await rx.start();
    g = await gw();
    dbPath = g.dbPath;
    dirs.push(resolve(rx.data, '..'), tmp);
  }, LONG);

  afterAll(async () => {
    await g?.close().catch(() => {});
    await Promise.all([...procs].map((p) => stop(p)));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  }, LONG);

  // What was credited before the loss, and the two top-ups caught on their way.
  let credited: { key: string; notes: string; net: number; notesId: string };
  let unheard: { id: string; net: number };
  let pending: { id: string; net: number };
  let before = 0;

  it('takes top-ups, and leaves two of them on their way, as a crash would', async () => {
    const join = await admin(dbPath, rx.url, ['fedimint:join'], `${fed.invite}\n`);
    expect(join.status, join.stderr).toBe(0);

    const a = await notes(50_000);
    const r = await topup(g, { token: a.notes, invite: createInvite(g) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    credited = { key: r.body.key, notes: a.notes, net: r.body.credited_msub, notesId: r.body.fedimint.notes_id };

    // The gateway dies after the receiver answered and before it credited: its row still holds the notes.
    // Until the loss no gateway sweeps (recover: false), so both rows stay as the crash left them.
    await g.close();
    const crashing = await gw({ recover: false, fedimint: { faults: { afterReceive: true } } });
    const b = await notes(30_000);
    expect((await topup(crashing, { token: b.notes }, credited.key)).status).toBe(503);
    await crashing.close();
    // A gateway that does not wait: it hears "pending" and drops the notes from its row.
    g = await gw({ recover: false, fedimint: { waitMs: 0 } });
    const c = await notes(20_000);
    const pc = await topup(g, { token: c.notes }, credited.key);
    expect(pc.body.error?.code).toBe('topup_pending');
    const ids = g.deps.db.prepare("SELECT id, notes FROM incoming WHERE purpose = 'fedimint' AND status = 'prepared' ORDER BY created_at").all() as Array<{ id: string; notes: string | null }>;
    expect(ids.map((x) => x.notes === null)).toEqual([false, true]);
    // Both receives finish at the receiver before the loss; the gateway has not swept since.
    const rb = await settled(ids[0]!.id.slice(3));
    const rc = await settled(ids[1]!.id.slice(3));
    expect([rb.state, rc.state]).toEqual(['done', 'done']);
    unheard = { id: ids[0]!.id, net: rb.net_msat };
    pending = { id: ids[1]!.id, net: rc.net_msat };
    before = await fedBalance();
    expect(before).toBe(credited.net + unheard.net + pending.net);
    expect(await balanceOf(g, credited.key)).toBe(credited.net);
  }, LONG);

  let invitesFile = '';
  it('exports the invites from the gateway into a private file, and prints none', async () => {
    invitesFile = join(tmp, 'invites.txt');
    const out = await run(process.execPath, ['src/fedimint-invites.ts', '--out', invitesFile], { FORGE_DB_PATH: dbPath });
    expect(out.status, out.stderr).toBe(0);
    expect(statSync(invitesFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(invitesFile, 'utf8')).toBe(`# ${fed.id} active\n${fed.invite}\n`);
    expect(out.stdout + out.stderr).not.toContain(fed.invite);
    expect(JSON.parse(out.stderr)).toEqual({ federations: 1, paused: 0 });
    // Never over a file that is there already.
    expect((await run(process.execPath, ['src/fedimint-invites.ts', '--out', invitesFile], { FORGE_DB_PATH: dbPath })).status).not.toBe(0);
  }, LONG);

  it('rebuilds the wallet from the words and the invites after the data directory is lost', async () => {
    await rx.kill();
    rmSync(rx.data, { recursive: true, force: true });
    const out = await run(RECEIVER_BIN, ['recover', '--invites', invitesFile], rx.env());
    expect(out.status, out.stderr).toBe(0);
    const lines = out.stdout.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ federation_id: fed.id, rebuilt: true, balance_msat: before, restore_open: true });
    expect(lines.at(-1)).toEqual({ receives: 0, pending: 0 });
    expect(out.stdout + out.stderr).not.toContain(fed.invite);
    expect(out.stdout + out.stderr).not.toContain('legal winner');
    await rx.start();
    expect(await fedBalance()).toBe(before);
  }, LONG);

  it('credits nothing twice and refuses nothing the wallet holds: what it cannot decide waits for the operator', async () => {
    await g.close();
    g = await gw();
    // The sweep: the row that still held its notes sends them again. The federation has them spent (by
    // this wallet, before the loss) and the receiver cannot show who spent them, so the row is held as
    // stuck: not credited, and not refused. The row the gateway had dropped the notes of finds no record:
    // it stays pending.
    for (let i = 0; i < 120 && row(unheard.id).status === 'prepared'; i++) {
      await g.deps.fedimint!.sweep();
      if (row(unheard.id).status === 'prepared') await new Promise((res) => setTimeout(res, 250));
    }
    expect(row(unheard.id)).toMatchObject({ status: 'stuck', notes: null });
    expect(row(unheard.id).error).toContain('restored from its seed');
    expect(row(pending.id).status).toBe('prepared');
    expect(await balanceOf(g, credited.key)).toBe(credited.net);
    expect(await fedBalance()).toBe(before);

    // The notes credited before the loss, from the same balance: a replay; from another: refused.
    const again = await topup(g, { token: credited.notes }, credited.key);
    expect(again.body).toMatchObject({ replay: true, credited_msub: 0, balance_msub: credited.net });
    const other = await topup(g, { token: credited.notes, invite: createInvite(g) });
    expect(other.body.error?.code).toBe('token_spent');
    expect(await fedBalance()).toBe(before);

    // The operator's numbers: what the receiver holds, less what the gateway credited, is exactly what the
    // two undecided top-ups are worth, so neither is lost.
    const list = await admin(dbPath, rx.url, ['fedimint:list', '--json']);
    expect(list.status, list.stderr).toBe(0);
    const f = JSON.parse(list.stdout)[0];
    expect(f).toMatchObject({ id: fed.id, pending: 1, stuck: 1, credited_msat: credited.net, balance_msat: before });
    expect(f.balance_msat - f.credited_msat).toBe(unheard.net + pending.net);

    // New notes go in as before.
    const d = await notes(15_000);
    const r = await topup(g, { token: d.notes }, credited.key);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await balanceOf(g, credited.key)).toBe(credited.net + r.body.credited_msub);
    expect(await fedBalance()).toBe(before + r.body.credited_msub);
  }, LONG);
});
