/**
 * Writes test/unit/fixtures/fedimint/notes.json: real Fedimint notes, as a federation's own client hands
 * them out, with what the real receiver reads in each (POST /parse). The phone's reader
 * (public/v2/core/fedinote.js) is tested against them (test/unit/v2/fedinote.test.ts).
 *
 *   cd services/fedimint-receiver && cargo build --features devfed --bins && cd ../..
 *   node scripts/fedimint-fixtures.ts        # FORGE_FEDIMINT_BIN_DIR: where the two binaries are
 *
 * Two local federations from `devfed` (four guardians each, fake bitcoin, nothing of value): one with both
 * mint modules, which the receiver joins, and one with mint v1 only, which it does not. The notes are
 * bearer notes of those throwaway federations, gone once the processes stop.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const ROOT = resolve(import.meta.dirname, '..');
const BIN_DIR = resolve(ROOT, process.env.FORGE_FEDIMINT_BIN_DIR ?? 'services/fedimint-receiver/target/debug');
const OUT = join(ROOT, 'test/unit/fixtures/fedimint/notes.json');
const TOKEN = randomBytes(24).toString('hex');
const procs: ChildProcess[] = [];

function start(bin: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<any> {
  const proc = spawn(join(BIN_DIR, bin), args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(proc);
  let err = '';
  proc.stderr!.on('data', (d) => (err = (err + d).slice(-4000)));
  return new Promise((ok, fail) => {
    createInterface({ input: proc.stdout! }).once('line', (l) => ok(JSON.parse(l)));
    proc.once('exit', (code) => fail(new Error(`${bin} exited (${code}): ${err}`)));
  });
}

const post = async (url: string, body: object, auth = false) => {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${TOKEN}` } : {}) }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${url}: ${JSON.stringify(j)}`);
  return j;
};

const data = mkdtempSync(join(tmpdir(), 'forge-fm-fixtures-'));
try {
  const [both, other, rx] = await Promise.all([
    start('devfed', ['--mints', 'both']),
    start('devfed', ['--mints', 'mint']),
    start('fedimint-receiver', [], { FEDIMINT_RECEIVER_TOKEN: TOKEN, FEDIMINT_RECEIVER_LISTEN: '127.0.0.1:0', FEDIMINT_RECEIVER_DATA_DIR: data }),
  ]);
  const receiver = `http://${rx.listening}`;
  await post(`${receiver}/federations`, { invite: both.invite }, true);
  const wanted: Array<[string, any, number, 'mint' | 'mintv2', boolean]> = [
    ['v1', both, 50_000, 'mint', false],
    ['v1-small', both, 1_000, 'mint', false],
    ['v1-tiers', both, 1_234_567, 'mint', false],
    ['v1-invite', both, 20_000, 'mint', true],
    ['v2', both, 50_000, 'mintv2', false],
    ['v2-tiers', both, 777_777, 'mintv2', false],
    ['v2-invite', both, 20_000, 'mintv2', true],
    ['v1-not-joined', other, 10_000, 'mint', false],
  ];
  const notes = [];
  for (const [name, fed, amount_msat, module, include_invite] of wanted) {
    const n = await post(`${fed.url}/notes`, { amount_msat, module, include_invite });
    const p = await post(`${receiver}/parse`, { notes: n.notes }, true);
    notes.push({
      name,
      notes: n.notes,
      module: p.module,
      amount_msat: p.amount_msat,
      count: p.count,
      // The full id is in the notes only for mintv2 and for mint v1 with the invite inside.
      federation_id: fed.federation_id,
      carries_federation_id: module === 'mintv2' || include_invite,
      federation_prefix: p.federation_prefix,
      notes_id: p.notes_id,
      joined: p.joined,
    });
  }
  mkdirSync(join(OUT, '..'), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ source: 'scripts/fedimint-fixtures.ts: devfed and the receiver at fedimint 0.13.0', notes }, null, 2) + '\n');
  console.log(`${notes.length} sets of notes in ${OUT}`);
} finally {
  for (const p of procs) p.kill('SIGKILL');
  rmSync(data, { recursive: true, force: true });
}
