import { createHash, createHmac, randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { hashToCurve } from './cardsim.ts';

// BitNotes paper notes for the tests, written as the BitNotes issuer writes them (github.com/nyamuniga/
// paper-bitcoin at 65ce5ea): the compact binary of crates/ecash-core/src/compact.rs (encode_public_data
// and encode_full_note), zlib at its best level and base45 behind "ECASHZ:" (crates/ecash-encoder
// qr_bin), the secrets and blinding factors of derivation.rs, the validation hash of dhke.rs. Ported here
// apart from the phone's reader (public/v2/core/bitnote.js) so each checks the other. Test code only.

const Point = secp256k1.Point;
const N = Point.CURVE().n;
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/** RFC 9285 base45, as the base45 crate writes it. */
export function toBase45(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      let n = bytes[i]! * 256 + bytes[i + 1]!;
      for (let k = 0; k < 3; k++, n = Math.floor(n / 45)) out += B45[n % 45];
    } else {
      const n = bytes[i]!;
      out += B45[n % 45]! + B45[Math.floor(n / 45)]!;
    }
  }
  return out;
}

const u64 = (n: number) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
};

/** derivation.rs secret_at: hex(HMAC-SHA256(seed, "physical-ecash-v1-" || index as u64 LE)). */
export const secretAt = (seed: Uint8Array, index: number) => createHmac('sha256', seed).update('physical-ecash-v1-').update(u64(index)).digest('hex');
/** derivation.rs blinding_factor_at, reduced as k256 reduces it. */
export const blindingAt = (seed: Uint8Array, index: number) => BigInt('0x' + createHmac('sha256', seed).update('physical-ecash-r-v1-').update(u64(index)).digest('hex')) % N;

export interface BnProof {
  amount: number;
  id: string;
  index: number;
  C: string;
  C_?: string;
  B_?: string;
  Y?: string;
  dleq?: { e: string; s: string };
}
export interface BnMint {
  mint: string;
  proofs: BnProof[];
}
export interface BnNote {
  version?: 2 | 3;
  face: number;
  blockHeight?: number;
  /** The validation hash in the header; computed from the proofs when left out. */
  hash?: string;
  mints: BnMint[];
  /** The part only the code that controls the funds carries. */
  secret?: { serial?: string; seed: Uint8Array; feeStrategy?: string };
}

/** dhke.rs compute_validation_hash: SHA-256 over each mint, then each proof's C hex, amount u64 LE and id hex. */
export function validationHash(mints: BnMint[]): string {
  const h = createHash('sha256');
  for (const m of mints) {
    h.update(m.mint);
    for (const p of m.proofs) h.update(p.C).update(u64(p.amount)).update(p.id);
  }
  return h.digest('hex');
}

/** The serial printed on a note (melt.rs serial_from_hash): the hash's first 12 characters in 3 groups. */
export const serialOf = (hash: string) => hash.toUpperCase().slice(0, 12).match(/.{4}/g)!.join('-');

function varint(n: number): number[] {
  const out: number[] = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v) b |= 0x80;
    out.push(b);
  } while (v);
  return out;
}

const hexBytes = (h: string, len?: number) => {
  const b = Buffer.from(h, 'hex');
  if (len != null && b.length !== len) throw new Error(`expected ${len} bytes`);
  return [...b];
};
const ZERO33 = '00'.repeat(33);

/** compact.rs: the public binary, and with `secret` the full note's binary. */
export function noteBytes(n: BnNote): Buffer {
  const version = n.version ?? 3;
  const out: number[] = [0xec, 0xa5, version];
  const u32 = Buffer.alloc(4);
  u32.writeUInt32LE(n.face);
  out.push(...u32);
  u32.writeUInt32LE(n.blockHeight ?? 900_000);
  out.push(...u32, ...hexBytes(n.hash ?? validationHash(n.mints), 32), n.mints.length);
  for (const m of n.mints) {
    const url = Buffer.from(m.mint);
    out.push(url.length, ...url, m.proofs.length);
    for (const p of m.proofs) {
      out.push(...varint(p.amount));
      const id = hexBytes(p.id);
      if (version >= 3) out.push(id.length, ...id);
      else out.push(...hexBytes(p.id, 8));
      out.push(...varint(p.index), ...hexBytes(p.C, 33), ...hexBytes(p.C_ ?? ZERO33, 33), ...hexBytes(p.B_ ?? ZERO33, 33), ...hexBytes(p.Y ?? ZERO33, 33));
      out.push(...hexBytes(p.dleq?.e ?? '00'.repeat(32), 32), ...hexBytes(p.dleq?.s ?? '00'.repeat(32), 32));
    }
  }
  if (n.secret) {
    const serial = Buffer.from(n.secret.serial ?? serialOf(n.hash ?? validationHash(n.mints)));
    const fee = Buffer.from(n.secret.feeStrategy ?? 'static');
    out.push(serial.length, ...serial, ...n.secret.seed, fee.length, ...fee);
  }
  return Buffer.from(out);
}

/** ecash-encoder qr_bin: "ECASHZ:" and base45 of zlib at its best level. The text a note's QR code holds. */
export const ecashz = (bytes: Uint8Array) => 'ECASHZ:' + toBase45(deflateSync(bytes, { level: 9 }));

/** Both codes of a note: the one that shows it and the one that controls the funds. */
export function codes(n: BnNote): { public: string; private: string } {
  if (!n.secret) throw new Error('a note needs its seed');
  return { public: ecashz(noteBytes({ ...n, secret: undefined })), private: ecashz(noteBytes(n)) };
}

/** The proofs of a note without a mint: C is any point, Y is the secret's (for reading tests). */
export function fakeProofs(seed: Uint8Array, amounts: number[], { start = 0, id = '00ad268c4d1f5826' } = {}): BnProof[] {
  return amounts.map((amount, i) => {
    const index = start + i;
    return { amount, id, index, C: hashToCurve(`C-${index}-${amount}`).toHex(true), Y: hashToCurve(secretAt(seed, index)).toHex(true) };
  });
}

/** The amounts a mint signs for an amount: powers of two, smallest first (types.rs split_into_powers_of_2). */
export const powersOf2 = (amount: number) => [...amount.toString(2)].reverse().flatMap((b, i) => (b === '1' ? [2 ** i] : []));

/**
 * Mints a note's proofs at a real mint (the local Nutshell mints: a FakeWallet quote is paid at once),
 * with the note's secrets and blinding factors, as BitNotes' issuer does (mint.rs, BlindingSession).
 */
export async function mintProofs(mint: string, seed: Uint8Array, amounts: number[], start = 0): Promise<BnProof[]> {
  const keysets = (await (await fetch(`${mint}/v1/keysets`)).json()).keysets as { id: string; unit: string; active: boolean }[];
  const ks = keysets.find((k) => k.unit === 'sat' && k.active)!;
  const keys = (await (await fetch(`${mint}/v1/keys/${ks.id}`)).json()).keysets[0].keys as Record<string, string>;
  const post = async (path: string, body: unknown) => {
    const r = await fetch(mint + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(`${path}: ${JSON.stringify(j)}`);
    return j;
  };
  const made = amounts.map((amount, i) => {
    const index = start + i;
    const secret = secretAt(seed, index);
    const r = blindingAt(seed, index);
    const Y = hashToCurve(secret);
    return { amount, index, r, Y: Y.toHex(true), B_: Y.add(Point.BASE.multiply(r)).toHex(true) };
  });
  const total = amounts.reduce((s, a) => s + a, 0);
  const q = await post('/v1/mint/quote/bolt11', { amount: total, unit: 'sat' });
  for (let i = 0; i < 50; i++) {
    if ((await (await fetch(`${mint}/v1/mint/quote/bolt11/${q.quote}`)).json()).state === 'PAID') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const m = await post('/v1/mint/bolt11', { quote: q.quote, outputs: made.map((x) => ({ amount: x.amount, id: ks.id, B_: x.B_ })) });
  return made.map((x, i) => {
    const sig = m.signatures[i] as { C_: string; dleq?: { e: string; s: string } };
    const C = Point.fromHex(sig.C_).subtract(Point.fromHex(keys[String(x.amount)]!).multiply(x.r)).toHex(true);
    return { amount: x.amount, id: ks.id, index: x.index, C, C_: sig.C_, B_: x.B_, Y: x.Y, dleq: sig.dleq };
  });
}

/**
 * A whole note at real mints: `face` printed, each mint's share and a static reserve (the larger of 10
 * sat and 3 percent, mint.rs) unless `direct`, one seed and one run of indexes across the mints.
 */
export async function mintNote(face: number, mints: string[], { direct = false, version = 3 as 2 | 3 } = {}): Promise<BnNote> {
  const seed = randomBytes(32);
  const share = Math.floor(face / mints.length);
  let start = 0;
  const out: BnMint[] = [];
  for (const [i, mint] of mints.entries()) {
    const value = i === 0 ? face - share * (mints.length - 1) : share;
    const amounts = powersOf2(direct ? value : value + Math.max(10, Math.floor((value * 3) / 100)));
    out.push({ mint, proofs: await mintProofs(mint, seed, amounts, start) });
    start += amounts.length;
  }
  return { version, face, blockHeight: 924_321, mints: out, secret: { seed, feeStrategy: direct ? 'direct' : 'static' } };
}
