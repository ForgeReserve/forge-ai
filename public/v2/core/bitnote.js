// BitNotes paper notes (bit-notes.com, github.com/nyamuniga/paper-bitcoin): reading one on the phone,
// before anything is sent. Pure, tested in Node.
//
// A BitNotes note carries two QR codes, each the text "ECASHZ:" and base45 (RFC 9285) of zlib (RFC 1950)
// of the note's compact binary (crates/ecash-core/src/compact.rs). Its shape, all integers little endian:
//   magic EC A5, version (3 is written; 2 is still read, with 8 byte keyset ids), face value (u32),
//   block height (u32), the validation hash (32 bytes), the number of mints (1 byte), then per mint its
//   address (1 byte length, UTF-8) and its proofs (1 byte count), each: amount (LEB128), keyset id (v3:
//   1 byte length and bytes; v2: 8 bytes), derivation index (LEB128), then C, C_, B_ and Y (33 bytes
//   each) and the DLEQ e and s (32 bytes each).
// The code printed "public token" ends there: it shows what the note holds and cannot spend it. The other
// one, printed "do not share this code. It controls the funds", goes on: the serial (1 byte length,
// text), the note's 32 byte seed and its fee strategy (1 byte length, text: static, dynamic or direct).
//
// Each proof's secret is hex(HMAC-SHA256(seed, "physical-ecash-v1-" and the index as a u64)), so the
// seed and the public part make ordinary Cashu proofs: {id, amount, secret, C}. The phone checks two
// things before it makes them into a token. The validation hash (SHA-256 over each mint's address, then
// each proof's C in hex, its amount as a u64 and its keyset id in hex) must be the one in the code, and
// each secret must hash to the proof's Y (NUT-00 hash_to_curve), which shows the seed belongs to these
// proofs. Neither says the note is unspent or real: only its mint can, when the eCash is added.
//
// Proofs total the face value and a reserve for Lightning fees (static: the larger of 10 sat and 3
// percent; dynamic: an estimate; direct: none). Sats only.

import { normalizeMint } from './note.js';

/** The longest code text read here. A printed note's code is about 1,100 characters. */
export const MAX_BITNOTE = 20_000;
/** The most a code inflates to, as the BitNotes app's own limit (256 KiB). */
const MAX_INFLATED = 256 * 1024;

const PREFIX = /^ecashz:/i;
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const MAGIC = [0xec, 0xa5];
const enc = new TextEncoder();

/**
 * The code's text as it travels: line breaks and tabs taken out and the ends trimmed, spaces kept (a
 * space is a base45 character). null when the text is not a BitNotes code.
 */
export function bitnoteText(text) {
  const s = String(text ?? '')
    .replace(/[\r\n\t]+/g, '')
    .trim();
  return PREFIX.test(s) ? s : null;
}

/** True for text that starts like a BitNotes code ("ECASHZ:", in any case). */
export const isBitnote = (text) => bitnoteText(text) !== null;

/** RFC 9285 base45 to bytes. Throws on a character outside the alphabet or a group out of range. */
export function fromBase45(s) {
  if (s.length % 3 === 1) throw new Error('base45: bad length');
  const out = [];
  for (let i = 0; i < s.length; i += 3) {
    const v = [...s.slice(i, i + 3)].map((ch) => {
      const n = B45.indexOf(ch);
      if (n < 0) throw new Error('base45: not in the alphabet');
      return n;
    });
    const n = v[0] + v[1] * 45 + (v.length === 3 ? v[2] * 2025 : 0);
    if (v.length === 3) {
      if (n > 0xffff) throw new Error('base45: group out of range');
      out.push(n >> 8, n & 0xff);
    } else {
      if (n > 0xff) throw new Error('base45: group out of range');
      out.push(n);
    }
  }
  return Uint8Array.from(out);
}

/** Standard base64 (the BitNotes app's other reading of the same prefix) to bytes, or null. */
function fromBase64(s) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4) return null;
  try {
    const bin = atob(s);
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** zlib (RFC 1950, what DecompressionStream calls 'deflate') to bytes, at most MAX_INFLATED. */
export async function inflate(bytes) {
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
  const parts = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_INFLATED) {
      await reader.cancel().catch(() => {});
      throw new Error('inflate: too large');
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const u64le = (n) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
  return b;
};

/**
 * The note's binary: {version, face, blockHeight, hash, mints: [{mint, proofs: [{amount, id, index, C,
 * C_, B_, Y, dleq: {e, s}}]}], secret: null for the public code, or {serial, seed, feeStrategy}}.
 * Points and ids in lowercase hex, as the note's own hash reads them. Throws when the bytes are not that
 * exactly (a byte too many is refused, as BitNotes refuses it).
 */
export function parseBitnote(bytes) {
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error('bitnote: truncated');
  };
  const take = (n) => {
    need(n);
    at += n;
    return bytes.subarray(at - n, at);
  };
  const u8 = () => take(1)[0];
  const u32 = () => {
    const b = take(4);
    return b[0] + b[1] * 2 ** 8 + b[2] * 2 ** 16 + b[3] * 2 ** 24;
  };
  const text = (n) => new TextDecoder('utf-8', { fatal: true }).decode(take(n));
  const varint = () => {
    let v = 0;
    for (let shift = 0; ; shift += 7) {
      if (shift > 49) throw new Error('bitnote: number too large');
      const b = u8();
      v += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
    }
    if (!Number.isSafeInteger(v)) throw new Error('bitnote: number too large');
    return v;
  };
  if (u8() !== MAGIC[0] || u8() !== MAGIC[1]) throw new Error('bitnote: not a note');
  const version = u8();
  if (version !== 2 && version !== 3) throw new Error(`bitnote: version ${version} is not read here`);
  const face = u32();
  const blockHeight = u32();
  const hash = hex(take(32));
  const mints = [];
  for (let m = u8(); m > 0; m--) {
    const mint = text(u8());
    const proofs = [];
    for (let n = u8(); n > 0; n--) {
      const amount = varint();
      const id = hex(take(version >= 3 ? u8() : 8));
      const index = varint();
      const [C, C_, B_, Y] = [take(33), take(33), take(33), take(33)].map(hex);
      proofs.push({ amount, id, index, C, C_, B_, Y, dleq: { e: hex(take(32)), s: hex(take(32)) } });
    }
    mints.push({ mint, proofs });
  }
  let secret = null;
  if (at < bytes.length) {
    const serial = text(u8());
    const seed = Uint8Array.from(take(32));
    secret = { serial, seed, feeStrategy: text(u8()) };
  }
  if (at !== bytes.length) throw new Error('bitnote: trailing bytes');
  return { version, face, blockHeight, hash, mints, secret };
}

/** SHA-256 over the parts, as hex. */
async function sha256Hex(parts) {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', all)));
}

/** The note's validation hash (ecash-core dhke.rs compute_validation_hash) over its mints and proofs. */
export function validationHash(mints) {
  return sha256Hex(mints.flatMap((m) => [enc.encode(m.mint), ...m.proofs.flatMap((p) => [enc.encode(p.C), u64le(p.amount), enc.encode(p.id)])]));
}

/** The secret of the proof at `index`: hex(HMAC-SHA256(seed, "physical-ecash-v1-" || index as u64 LE)). */
export async function secretAt(seed, index) {
  const key = await crypto.subtle.importKey('raw', seed, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const label = enc.encode('physical-ecash-v1-');
  const msg = new Uint8Array(label.length + 8);
  msg.set(label);
  msg.set(u64le(index), label.length);
  return hex(new Uint8Array(await crypto.subtle.sign('HMAC', key, msg)));
}

const NO_POINT = '00'.repeat(33);

/**
 * Reads scanned or pasted text as a BitNotes note, with no network call.
 * Returns {ok: true, kind, version, face, total, mints} or {ok: false, reason}.
 *   kind 'public': the code that only shows the note. mints: [{mint, amount}].
 *   kind 'private': the code that controls the funds, checked as above. mints: [{mint, amount, proofs,
 *     token}]: the proofs {id, amount, secret, C} and one cashuB token of them per mint (unit sat). Also
 *     serial and feeStrategy.
 *   face: the value printed on the note, in sat. total: what its proofs hold, face and reserve.
 * reason: 'not_bitnote' (no "ECASHZ:"), 'unreadable' (damaged, or a version not read here), 'mismatch'
 *   (it decodes, but its hash or a secret does not match the note).
 */
export async function readBitnote(text) {
  const s = bitnoteText(text);
  if (!s) return { ok: false, reason: 'not_bitnote' };
  if (s.length > MAX_BITNOTE) return { ok: false, reason: 'unreadable' };
  const data = s.slice('ECASHZ:'.length);
  let note = null;
  // base45 first, then base64, as the BitNotes app reads the same prefix.
  for (const decode of [fromBase45, fromBase64]) {
    try {
      const bytes = decode(data);
      if (bytes) note = parseBitnote(await inflate(bytes));
    } catch {
      /* not this reading */
    }
    if (note) break;
  }
  if (!note || !note.mints.length || note.mints.some((m) => !m.proofs.length || !m.mint)) return { ok: false, reason: 'unreadable' };
  const sum = (ps) => ps.reduce((n, p) => n + p.amount, 0);
  const total = note.mints.reduce((n, m) => n + sum(m.proofs), 0);
  if (!Number.isSafeInteger(total) || note.mints.some((m) => m.proofs.some((p) => p.amount <= 0))) return { ok: false, reason: 'unreadable' };
  if ((await validationHash(note.mints)) !== note.hash) return { ok: false, reason: 'mismatch' };
  const head = { ok: true, version: note.version, face: note.face, total };
  if (!note.secret) return { ...head, kind: 'public', mints: note.mints.map((m) => ({ mint: normalizeMint(m.mint), amount: sum(m.proofs) })) };
  const { encodeToken, hashToCurve, utf8 } = await import('./cashu.js');
  const mints = [];
  for (const m of note.mints) {
    const proofs = [];
    for (const p of m.proofs) {
      const secret = await secretAt(note.secret.seed, p.index);
      // Y is written by every current note. Where it is missing, only the mint can check the secret.
      if (p.Y !== NO_POINT && hashToCurve(utf8(secret)).toHex(true) !== p.Y) return { ok: false, reason: 'mismatch' };
      proofs.push({ id: p.id, amount: p.amount, secret, C: p.C });
    }
    const mint = normalizeMint(m.mint);
    mints.push({ mint, amount: sum(proofs), proofs, token: encodeToken({ mint, unit: 'sat', proofs }) });
  }
  return { ...head, kind: 'private', serial: note.secret.serial, feeStrategy: note.secret.feeStrategy, mints };
}

/**
 * The amount the eCash box shows for a note before it is added, or null to show none. The face value,
 * only where the proofs hold it and one sat more per proof: what a mint's input fee can take (up to 1,000
 * ppk per proof) then still leaves the face value, so the person is never credited less than shown. A
 * note whose proofs carry no reserve (direct) shows no amount; the engine's answer says what was added.
 */
export function shownAmount(read) {
  if (!read?.ok) return null;
  const proofs = read.mints.reduce((n, m) => n + (m.proofs?.length ?? 0), 0);
  return read.face > 0 && read.total >= read.face + proofs ? read.face : null;
}
