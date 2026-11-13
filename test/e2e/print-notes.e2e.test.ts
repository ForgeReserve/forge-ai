import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTokenMetadata, Wallet } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { denominations } from '../../scripts/lib/notes.ts';
import { createInvite, type Gateway, MINT_A, mintsUp, startGateway, userWallet } from './helpers.ts';

// scripts/print-notes.ts against the local test mint (pnpm mint:up). Its FakeWallet backend pays every
// invoice at once, which stands in for the owner paying.
const SCRIPT = resolve(import.meta.dirname, '../../scripts/print-notes.ts');

let g: Gateway;
let dir: string;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false' } });
  dir = mkdtempSync(join(tmpdir(), 'forge-notes-'));
});
afterAll(async () => {
  await g?.close();
});

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, '--poll', '100', ...args], { timeout: 60_000 }, (e, out, err) => done({ code: e ? ((e as any).code ?? 1) : 0, out, err }));
  });
}

/** The notes on a sheet: token and serial of each card. */
function notesOn(file: string) {
  const html = readFileSync(file, 'utf8');
  return [...html.matchAll(/<section class="note" data-token="([^"]+)" data-serial="([^"]+)"/g)].map((m) => ({ token: m[1]!, serial: m[2]! }));
}

async function unspent(tokens: string[]) {
  const w = await userWallet(MINT_A, 'usd');
  const proofs = tokens.flatMap((t) => w.decodeToken(t).proofs);
  return (await w.checkProofsStates(proofs)).every((s) => s.state === 'UNSPENT');
}

const noSecrets = (r: { out: string; err: string }, extra: string[] = []) => {
  const all = r.out + r.err;
  expect(all).not.toMatch(/cashu[AB]/);
  for (const s of extra) expect(all).not.toContain(s);
};

describe('print-notes', () => {
  it('shows one invoice, waits for it to be paid, and writes a 0600 sheet of working notes', async () => {
    const out = join(dir, 'batch.html');
    const r = await run(['--mint', MINT_A, '--count', '3', '--amount', '0.25', '--out', out]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    // The invoice for the whole batch, as text and as a code.
    expect(r.out).toContain('3 notes of $0.25: pay $0.75 with this Lightning invoice.');
    expect(r.out).toMatch(/\nlnbc\w+\n/);
    expect(r.out).toContain('█');
    expect(r.out).toContain(`Wrote 3 notes of $0.25 to ${out}.`);
    // Tokens never reach the terminal.
    noSecrets(r);

    expect(statSync(out).mode & 0o777).toBe(0o600);
    expect(existsSync(`${out}.pending.json`)).toBe(false); // the batch file (with its seed) is gone
    const notes = notesOn(out);
    expect(notes).toHaveLength(3);
    expect(new Set(notes.map((n) => n.serial)).size).toBe(3);
    for (const n of notes) {
      const m = getTokenMetadata(n.token);
      expect([m.mint, m.unit, Number(m.amount)]).toEqual([MINT_A, 'usd', 25]);
    }
    expect(await unspent(notes.map((n) => n.token))).toBe(true);

    // A note works in Forge: the engine adds it to a new balance.
    const res = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: notes[0]!.token, invite: createInvite(g) }) });
    const body: any = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ unit: 'usd', credited: 25 });
    // Once used, it is spent.
    const again = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: notes[0]!.token, invite: createInvite(g) }) });
    expect(((await again.json()) as any).error.code).toBe('token_spent');
  }, 90_000);

  it('makes notes in sats too', async () => {
    const out = join(dir, 'sats.html');
    const r = await run(['--mint', MINT_A, '--unit', 'sat', '--count', '2', '--amount', '1000', '--out', out]);
    expect(r.code).toBe(0);
    noSecrets(r);
    const notes = notesOn(out);
    expect(notes.map((n) => Number(getTokenMetadata(n.token).amount))).toEqual([1000, 1000]);
    expect(getTokenMetadata(notes[0]!.token).unit).toBe('sat');
  }, 90_000);

  it('never replaces a file, and stops before any invoice', async () => {
    const out = join(dir, 'taken.html');
    writeFileSync(out, 'keep me');
    const r = await run(['--mint', MINT_A, '--count', '1', '--amount', '1', '--out', out]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already exists');
    expect(r.err).toContain('Nothing was paid or minted.');
    expect(r.out).not.toMatch(/lnbc/);
    expect(readFileSync(out, 'utf8')).toBe('keep me');
    expect(existsSync(`${out}.pending.json`)).toBe(false);
  });

  it('refuses a bad batch with the usage text', async () => {
    const r = await run(['--mint', MINT_A, '--count', '0', '--amount', '1']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--count must be 1 to 500');
    expect(r.err).toContain('Makes printable paper notes of eCash.');
  });

  /** A batch as the script leaves it when it stops after the invoice: a paid quote and its seed. */
  async function pendingBatch(name: string, { mintItToo = false } = {}) {
    const seed = randomBytes(32);
    const w = new Wallet(MINT_A, { unit: 'usd', bip39seed: seed });
    await w.loadMint();
    const q = await w.createMintQuoteBolt11(2 * 50);
    for (let i = 0; i < 50 && (await w.checkMintQuoteBolt11(q.quote)).state !== 'PAID'; i++) await new Promise((r) => setTimeout(r, 100));
    const out = join(dir, `${name}.html`);
    const p = { v: 1, mint: MINT_A, unit: 'usd', amount: 50, count: 2, out, quote: q.quote, request: q.request, expiry: q.expiry ?? null, seed: seed.toString('hex'), keysetId: w.keysetId, counter: 1 };
    // The mint signed, but its answer never reached the script.
    if (mintItToo) await w.mintProofsBolt11(100, q.quote, { keysetId: w.keysetId }, { type: 'deterministic', counter: 1, denominations: denominations(50, 2) });
    const file = `${out}.pending.json`;
    writeFileSync(file, JSON.stringify(p), { mode: 0o600 });
    return { out, file, seed: seed.toString('hex') };
  }

  it('--resume finishes a paid batch that was stopped before minting', async () => {
    const b = await pendingBatch('resumed');
    const r = await run(['--resume', b.file]);
    expect(r.code).toBe(0);
    noSecrets(r, [b.seed]);
    expect(r.out).not.toMatch(/lnbc/); // already paid: no invoice shown again
    const notes = notesOn(b.out);
    expect(notes.map((n) => Number(getTokenMetadata(n.token).amount))).toEqual([50, 50]);
    expect(await unspent(notes.map((n) => n.token))).toBe(true);
    expect(existsSync(b.file)).toBe(false);
  }, 60_000);

  it('--resume restores the notes when the mint signed but its answer was lost', async () => {
    const b = await pendingBatch('restored', { mintItToo: true });
    const r = await run(['--resume', b.file]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    noSecrets(r, [b.seed]);
    const notes = notesOn(b.out);
    expect(notes).toHaveLength(2);
    expect(notes.map((n) => Number(getTokenMetadata(n.token).amount))).toEqual([50, 50]);
    expect(await unspent(notes.map((n) => n.token))).toBe(true);
    expect(statSync(b.out).mode & 0o777).toBe(0o600);
  }, 60_000);
});
