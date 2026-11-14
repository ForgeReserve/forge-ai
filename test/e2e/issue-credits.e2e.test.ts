import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getTokenMetadata } from '@cashu/cashu-ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { creditMintUp, type Gateway, MINT_CREDIT, mintsUp, startGateway } from './helpers.ts';

// scripts/issue-credits.ts against the local credit mint (pnpm mint:up).
const SCRIPT = resolve(import.meta.dirname, '../../scripts/issue-credits.ts');

let g: Gateway;
let dir: string;

beforeAll(async () => {
  if (!(await mintsUp()) || !(await creditMintUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'true', FORGE_CREDIT_MINT: MINT_CREDIT, FORGE_FREE_MODELS: 'mock-echo' } });
  dir = mkdtempSync(join(tmpdir(), 'forge-credits-'));
});
afterAll(async () => {
  await g?.close();
});

function run(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT, ...args], { timeout: 60_000 }, (e, out, err) => done({ code: e ? ((e as any).code ?? 1) : 0, out, err }));
  });
}

const tokensOn = (file: string) => [...readFileSync(file, 'utf8').matchAll(/<section class="note" data-token="([^"]+)"/g)].map((m) => m[1]!);

describe('issue-credits', () => {
  it('writes a 0600 sheet of vouchers that each add free questions, and prints no voucher', async () => {
    const out = join(dir, 'vouchers.html');
    const r = await run(['--mint', MINT_CREDIT, '--count', '3', '--questions', '2', '--out', out]);
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('Wrote 3 vouchers of 2 free questions');
    expect(r.out + r.err).not.toMatch(/cashu[AB]/);
    expect(statSync(out).mode & 0o777).toBe(0o600);
    const tokens = tokensOn(out);
    expect(tokens).toHaveLength(3);
    for (const t of tokens) {
      expect(getTokenMetadata(t)).toMatchObject({ mint: MINT_CREDIT, unit: 'usd' });
      const res = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: t }) });
      expect(((await res.json()) as any)).toMatchObject({ free: true, credited: 2 });
    }
  });

  it('writes the public address into the vouchers', async () => {
    const out = join(dir, 'public.html');
    const r = await run(['--mint', MINT_CREDIT, '--public-mint', 'https://credits.example', '--count', '1', '--out', out]);
    expect(r.code).toBe(0);
    expect(getTokenMetadata(tokensOn(out)[0]!).mint).toBe('https://credits.example');
  });

  it('refuses a mint that is not on this computer, and never replaces a file', async () => {
    const far = await run(['--mint', 'https://credits.example', '--count', '1', '--out', join(dir, 'far.html')]);
    expect(far.code).toBe(2);
    expect(far.err).toContain('on this computer');
    const taken = join(dir, 'taken.html');
    writeFileSync(taken, 'mine');
    const r = await run(['--mint', MINT_CREDIT, '--count', '1', '--out', taken]);
    expect(r.code).toBe(1);
    expect(r.err).toContain('already exists');
    expect(readFileSync(taken, 'utf8')).toBe('mine');
  });
});
