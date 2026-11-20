// The gateway's export of its federations' invites for the receiver's recovery (src/fedimint-invites.ts,
// docs/FEDIMINT-RECEIVER.md, Backup and recovery). The end to end drill feeds the file to the real receiver
// in test/fedimint/recovery.fedimint.test.ts.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb } from '../../src/db.ts';
import { invitesText, readInvites } from '../../src/fedimint-invites.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function gatewayDb() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-invites-'));
  dirs.push(dir);
  const path = join(dir, 'forge.db');
  const db = openDb(path);
  const add = db.prepare("INSERT INTO federations (id, name, invite, modules, receives, state, joined_at) VALUES (?, ?, ?, '[]', '[]', ?, ?)");
  add.run('b'.repeat(64), 'Second', 'fed11second', 'paused', 2);
  add.run('a'.repeat(64), 'First\nline', 'fed11first', 'active', 1);
  db.close();
  return { dir, path };
}

function run(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
    const p = spawn(process.execPath, ['src/fedimint-invites.ts', ...args], { cwd: ROOT, env: { PATH: process.env.PATH, ...env } });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.on('close', (status) => done({ status, stdout, stderr }));
  });
}

describe('src/fedimint-invites.ts', () => {
  it('lists every federation, paused ones too, oldest join first, one invite a line after its id', () => {
    const { path } = gatewayDb();
    const list = readInvites(path);
    expect(list.map((f) => f.state)).toEqual(['active', 'paused']);
    expect(invitesText(list)).toBe(`# ${'a'.repeat(64)} active\nfed11first\n# ${'b'.repeat(64)} paused\nfed11second\n`);
    // Nothing but printable characters reaches the file: a stray line break cannot split an entry.
    expect(invitesText([{ id: 'x', state: 'active', invite: 'fed11ab\ncd ef' }])).toBe('# x active\nfed11abcdef\n');
  });

  it('writes a new private file, or a pipe, and never over a file that is there', async () => {
    const { dir, path } = gatewayDb();
    const out = join(dir, 'invites.txt');
    const r = await run(['--out', out], { FORGE_DB_PATH: path });
    expect(r.status, r.stderr).toBe(0);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(readFileSync(out, 'utf8')).toContain('fed11second');
    expect(r.stdout).toBe('');
    expect(JSON.parse(r.stderr)).toEqual({ federations: 2, paused: 1 });
    expect((await run(['--out', out], { FORGE_DB_PATH: path })).status).not.toBe(0);
    // Standard output when it is not a terminal (here a pipe).
    const piped = await run([], { FORGE_DB_PATH: path });
    expect(piped.stdout).toBe(readFileSync(out, 'utf8'));
  });
});
