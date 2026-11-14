import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getDecodedToken, getEncodedToken, getTokenMetadata, type Proof } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { assignNotes, DEFAULT_MINT, denominations, makeNotes, MAX_COUNT, parseAmount, parseArgs, scrub, serial, sheetHtml, split, UsageError } from '../../scripts/lib/notes.ts';
import { qrMatrix, qrSvg } from '../../scripts/lib/qr.ts';

// The pure parts of scripts/print-notes.ts: its arguments, splitting a paid batch into notes, and the
// printable sheet. The script itself runs against the local mint in test/e2e/print-notes.e2e.test.ts.
const C = '02' + 'cd'.repeat(32);
const proof = (amount: number, i: number): Proof => ({ id: '009a1f293253e41e', amount, secret: `s-${amount}-${i}`, C }) as unknown as Proof;

describe('print-notes arguments', () => {
  const day = new Date('2026-12-02T10:00:00Z');

  it('reads a batch in dollars and defaults to the mint the engine trusts', () => {
    const a = parseArgs(['--count', '20', '--amount', '2.50'], day);
    expect(a).toMatchObject({ count: 20, amount: 250, unit: 'usd', mint: DEFAULT_MINT, out: 'notes-2026-12-02.html', resume: null, poll: 2000 });
    // The default is the one the engine trusts out of the box.
    expect(readFileSync(resolve(import.meta.dirname, '../../src/config.ts'), 'utf8')).toContain(`FORGE_TRUSTED_MINTS: csv.default(['${DEFAULT_MINT}'])`);
  });

  it('takes --mint, so the tests use the local mint, and sats', () => {
    expect(parseArgs(['--mint=http://127.0.0.1:3338/', '--unit', 'sat', '--count=3', '--amount=1000', '--out', 'x.html'], day)).toMatchObject({ mint: 'http://127.0.0.1:3338', unit: 'sat', amount: 1000, count: 3, out: 'x.html' });
  });

  it('refuses what would go wrong', () => {
    const bad = (argv: string[]) => expect(() => parseArgs(argv, day)).toThrow(UsageError);
    bad(['--amount', '1']); // no count
    bad(['--count', '0', '--amount', '1']);
    bad(['--count', String(MAX_COUNT + 1), '--amount', '1']);
    bad(['--count', '2']); // no amount
    bad(['--count', '2', '--amount', '1.234']);
    bad(['--count', '2', '--amount', '0']);
    bad(['--count', '2', '--amount', '1.5', '--unit', 'sat']);
    bad(['--count', '2', '--amount', '1', '--unit', 'eur']);
    bad(['--count', '2', '--amount', '1', '--mint', 'http://mint.example']); // plain http to another computer
    bad(['--count', '2', '--amount', '1', '--wat']);
    bad(['--count', '500', '--amount', '10.23']); // too many pieces for one mint request
  });

  it('reads amounts as the owner types them', () => {
    expect(parseAmount('1', 'usd')).toBe(100);
    expect(parseAmount('$2.5', 'usd')).toBe(250);
    expect(parseAmount('0.05', 'usd')).toBe(5);
    expect(parseAmount('2100', 'sat')).toBe(2100);
  });

  it('resume needs only the batch file', () => {
    expect(parseArgs(['--resume', 'n.html.pending.json'])).toMatchObject({ resume: 'n.html.pending.json', out: '' });
  });
});

describe('splitting a batch into notes', () => {
  it('splits an amount into powers of two', () => {
    expect(split(250)).toEqual([128, 64, 32, 16, 8, 2]);
    expect(split(1)).toEqual([1]);
    expect(split(1024)).toEqual([1024]);
    expect(denominations(25, 3)).toEqual([16, 8, 1, 16, 8, 1, 16, 8, 1]);
  });

  it('sorts minted proofs into notes of exactly the amount, whatever order they come in', () => {
    const proofs = denominations(25, 3)
      .map((a, i) => proof(a, i))
      .reverse();
    const notes = assignNotes(proofs, 25, 3);
    expect(notes).toHaveLength(3);
    for (const n of notes) expect(n.map((p) => p.amount).reduce((s, a) => s + Number(a), 0)).toBe(25);
    expect(new Set(notes.flat().map((p) => p.secret)).size).toBe(9);
  });

  it('refuses proofs that do not make up the notes exactly', () => {
    expect(() => assignNotes([proof(16, 0), proof(8, 1)], 25, 1)).toThrow(/do not make up/);
    expect(() => assignNotes([proof(16, 0), proof(8, 1), proof(1, 2), proof(1, 3)], 25, 1)).toThrow(/more pieces/);
  });

  it('makes one token per note, for the mint and unit, with no DLEQ and a serial each', () => {
    const groups = assignNotes(denominations(100, 4).map((a, i) => ({ ...proof(a, i), dleq: { e: 'aa'.repeat(32), s: 'bb'.repeat(32), r: 'cc'.repeat(32) } }) as unknown as Proof), 100, 4);
    const notes = makeNotes('http://127.0.0.1:3338', 'usd', 100, groups);
    expect(notes).toHaveLength(4);
    for (const n of notes) {
      const m = getTokenMetadata(n.token);
      expect([m.mint, m.unit, Number(m.amount)]).toEqual(['http://127.0.0.1:3338', 'usd', 100]);
      expect(n.serial).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    }
    expect(new Set(notes.map((n) => n.serial)).size).toBe(4);
    // Without the DLEQ proofs the code is smaller.
    expect((getDecodedToken(notes[0]!.token, ['009a1f293253e41e']).proofs[0] as any).dleq).toBeUndefined();
    expect(notes[0]!.token.length).toBeLessThan(getEncodedToken({ mint: 'http://127.0.0.1:3338', unit: 'usd', proofs: groups[0]! }).length);
  });

  it('a serial is random and says nothing about the note', () => {
    expect(serial(Buffer.from([0, 1, 2, 3, 4, 5, 6, 31]))).toBe('0123-456Z');
    const many = new Set(Array.from({ length: 200 }, () => serial()));
    expect(many.size).toBeGreaterThan(195);
  });
});

describe('the printable sheet', () => {
  const notes = [
    { token: 'cashuBaaaa' + 'A'.repeat(200), amount: 250, serial: 'K7Q3-MX2A' },
    { token: 'cashuBbbbb' + 'B'.repeat(200), amount: 250, serial: '9ZZ1-0000' },
  ];
  const html = sheetHtml(notes, 'usd');

  it('has one card per note: its code, amount, how-to line and serial', () => {
    expect(html.match(/<section class="note"/g)).toHaveLength(2);
    expect(html.match(/<svg /g)).toHaveLength(2);
    expect(html).toContain('<p class="amount">$2.50</p>');
    expect(html).toContain('Scan this code in Forge AI to add $2.50.');
    expect(html).toContain('No. K7Q3-MX2A');
    expect(html).toContain('Whoever holds this note can spend it. Keep it like cash.');
    expect(html).toContain(`data-token="${notes[1]!.token}"`);
  });

  it('loads nothing: no script, no remote file, and a policy that forbids both', () => {
    expect(html).not.toMatch(/<script|<link|<img|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    expect(html).toContain(`content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"`);
    expect(html).toContain('@media print');
  });

  it('draws the same QR code the web app would', () => {
    const svg = qrSvg('HELLO', 'L');
    const m = qrMatrix('HELLO', 'L');
    const dark = m.flat().filter(Boolean).length;
    // Every dark module is covered by exactly one run.
    const runs = [...svg.matchAll(/h(\d+)v1/g)].reduce((s, x) => s + Number(x[1]), 0);
    expect(runs).toBe(dark);
    expect(svg).toContain(`viewBox="0 0 ${m.length + 8} ${m.length + 8}"`);
  });

  it('follows the copy rules', () => {
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/[–—]/);
    for (const m of text.matchAll(/\becash\b/gi)) expect(m[0]).toBe('eCash');
  });
});

describe('keeping tokens off the terminal', () => {
  it('hides anything shaped like a token', () => {
    expect(scrub('mint said no to cashuBo2FteCJodHRwOi8vMTI3LjAuMC4xOjMzMzgiYXVjdXNk end')).toBe('mint said no to cashu[hidden] end');
    expect(scrub('cashuAeyJ0b2tlbiI6W3sibWludCI6')).toBe('cashu[hidden]');
    expect(scrub('nothing here')).toBe('nothing here');
  });

  it('the script writes to the terminal only through scrubbed errors and plain lines', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../scripts/print-notes.ts'), 'utf8');
    expect(src).not.toMatch(/console\.(log|error|warn|info|debug)/);
    // Nothing that holds a token is ever passed to say().
    for (const m of src.matchAll(/say\(([^)]*)\)/g)) expect(m[1]).not.toMatch(/pending\.notes|\.token\b|proofs|seed|sheetHtml|groups/);
  });
});
