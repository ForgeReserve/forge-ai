import { createHmac, randomBytes } from 'node:crypto';
import { deflateRawSync, deflateSync } from 'node:zlib';
import { getDecodedToken } from '@cashu/cashu-ts';
import { describe, expect, it } from 'vitest';
import { codes, ecashz, fakeProofs, noteBytes, secretAt, serialOf, toBase45, validationHash, type BnNote } from '../../support/bitnotes.ts';

// BitNotes paper notes read on the phone (public/v2/core/bitnote.js), against notes written by the test
// port of the BitNotes issuer (test/support/bitnotes.ts) and RFC 9285's own base45 examples. A real note
// was read once by hand with the same code (docs/APP.md, BitNotes notes); it is not in the repository.
const B: any = await import('../../../public/v2/core/bitnote.js' as string);
const N: any = await import('../../../public/v2/core/note.js' as string);
const en: Record<string, string> = ((await import('../../../public/v2/strings/en.js' as string)) as any).default;

const MINT = 'https://mint.example.com';
const seed = () => new Uint8Array(randomBytes(32));
/** A one-mint note of `face` with a static reserve: 100 face, 110 in proofs (64, 32, 8, 4, 2). */
function note(face = 100, amounts = [2, 4, 8, 32, 64], over: Partial<BnNote> = {}): BnNote {
  const s = seed();
  return { face, mints: [{ mint: MINT, proofs: fakeProofs(s, amounts) }], secret: { seed: s, feeStrategy: 'static' }, ...over };
}

describe('base45 (RFC 9285)', () => {
  it("reads the RFC's examples and the BitNotes alphabet, space included", () => {
    const dec = (s: string) => new TextDecoder().decode(B.fromBase45(s));
    expect(dec('BB8')).toBe('AB');
    expect(dec('%69 VD92EX0')).toBe('Hello!!');
    expect(dec('UJCLQE7W581')).toBe('base-45');
    expect(dec('QED8WEX0')).toBe('ietf!');
    expect(toBase45(new TextEncoder().encode('Hello!!'))).toBe('%69 VD92EX0');
  });

  it('round trips any bytes through the test port', () => {
    for (let n = 0; n < 40; n++) {
      const b = new Uint8Array(randomBytes(n * 7 + (n % 3)));
      expect(B.fromBase45(toBase45(b))).toEqual(b);
    }
  });

  it('refuses a character outside the alphabet, a bad length and a group out of range', () => {
    expect(() => B.fromBase45('bb8')).toThrow(/alphabet/);
    expect(() => B.fromBase45('BB8A')).toThrow(/length/);
    // 16 + 16*45 + 32*2025 = 65536, one more than two bytes hold.
    expect(() => B.fromBase45('GGW')).toThrow(/range/);
    // 35 + 35*45 = 1610, more than one byte.
    expect(() => B.fromBase45('ZZ')).toThrow(/range/);
  });

  it('a printed code can carry spaces anywhere but at its end', () => {
    // A three letter group's last letter is at most 65535 / 2025 = 32 ('W'), a two letter one's at most
    // 255 / 45 = 5: a space (36) is never last, so trimming the ends of a scan loses nothing.
    for (let n = 0; n < 200; n++) expect(toBase45(new Uint8Array(randomBytes(1 + (n % 50))))).not.toMatch(/ $/);
  });
});

describe('inflate', () => {
  it('reads zlib (RFC 1950), as BitNotes writes it, and refuses raw deflate', async () => {
    const data = new Uint8Array(randomBytes(500));
    expect(await B.inflate(deflateSync(data, { level: 9 }))).toEqual(data);
    await expect(B.inflate(deflateRawSync(data))).rejects.toThrow();
  });

  it('refuses more than 256 KiB, as the BitNotes app does', async () => {
    expect((await B.inflate(deflateSync(new Uint8Array(256 * 1024)))).length).toBe(256 * 1024);
    await expect(B.inflate(deflateSync(new Uint8Array(256 * 1024 + 1)))).rejects.toThrow(/too large/);
  });
});

describe('the note binary', () => {
  it('parses both codes of a version 3 note', () => {
    const n = note();
    const pub = B.parseBitnote(noteBytes({ ...n, secret: undefined }));
    expect(pub).toMatchObject({ version: 3, face: 100, blockHeight: 900_000, hash: validationHash(n.mints), secret: null });
    expect(pub.mints).toEqual([{ mint: MINT, proofs: n.mints[0]!.proofs.map((p) => ({ ...p, C_: '00'.repeat(33), B_: '00'.repeat(33), dleq: { e: '00'.repeat(32), s: '00'.repeat(32) } })) }]);
    const full = B.parseBitnote(noteBytes(n));
    expect(full.secret).toEqual({ serial: serialOf(validationHash(n.mints)), seed: n.secret!.seed, feeStrategy: 'static' });
    expect(full.mints).toEqual(pub.mints);
  });

  it('reads keyset ids of any length in version 3, and 8 bytes in version 2', () => {
    const s = seed();
    const long = fakeProofs(s, [1], { id: '01' + 'cd'.repeat(32) });
    expect(B.parseBitnote(noteBytes({ face: 1, mints: [{ mint: MINT, proofs: long }] })).mints[0].proofs[0].id).toBe('01' + 'cd'.repeat(32));
    const v2 = B.parseBitnote(noteBytes({ version: 2, face: 1, mints: [{ mint: MINT, proofs: fakeProofs(s, [1, 2]) }] }));
    expect(v2.version).toBe(2);
    expect(v2.mints[0].proofs.map((p: any) => p.id)).toEqual(['00ad268c4d1f5826', '00ad268c4d1f5826']);
  });

  it('reads amounts and indexes past one byte (LEB128)', () => {
    const s = seed();
    const proofs = fakeProofs(s, [2 ** 20], { start: 300 });
    const p = B.parseBitnote(noteBytes({ face: 2 ** 20, mints: [{ mint: MINT, proofs }] })).mints[0].proofs[0];
    expect([p.amount, p.index]).toEqual([2 ** 20, 300]);
  });

  it('refuses another magic, another version, a byte too many and a byte too few', () => {
    const bytes = noteBytes(note());
    expect(() => B.parseBitnote(Uint8Array.from([0xec, 0xa6, ...bytes.subarray(2)]))).toThrow(/not a note/);
    for (const v of [1, 4]) expect(() => B.parseBitnote(Uint8Array.from([0xec, 0xa5, v, ...bytes.subarray(3)]))).toThrow(/version/);
    expect(() => B.parseBitnote(Uint8Array.from([...bytes, 0]))).toThrow();
    expect(() => B.parseBitnote(bytes.subarray(0, bytes.length - 1))).toThrow(/truncated/);
  });
});

describe('secrets and the validation hash', () => {
  it("derives each secret as BitNotes does: HMAC-SHA256 over the label and the index as a u64", async () => {
    const s = seed();
    for (const i of [0, 1, 255, 2 ** 32 + 5]) expect(await B.secretAt(s, i)).toBe(secretAt(s, i));
    // Byte for byte, with the label and index written out here once more.
    const fixed = new Uint8Array(32).fill(7);
    const msg = Buffer.concat([Buffer.from('physical-ecash-v1-'), Buffer.from([1, 0, 0, 0, 0, 0, 0, 0])]);
    expect(await B.secretAt(fixed, 1)).toBe(createHmac('sha256', fixed).update(msg).digest('hex'));
  });

  it('hashes mints and proofs as BitNotes does', async () => {
    const n = note();
    expect(await B.validationHash(n.mints)).toBe(validationHash(n.mints));
  });
});

describe('reading a BitNotes code', () => {
  it('turns the code that controls the funds into a cashuB token of its proofs', async () => {
    const n = note();
    const c = codes(n);
    const r = await B.readBitnote(c.private);
    expect(r).toMatchObject({ ok: true, kind: 'private', version: 3, face: 100, total: 110, feeStrategy: 'static', serial: serialOf(validationHash(n.mints)) });
    expect(r.mints).toHaveLength(1);
    const m = r.mints[0];
    expect(m).toMatchObject({ mint: MINT, amount: 110 });
    // The token as cashu-ts and the phone's own note reader read it.
    const tok = getDecodedToken(m.token, [n.mints[0]!.proofs[0]!.id]);
    expect(tok.mint).toBe(MINT);
    expect(tok.unit).toBe('sat');
    expect(tok.proofs.map((p) => [p.id, Number(p.amount), p.secret, p.C])).toEqual(n.mints[0]!.proofs.map((p) => [p.id, p.amount, secretAt(n.secret!.seed, p.index), p.C]));
    expect(N.readNote(m.token)).toMatchObject({ ok: true, mint: MINT, unit: 'sat', amount: 110, proofs: 5 });
  });

  it('reads the code that only shows the note, and makes no token of it', async () => {
    const r = await B.readBitnote(codes(note()).public);
    expect(r).toEqual({ ok: true, kind: 'public', version: 3, face: 100, total: 110, mints: [{ mint: MINT, amount: 110 }] });
  });

  it('takes the prefix in any case and keeps the spaces, which are part of the code', async () => {
    let n = note();
    let c = codes(n);
    // Notes until one's code has a space in it (most do).
    for (let i = 0; !c.private.slice(7).includes(' '); i++) {
      n = note();
      c = codes(n);
      if (i > 50) throw new Error('no space in 50 codes');
    }
    const lower = 'ecashz:' + c.private.slice(7);
    expect(B.bitnoteText(`  ${lower}\r\n`)).toBe(lower);
    expect(await B.readBitnote(`\n${lower} \n`)).toMatchObject({ ok: true, kind: 'private' });
    // Without its spaces it is another code.
    expect(await B.readBitnote(c.private.replace(/ /g, ''))).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('reads the base64 the BitNotes app also takes behind the same prefix', async () => {
    const n = note();
    const b64 = 'ECASHZ:' + deflateSync(noteBytes(n), { level: 9 }).toString('base64');
    expect(await B.readBitnote(b64)).toMatchObject({ ok: true, kind: 'private', total: 110 });
  });

  it('refuses a code whose proofs do not match its hash, or whose seed is not its proofs', async () => {
    const n = note();
    // One C changed, the header's hash left as printed.
    const proofs = n.mints[0]!.proofs.map((p, i) => (i === 2 ? { ...p, C: fakeProofs(seed(), [8])[0]!.C } : p));
    const tampered = { ...n, hash: validationHash(n.mints), mints: [{ mint: MINT, proofs }] };
    expect(await B.readBitnote(codes(tampered).private)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await B.readBitnote(codes(tampered).public)).toEqual({ ok: false, reason: 'mismatch' });
    // Another seed: the hash holds, the secrets do not hash to the proofs' Y.
    expect(await B.readBitnote(codes({ ...n, secret: { seed: seed() } }).private)).toEqual({ ok: false, reason: 'mismatch' });
  });

  it('leaves the secret to the mint where a proof carries no Y', async () => {
    const n = note();
    const noY = { ...n, mints: [{ mint: MINT, proofs: n.mints[0]!.proofs.map(({ Y: _y, ...p }) => p) }] };
    expect(await B.readBitnote(codes(noY).private)).toMatchObject({ ok: true, kind: 'private' });
  });

  it('reads a note of several mints, one token each', async () => {
    const s = seed();
    const n: BnNote = { face: 20, mints: [{ mint: MINT, proofs: fakeProofs(s, [2, 8, 16]) }, { mint: 'https://other.example/', proofs: fakeProofs(s, [4, 16], { start: 3 }) }], secret: { seed: s } };
    const r = await B.readBitnote(codes(n).private);
    expect(r.mints.map((m: any) => [m.mint, m.amount, N.readNote(m.token).amount])).toEqual([
      [MINT, 26, 26],
      ['https://other.example', 20, 20],
    ]);
    expect(r.total).toBe(46);
  });

  it('says what anything else is', async () => {
    expect(await B.readBitnote('cashuBo2Ftd')).toEqual({ ok: false, reason: 'not_bitnote' });
    expect(await B.readBitnote('')).toEqual({ ok: false, reason: 'not_bitnote' });
    expect(await B.readBitnote('ECASHZ:')).toEqual({ ok: false, reason: 'unreadable' });
    expect(await B.readBitnote('ECASHZ:HELLO WORLD')).toEqual({ ok: false, reason: 'unreadable' });
    // Damaged on the way: zlib's checksum fails.
    const c = codes(note()).private;
    const broken = c.slice(0, 100) + (c[100] === '0' ? '1' : '0') + c.slice(101);
    expect(await B.readBitnote(broken)).toMatchObject({ ok: false });
    // A version this phone does not read.
    const v4 = noteBytes(note());
    v4[2] = 4;
    expect(await B.readBitnote(ecashz(v4))).toEqual({ ok: false, reason: 'unreadable' });
    expect(await B.readBitnote('ECASHZ:' + 'A'.repeat(20_001))).toEqual({ ok: false, reason: 'unreadable' });
    expect(B.isBitnote('ecashz:ABC')).toBe(true);
    expect(B.isBitnote('cashuBabc')).toBe(false);
  });
});

describe('the amount the box shows', () => {
  it('the face value, when the reserve leaves it whatever a mint takes per proof', async () => {
    expect(B.shownAmount(await B.readBitnote(codes(note()).private))).toBe(100);
  });

  it('none for a note with no reserve, or one whose face is more than its proofs', async () => {
    expect(B.shownAmount(await B.readBitnote(codes(note(110, [2, 4, 8, 32, 64], {})).private))).toBe(null);
    expect(B.shownAmount(await B.readBitnote(codes(note(500)).private))).toBe(null);
    expect(B.shownAmount({ ok: false })).toBe(null);
  });
});

describe('the words', () => {
  it('has each BitNotes line, headline first', () => {
    for (const k of ['fund.ecash.bn.public', 'fund.ecash.bn.manyMints', 'fund.ecash.bn.mismatch', 'fund.ecash.bn.unreadable']) {
      expect(en[k], k).toMatch(/^[A-Z][^.]{2,40}\. /);
    }
    expect(en['fund.ecash.bn.manyMints']).toContain('{count}');
  });
});
