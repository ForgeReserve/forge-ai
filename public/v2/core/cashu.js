// The Cashu arithmetic the phone does itself, for the Cashu card (core/card/): blinding and unblinding
// (NUT-00), the mint's proof of a signature (NUT-12), the card's P2PK secret and the one message its
// SIG_ALL signature covers (NUT-11 and the card's spec/NUT-XX.md), and writing a cashuB token. It uses
// the vendored noble library (public/vendor/noble.js, scripts/vendor-noble.sh) and nothing else.
// Pure: no storage, no network. Tested in Node against cashu-ts and the card's own vectors.
import { schnorr, secp256k1, sha256 } from '../../vendor/noble.js';

const Point = secp256k1.Point;
const N = Point.CURVE().n;
const enc = new TextEncoder();

export const utf8 = (s) => enc.encode(s);

export function toHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** Bytes from hex. Throws on odd length or a character that is not hex. */
export function fromHex(hex, what = 'value') {
  const h = String(hex ?? '');
  if (h.length % 2 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error(`${what} is not valid hex`);
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const randomBytes = (n) => crypto.getRandomValues(new Uint8Array(n));

const scalar = (hex) => {
  const v = BigInt('0x' + hex);
  if (v <= 0n || v >= N) throw new Error('not a valid scalar');
  return v;
};

/** A fresh scalar for blinding, 32 bytes hex, in 1..n-1. */
export function randomScalar() {
  for (;;) {
    const h = toHex(randomBytes(32));
    const v = BigInt('0x' + h);
    if (v > 0n && v < N) return h;
  }
}

const point = (hex) => Point.fromHex(String(hex).toLowerCase());

const DOMAIN = utf8('Secp256k1_HashToCurve_Cashu_');

/** NUT-00 hash_to_curve: the point Y for a secret's bytes. */
export function hashToCurve(message) {
  const msgHash = sha256(concat(DOMAIN, message));
  for (let counter = 0; counter < 2 ** 16; counter++) {
    const c = new Uint8Array(4);
    new DataView(c.buffer).setUint32(0, counter, true);
    try {
      return Point.fromBytes(concat(new Uint8Array([2]), sha256(concat(msgHash, c))));
    } catch {
      /* not on the curve: try the next counter */
    }
  }
  throw new Error('no point found for this secret');
}

/** B_ = Y + r·G for a text secret. r is 32 bytes hex (a fresh one when not given). Returns {B_, r}. */
export function blind(secret, r = randomScalar()) {
  const B_ = hashToCurve(utf8(secret)).add(Point.BASE.multiply(scalar(r)));
  return { B_: B_.toHex(true), r };
}

/** C = C_ − r·K: the mint's blind signature made into a proof's C. Compressed hex. */
export function unblind(C_, r, K) {
  return point(C_).subtract(point(K).multiply(scalar(r))).toHex(true);
}

/** NUT-12 hash_e: SHA-256 over the uncompressed points as hex text. */
function hashE(points) {
  return sha256(utf8(points.map((p) => p.toHex(false)).join('')));
}

/**
 * NUT-12: does (e, s) prove that C_ was made with the key K for B_? A mint that sends a proof that does
 * not verify did not sign this output with that key.
 */
export function verifyDleq({ e, s }, B_, C_, K) {
  try {
    const ev = scalar(e);
    const sv = scalar(s);
    const Kp = point(K);
    const Cp = point(C_);
    const R1 = Point.BASE.multiply(sv).subtract(Kp.multiply(ev));
    const R2 = point(B_).multiply(sv).subtract(Cp.multiply(ev));
    return toHex(hashE([R1, R2, Kp, Cp])) === String(e).toLowerCase();
  } catch {
    return false;
  }
}

/**
 * A card piece's secret (the card's spec/NUT-XX.md format 4), rebuilt from what the card stores: its
 * nonce and date, the card's key and its refund key. Byte for byte: the card and the mint hash exactly
 * this text, so a space or a key order out of place is a different secret.
 */
export function cardSecret(nonce, cardKey, date = 0, refundKey = null) {
  const tags = [];
  if (date) {
    if (!refundKey) throw new Error("a dated piece names the card's refund key");
    tags.push(['locktime', String(date)], ['refund', refundKey.toLowerCase()]);
  }
  tags.push(['sigflag', 'SIG_ALL']);
  return JSON.stringify(['P2PK', { nonce: nonce.toLowerCase(), data: cardKey.toLowerCase(), tags }]);
}

/**
 * The NUT-11 SIG_ALL message the card signs: every input's secret and C, then every output's amount
 * (decimal) and B_, as text, hashed with SHA-256.
 */
export function sigAllMessage(inputs, outputs) {
  let text = '';
  for (const i of inputs) text += i.secret + i.C.toLowerCase();
  for (const o of outputs) text += String(o.amount) + o.B_.toLowerCase();
  return sha256(utf8(text));
}

/** BIP-340: is sig (64 bytes hex) the signature of the 32-byte message by the compressed key pub? */
export function schnorrVerify(sig, message, pub) {
  try {
    const p = fromHex(pub, 'key');
    if (p.length !== 33) return false;
    return schnorr.verify(fromHex(sig, 'signature'), message, p.slice(1));
  } catch {
    return false;
  }
}

export { sha256 };

/** An amount as the powers of two a mint signs, largest first. */
export function splitAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error(`not an amount: ${amount}`);
  const out = [];
  for (let bit = 2 ** 52; bit >= 1; bit /= 2) if (Math.floor(amount / bit) % 2 === 1) out.push(bit);
  return out;
}

// ------------------------------------------------------------------ cashuB tokens (NUT-00 version 4)

function cborHead(major, n) {
  if (n < 24) return [(major << 5) | n];
  if (n < 0x100) return [(major << 5) | 24, n];
  if (n < 0x10000) return [(major << 5) | 25, n >> 8, n & 0xff];
  if (n < 0x100000000) return [(major << 5) | 26, (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  if (!Number.isSafeInteger(n)) throw new Error('cbor: number too large');
  const hi = Math.floor(n / 2 ** 32);
  const lo = n % 2 ** 32;
  return [(major << 5) | 27, (hi >>> 24) & 0xff, (hi >>> 16) & 0xff, (hi >>> 8) & 0xff, hi & 0xff, (lo >>> 24) & 0xff, (lo >>> 16) & 0xff, (lo >>> 8) & 0xff, lo & 0xff];
}

/** CBOR (RFC 8949) for what a cashuB token holds: whole numbers, text, bytes, arrays and maps (a Map or a plain object). */
export function writeCbor(v) {
  const out = [];
  const put = (x) => {
    if (typeof x === 'number') {
      if (!Number.isSafeInteger(x) || x < 0) throw new Error('cbor: only whole numbers 0 and up');
      out.push(...cborHead(0, x));
    } else if (typeof x === 'string') {
      const b = utf8(x);
      out.push(...cborHead(3, b.length), ...b);
    } else if (x instanceof Uint8Array) {
      out.push(...cborHead(2, x.length), ...x);
    } else if (Array.isArray(x)) {
      out.push(...cborHead(4, x.length));
      for (const y of x) put(y);
    } else if (x instanceof Map || (x && typeof x === 'object')) {
      const entries = x instanceof Map ? [...x] : Object.entries(x);
      out.push(...cborHead(5, entries.length));
      for (const [k, y] of entries) {
        put(k);
        put(y);
      }
    } else throw new Error(`cbor: cannot write ${typeof x}`);
  };
  put(v);
  return Uint8Array.from(out);
}

function base64url(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A cashuB token for proofs of one mint and unit: {mint, unit, proofs: [{id, amount, secret, C}]}.
 * Proofs are grouped by keyset in the order they come.
 */
export function encodeToken({ mint, unit, proofs }) {
  if (!proofs?.length) throw new Error('a token needs at least one proof');
  const groups = new Map();
  for (const p of proofs) {
    if (!groups.has(p.id)) groups.set(p.id, []);
    groups.get(p.id).push({ a: p.amount, s: p.secret, c: fromHex(p.C, 'C') });
  }
  const body = { m: mint, u: unit, t: [...groups].map(([id, ps]) => ({ i: fromHex(id, 'keyset id'), p: ps })) };
  return 'cashuB' + base64url(writeCbor(body));
}
