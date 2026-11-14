import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { makeNoteRecords, sheetHtml, UsageError } from '../../scripts/lib/notes.ts';
import { parseVoucherArgs } from '../../scripts/lib/vouchers.ts';

// scripts/issue-credits.ts: free question vouchers, issued from the credit mint on this computer only.

describe('issue-credits arguments', () => {
  const today = new Date('2026-12-01T10:00:00Z');
  it('takes a mint on this computer, a public address, a count and questions per voucher', () => {
    expect(parseVoucherArgs(['--mint', 'http://127.0.0.1:3341/', '--public-mint', 'https://credits.example', '--count', '20'], today)).toEqual({
      help: false,
      mint: 'http://127.0.0.1:3341',
      publicMint: 'https://credits.example',
      count: 20,
      questions: 3,
      out: 'free-questions-2026-12-01.html',
    });
    expect(parseVoucherArgs(['--mint=http://localhost:3338', '--count=1', '--questions=5', '--out=x.html'], today)).toMatchObject({ publicMint: 'http://localhost:3338', questions: 5, out: 'x.html' });
  });

  it('refuses a mint that is not on this computer', () => {
    for (const m of ['https://credits.example', 'http://10.0.0.5:3338', 'http://127.0.0.1.example:3338']) {
      expect(() => parseVoucherArgs(['--mint', m, '--count', '1'], today), m).toThrow(/on this computer/);
    }
  });

  it('refuses bad counts, questions, public addresses and unknown flags', () => {
    const base = ['--mint', 'http://127.0.0.1:3341'];
    expect(() => parseVoucherArgs([...base], today)).toThrow(UsageError);
    expect(() => parseVoucherArgs([...base, '--count', '0'], today)).toThrow(/--count/);
    expect(() => parseVoucherArgs([...base, '--count', '501'], today)).toThrow(/--count/);
    expect(() => parseVoucherArgs([...base, '--count', '1', '--questions', '0'], today)).toThrow(/--questions/);
    expect(() => parseVoucherArgs([...base, '--count', '1', '--public-mint', 'http://credits.example'], today)).toThrow(/https/);
    expect(() => parseVoucherArgs([...base, '--count', '1', '--amount', '3'], today)).toThrow(/unknown argument/);
    expect(() => parseVoucherArgs(['--count', '1'], today)).toThrow(/--mint is needed/);
  });
});

describe('the voucher sheet', () => {
  const html = sheetHtml(makeNoteRecords(['cashuBaaaa' + 'A'.repeat(200), 'cashuBbbbb' + 'B'.repeat(200)], 3), 'usd', 'credits');

  it('uses the paper note layout with free question words, and says they are not money', () => {
    expect(html.match(/<section class="note"/g)).toHaveLength(2);
    expect(html).toContain('<title>Forge AI free questions</title>');
    expect(html).toContain('<p class="amount">3 free questions</p>');
    expect(html).toContain('Scan this code in Forge AI to add 3 free questions.');
    expect(html).toContain('Free questions only. It cannot be turned into money.');
    expect(html).not.toContain('$0.03');
    expect(html.match(/data-serial="[0-9A-Z]{4}-[0-9A-Z]{4}"/g)).toHaveLength(2);
  });

  it('reads one free question as one', () => {
    expect(sheetHtml(makeNoteRecords(['cashuBx'], 1), 'usd', 'credits')).toContain('<p class="amount">1 free question</p>');
  });

  it('loads nothing and follows the copy rules', () => {
    expect(html).not.toMatch(/<script|<link|<img|https?:\/\/(?!www\.w3\.org\/2000\/svg)/);
    const text = html.replace(/<[^>]+>/g, ' ');
    expect(text).not.toMatch(/[–—]/);
  });

  it('the script writes vouchers only to the file, never to the terminal', () => {
    const src = readFileSync(resolve(import.meta.dirname, '../../scripts/issue-credits.ts'), 'utf8');
    expect(src).not.toMatch(/console\.(log|error|warn|info|debug)/);
    for (const m of src.matchAll(/say\(([^)]*)\)/g)) expect(m[1]).not.toMatch(/tokens|\.token\b|sheetHtml/);
  });
});
