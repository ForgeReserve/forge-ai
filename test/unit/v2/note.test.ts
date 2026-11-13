import { getDecodedToken, getEncodedToken, getTokenMetadata } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';

// Paper notes on the phone (public/v2/core/note.js): reading a scanned note before it is sent, and
// what the phone says about a note from another mint, in another unit, or already used.
const N: any = await import('../../../public/v2/core/note.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;

const C = '02' + 'ab'.repeat(32);
const proof = (amount: number, i = 0) => ({ id: '009a1f293253e41e', amount, secret: `secret-${amount}-${i}`, C });
const encode = (mint: string, unit: string, amounts: number[]) => getEncodedToken({ mint, unit, proofs: amounts.map(proof) as any });

describe('reading a note', () => {
  it('reads the mint, unit and amount of a cashuB note, as cashu-ts encodes it', () => {
    const token = encode('http://127.0.0.1:3338', 'usd', [64, 32, 4]);
    expect(token.startsWith('cashuB')).toBe(true);
    const n = N.readNote(token);
    expect(n).toEqual({ ok: true, token, mint: 'http://127.0.0.1:3338', unit: 'usd', amount: 100, proofs: 3, memo: null });
    // The same answer cashu-ts gives.
    const meta = getTokenMetadata(token);
    expect([n.mint, n.unit, n.amount]).toEqual([meta.mint, meta.unit, Number(meta.amount)]);
  });

  it('reads a note with proofs from several keysets and a memo', () => {
    const token = getEncodedToken({ mint: 'https://mint.example/', unit: 'sat', memo: 'Thank you', proofs: [proof(512), { ...proof(256), id: '00ffd48b8f5ecf80' }, proof(2, 1)] as any });
    expect(N.readNote(token)).toMatchObject({ ok: true, mint: 'https://mint.example', unit: 'sat', amount: 770, proofs: 3, memo: 'Thank you' });
  });

  it('takes the cashu: prefix and the line breaks a scan or paste can add', () => {
    const token = encode('http://127.0.0.1:3338', 'sat', [8]);
    const wrapped = `cashu:${token.slice(0, 40)}\n${token.slice(40)}  `;
    expect(N.readNote(wrapped)).toMatchObject({ ok: true, token, amount: 8 });
  });

  it('says what a code that is not a usable note is', () => {
    expect(N.readNote('')).toEqual({ ok: false, reason: 'empty' });
    expect(N.readNote('https://example.com/pay')).toEqual({ ok: false, reason: 'not_ecash' });
    expect(N.readNote('sk-forge-abcdefghijklmnopqrstuvwxyz')).toEqual({ ok: false, reason: 'not_ecash' });
    const v3 = 'cashuA' + Buffer.from(JSON.stringify({ token: [{ mint: 'http://127.0.0.1:3338', proofs: [proof(8)] }], unit: 'sat' })).toString('base64url');
    expect(N.readNote(v3)).toEqual({ ok: false, reason: 'old_format' });
    const token = encode('http://127.0.0.1:3338', 'sat', [8, 16]);
    expect(N.readNote(token.slice(0, -12))).toEqual({ ok: false, reason: 'unreadable' }); // a torn code
    expect(N.readNote('cashuB!!!!')).toEqual({ ok: false, reason: 'unreadable' });
    expect(N.readNote('cashuB' + 'A'.repeat(N.MAX_NOTE))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('refuses CBOR that is not a token: wrong shapes, bad amounts, trailing bytes', () => {
    const b64 = (bytes: number[]) => 'cashuB' + Buffer.from(bytes).toString('base64url');
    expect(N.readNote(b64([0x01]))).toEqual({ ok: false, reason: 'unreadable' }); // the number 1
    expect(N.readNote(b64([0xa0]))).toEqual({ ok: false, reason: 'unreadable' }); // an empty map
    expect(N.readNote(b64([0xbf, 0xff]))).toEqual({ ok: false, reason: 'unreadable' }); // indefinite length
    // A valid token with one more byte after it.
    const good = Buffer.from(encode('http://m', 'sat', [1]).slice(6), 'base64url');
    expect(N.readNote(b64([...good, 0x00]))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reads CBOR numbers of every width', () => {
    expect(N.readCbor(Uint8Array.from([0x17]))).toBe(23);
    expect(N.readCbor(Uint8Array.from([0x18, 0xff]))).toBe(255);
    expect(N.readCbor(Uint8Array.from([0x19, 0x01, 0x00]))).toBe(256);
    expect(N.readCbor(Uint8Array.from([0x1a, 0x80, 0x00, 0x00, 0x00]))).toBe(2 ** 31);
    expect(N.readCbor(Uint8Array.from([0x1b, 0, 0, 0, 1, 0, 0, 0, 0]))).toBe(2 ** 32);
    expect(() => N.readCbor(Uint8Array.from([0x1b, 0xff, 0, 0, 0, 0, 0, 0, 0]))).toThrow(/too large/);
    expect(N.readCbor(Uint8Array.from([0x20]))).toBe(-1);
  });

  it('agrees with cashu-ts on a real-shaped note of many proofs', () => {
    const amounts = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048];
    const token = encode('https://forge.flashapp.me', 'sat', amounts);
    const d = getDecodedToken(token, ['009a1f293253e41e']);
    expect(N.readNote(token)).toMatchObject({ amount: d.proofs.reduce((s: number, p: any) => s + Number(p.amount), 0), proofs: 12 });
  });
});

describe('what the phone says about a note', () => {
  const note = (mint = 'http://127.0.0.1:3338', unit = 'usd') => ({ ok: true, token: 'cashuB', mint, unit, amount: 100, proofs: 1 });

  it('adds a note from an accepted mint, matching the address as the engine does', () => {
    expect(N.noteVerdict(note(), { mints: ['http://127.0.0.1:3338/'], units: ['usd', 'sat'] })).toBe('add');
    // Mints not known yet (offline at start): the engine decides.
    expect(N.noteVerdict(note(), {})).toBe('add');
  });

  it('a note from another mint: offers the other-mint path when the engine has one', () => {
    const o = { mints: ['https://forge.flashapp.me'], units: ['usd', 'sat'] };
    expect(N.noteVerdict(note(), { ...o, otherMint: true })).toBe('other_mint');
    expect(N.noteVerdict(note(), { ...o, otherMint: false })).toBe('wrong_mint');
    // The other-mint path takes sat and usd only.
    expect(N.noteVerdict(note('http://x', 'eur'), { ...o, otherMint: true })).toBe('wrong_mint');
  });

  it('a note in a unit this balance or engine cannot hold', () => {
    expect(N.noteVerdict(note(), { mints: ['http://127.0.0.1:3338'], units: ['usd', 'sat'], balanceUnit: 'sat' })).toBe('wrong_unit');
    expect(N.noteVerdict(note(), { mints: ['http://127.0.0.1:3338'], units: ['sat'] })).toBe('wrong_unit');
    expect(N.noteVerdict(note(), { mints: ['http://127.0.0.1:3338'], units: ['usd', 'sat'], balanceUnit: 'usd' })).toBe('add');
  });

  it('turns the engine refusal into the note words: spent, wrong mint, kept for later', () => {
    expect(N.refusalOf({ code: 'token_spent' })).toBe('spent');
    expect(N.refusalOf({ code: 'untrusted_mint' })).toBe('other_mint');
    expect(N.refusalOf({ code: 'wrong_unit' })).toBe('wrong_unit');
    expect(N.refusalOf({ code: 'mint_unavailable', retryable: true })).toBe('kept');
    expect(N.refusalOf({ code: 'offline', retryable: true })).toBe('kept');
    expect(N.refusalOf({ code: 'invalid_token' })).toBe('failed');
  });

  it('a short mint name for the screen', () => {
    expect(N.mintLabel('https://forge.flashapp.me')).toBe('forge.flashapp.me');
    expect(N.mintLabel('http://127.0.0.1:3338')).toBe('127.0.0.1:3338');
    expect(N.mintLabel('not a url')).toBe('not a url');
  });

  it('has words for every outcome the note screen shows', () => {
    for (const k of ['fund.note.unreadable', 'fund.note.notEcash', 'fund.note.oldFormat', 'fund.note.spent', 'fund.note.otherMint', 'fund.note.wrongMint', 'fund.note.wrongUnit', 'fund.note.kept', 'unit.usd', 'unit.sat', 'unit.other', 'home.scanNote', 'funds.scanNote'])
      expect(en[k], k).toBeTruthy();
  });
});
