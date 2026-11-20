/**
 * The invite codes of every federation the gateway has joined, for the Fedimint receiver's recovery from
 * its seed (docs/FEDIMINT-RECEIVER.md, Backup and recovery). Paused federations are included: they still
 * hold notes. Reads the gateway's database (FORGE_DB_PATH) and changes nothing.
 *
 *   node src/fedimint-invites.ts --out FILE   a new file, mode 0600
 *   node src/fedimint-invites.ts > FILE       standard output, refused when it is a terminal
 *
 * One invite code a line, each after a comment line with the federation's id and state, the format
 * `fedimint-receiver recover --invites` reads. The codes are never printed to a terminal or logged.
 */
import { closeSync, openSync, writeSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export interface FederationInvite {
  id: string;
  state: string;
  invite: string;
}

/** Every federation's id, state and invite, oldest join first. */
export function readInvites(dbPath: string): FederationInvite[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare('SELECT id, state, invite FROM federations ORDER BY joined_at, id').all() as unknown as FederationInvite[];
  } finally {
    db.close();
  }
}

/** The file `fedimint-receiver recover --invites` reads. */
export function invitesText(list: FederationInvite[]): string {
  const clean = (s: string) => s.replace(/[^\x21-\x7e]/g, '');
  return list.map((f) => `# ${clean(f.id)} ${clean(f.state)}\n${clean(f.invite)}\n`).join('');
}

function main() {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  const dbPath = process.env.FORGE_DB_PATH ?? 'data/forge.db';
  const list = readInvites(dbPath);
  const text = invitesText(list);
  let fd: number;
  if (values.out) {
    // A new file only, private from its first byte.
    fd = openSync(values.out, 'wx', 0o600);
  } else {
    fd = 1;
    if (process.stdout.isTTY) {
      console.error('the invite codes are not printed: redirect standard output to a file, or give --out FILE');
      process.exit(1);
    }
  }
  writeSync(fd, text);
  if (fd !== 1) closeSync(fd);
  console.error(JSON.stringify({ federations: list.length, paused: list.filter((f) => f.state !== 'active').length }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
