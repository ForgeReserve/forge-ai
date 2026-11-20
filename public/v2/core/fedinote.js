// Fedimint eCash notes: telling them from Cashu on the phone, before anything is sent. Pure, tested in
// Node against real notes (test/unit/fixtures/fedimint/notes.json, scripts/fedimint-fixtures.ts).
//
// Two kinds, as the Fedimint receiver reads them (services/fedimint-receiver/src/notes.rs, fedimint 0.13):
//   mint v1 OOBNotes: base64url or base64, or "fedimint" and base32, of a list of parts: the notes (an
//     amount tier, then each note's signature and secret key), the federation id's first 4 bytes, and
//     optionally the federation's invite (which ends with its full id).
//   mintv2 ECash: "fedimint" and base32 of a list of fields: the federation's full id, then each note
//     (its denomination, 2^d msat, its secret key and its signature), optionally an invite and a unit.
// Both are fedimint's consensus encoding: lengths and enum variants as BigSize, each variant's fields
// wrapped in a length-prefixed byte string. Whitespace anywhere is ignored, as fedimint's parsers do.
//
// Reading here is strict: the text must decode to exactly that shape, so junk, a balance key or a
// Lightning invoice is never taken for notes. It does not check signatures: only the receiver can, and
// it says so when the notes are added. The amount is read when it is plain (every note in bitcoin); it
// is the notes' face value, before the federation's fee.

/** The longest text read as notes, as the receiver's own limit. */
export const MAX_NOTES_TEXT = 200_000;

const B32 = '0123456789abcdefghijklmnopqrstuv';

/** fedimint's base32: RFC 4648 base32hex in lowercase, bits taken from the low end first, no padding. */
function fromBase32(s) {
  const out = [];
  let buf = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B32.indexOf(ch);
    if (v < 0) throw new Error('not base32');
    buf |= v << bits;
    bits += 5;
    while (bits >= 8) {
      out.push(buf & 0xff);
      buf >>>= 8;
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

/** Base64 (standard or URL-safe, padded or not) to bytes, or null. */
function fromBase64(s) {
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(s) || (/[+/]/.test(s) && /[_-]/.test(s))) return null;
  const b64 = s.replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (b64.length % 4 === 1) return null;
  try {
    const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A reader over bytes: BigSize numbers (canonical only) and length-prefixed slices. Throws past the end. */
function reader(bytes) {
  let at = 0;
  const need = (n) => {
    if (n < 0 || at + n > bytes.length) throw new Error('truncated');
  };
  const u8 = () => (need(1), bytes[at++]);
  const big = () => {
    const b = u8();
    if (b < 0xfd) return b;
    const n = b === 0xfd ? 2 : b === 0xfe ? 4 : 8;
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + u8();
    if (!Number.isSafeInteger(v)) throw new Error('number too large');
    // BigSize must use the shortest form.
    if ((n === 2 && v < 0xfd) || (n === 4 && v < 0x10000) || (n === 8 && v < 0x100000000)) throw new Error('not canonical');
    return v;
  };
  const take = (n) => {
    need(n);
    const v = bytes.subarray(at, at + n);
    at += n;
    return v;
  };
  return { u8, big, take, bytes: () => take(big()), end: () => at === bytes.length };
}

/** A list of enum variants, each {variant, body}: the shape of both note formats. Exactly the bytes. */
function variants(bytes) {
  const r = reader(bytes);
  const n = r.big();
  if (n > bytes.length) throw new Error('list too long');
  const out = [];
  for (let i = 0; i < n; i++) out.push({ variant: r.big(), body: r.bytes() });
  if (!r.end()) throw new Error('trailing bytes');
  return out;
}

const V1_SIGNATURE = 48;
const SECRET = 32;
const FEDERATION_ID = 32;

/** mint v1 OOBNotes, or null when the bytes are not that. */
function v1(bytes) {
  let parts;
  try {
    parts = variants(bytes);
  } catch {
    return null;
  }
  const notesPart = parts.find((p) => p.variant === 0);
  const prefixPart = parts.find((p) => p.variant === 1);
  const invite = parts.find((p) => p.variant === 2);
  if (!notesPart || (!prefixPart && !invite)) return null;
  if (prefixPart && prefixPart.body.length !== 4) return null;
  if (invite && invite.body.length < FEDERATION_ID + 1) return null;
  // The invite's last field is the federation's full id.
  const federationId = invite ? hex(invite.body.subarray(invite.body.length - FEDERATION_ID)) : null;
  const prefix = prefixPart ? hex(prefixPart.body) : federationId.slice(0, 8);
  if (federationId && !federationId.startsWith(prefix)) return null;
  // The notes: tiers of {amount in msat, notes}, each note a signature and a secret key.
  const secrets = [];
  let amount = 0;
  try {
    const r = reader(notesPart.body);
    const tiers = r.big();
    for (let i = 0; i < tiers; i++) {
      const msat = r.big();
      const n = r.big();
      if (n > notesPart.body.length) throw new Error('too many notes');
      for (let j = 0; j < n; j++) {
        r.take(V1_SIGNATURE);
        secrets.push(r.take(SECRET));
        amount += msat;
      }
    }
    if (!r.end()) return null;
  } catch {
    return null;
  }
  if (!secrets.length || !Number.isSafeInteger(amount) || amount <= 0) return null;
  return { module: 'mint', prefix, federationId, amountMsat: amount, count: secrets.length, secrets };
}

/** mintv2 ECash, or null when the bytes are not that. */
function v2(bytes) {
  let fields;
  try {
    fields = variants(bytes);
  } catch {
    return null;
  }
  const mint = fields.find((f) => f.variant === 0);
  const notes = fields.filter((f) => f.variant === 1);
  if (!mint || mint.body.length !== FEDERATION_ID || !notes.length) return null;
  const federationId = hex(mint.body);
  const secrets = [];
  let amount = 0;
  for (const n of notes) {
    // denomination (one byte), secret key, signature.
    if (n.body.length !== 1 + SECRET + V1_SIGNATURE || n.body[0] > 63) return null;
    secrets.push(n.body.subarray(1, 1 + SECRET));
    amount += 2 ** n.body[0];
  }
  // A unit field: notes in something other than bitcoin. Their sum is not msat.
  const bitcoin = !fields.some((f) => f.variant === 4);
  return { module: 'mintv2', prefix: federationId.slice(0, 8), federationId, amountMsat: bitcoin && Number.isSafeInteger(amount) ? amount : null, count: secrets.length, secrets };
}

/** The whole reading, secrets included (for notesIdOf). null when the text is not Fedimint notes. */
function parse(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s || s.length > MAX_NOTES_TEXT || /^cashu/i.test(s)) return null;
  if (/^fedimint/i.test(s)) {
    let bytes;
    try {
      bytes = fromBase32(s.slice(8).toLowerCase());
    } catch {
      return null;
    }
    const r = v1(bytes) ?? v2(bytes);
    // In lower case, as fedimint writes it (a QR code may carry it in upper case).
    return r && { ...r, notes: s.toLowerCase() };
  }
  const bytes = fromBase64(s);
  const r = bytes && v1(bytes);
  return r && { ...r, notes: s };
}

/**
 * Reads pasted or scanned text as Fedimint notes, with no network call.
 * Returns {ok: true, notes, module: 'mint' | 'mintv2', amountMsat (or null), count, federationId (the
 * full id, or null when mint v1 notes carry only its first 4 bytes), prefix} or {ok: false}.
 * notes: the text as it is sent: its whitespace taken out, and base32 in lower case.
 */
export function readFedimint(text) {
  const r = parse(text);
  if (!r) return { ok: false };
  const { secrets, ...rest } = r;
  return { ok: true, ...rest };
}

/** 'cashu' for a Cashu token (cashuA or cashuB, with or without "cashu:"), 'fedimint' for notes, else 'none'. */
export function tokenKind(text) {
  const s = String(text ?? '').replace(/\s+/g, '').replace(/^cashu:(?=cashu)/i, '');
  if (/^cashu[AB]/.test(s)) return 'cashu';
  return parse(s) ? 'fedimint' : 'none';
}

/** The first 4 bytes of a federation id, as its prefix is written. */
const prefixOf = (id) => String(id ?? '').toLowerCase().slice(0, 8);

/**
 * The federation, from GET /v1/wallet/fund/methods (fedimint.federations), that issued the notes:
 * {id, name, max}, or null when none of them did, or undefined when more than one shares the notes'
 * short prefix (the engine tells them apart, or refuses).
 */
export function federationOf(read, federations = []) {
  if (read.federationId) return federations.find((f) => f.id?.toLowerCase() === read.federationId) ?? null;
  const hits = federations.filter((f) => prefixOf(f.id) === read.prefix);
  return hits.length === 1 ? hits[0] : hits.length ? undefined : null;
}

/**
 * What the phone decides before it sends notes, from the engine's methods (GET /v1/wallet/fund/methods).
 *   'off': the engine takes no Fedimint notes (fedimint absent or not enabled), or its ways are not known
 *     yet: nothing is sent.
 *   'not_taken': none of the federations it takes issued them: nothing is sent.
 *   'too_large': their face value is over the most it takes in one payment (federation.max or
 *     fedimint.max, in sat): nothing is sent.
 *   'send': send them; the engine decides.
 * Returns {verdict, federation (or null), maxSat}.
 */
export function fedimintCheck(read, methods) {
  const fm = methods?.fedimint;
  if (!fm?.enabled) return { verdict: 'off', federation: null, maxSat: null };
  const federation = federationOf(read, Array.isArray(fm.federations) ? fm.federations : []);
  if (federation === null) return { verdict: 'not_taken', federation: null, maxSat: null };
  const maxSat = federation?.max ?? fm.max ?? null;
  if (read.amountMsat != null && typeof maxSat === 'number' && read.amountMsat > maxSat * 1000) return { verdict: 'too_large', federation: federation ?? null, maxSat };
  return { verdict: 'send', federation: federation ?? null, maxSat };
}

/**
 * What an engine answer to a Fedimint top-up means (docs/PAYMENTS.md, Fedimint notes), for the words
 * and for the notes kept on the phone (core/vault.js):
 *   kind 'yours': refused, nothing was spent: the notes are still the person's (kept, marked refused).
 *   kind 'spent': refused, the notes were spent or given first elsewhere (kept, marked refused).
 *   kind 'pending': the outcome is not known yet: the notes stay on the phone and are sent again.
 *   kind 'stuck': the federation took them and nothing was credited: help is needed (kept, marked stuck).
 * key: the string that says it.
 */
export function fedimintAnswer(err) {
  const code = err?.code;
  const yours = (key) => ({ kind: 'yours', key });
  switch (code) {
    case 'federation_not_joined':
      return yours('fund.ecash.fm.notTaken');
    case 'federation_paused':
      return yours('fund.ecash.fm.paused');
    case 'federation_full':
      return yours('fund.ecash.fm.full');
    case 'amount_too_large':
      return yours('fund.ecash.fm.tooLarge');
    case 'insufficient_amount':
      return yours('fund.ecash.fm.tooSmall');
    case 'notes_unsupported':
      return yours('fund.ecash.fm.unsupported');
    case 'invalid_token':
      return yours('fund.ecash.fm.invalid');
    // Notes already on their way when the receiver went quiet stay pending (core/vault.js topupWithVault).
    case 'fedimint_unavailable':
      return err.retryable ? { kind: 'pending', key: 'fund.ecash.fm.pending' } : yours('fund.ecash.fm.unavailable');
    // A dollar balance only, and the engine would not open one in sats beside it.
    case 'wrong_unit':
    case 'sibling_refused':
      return yours('fund.ecash.fm.needSats');
    case 'token_spent':
      return { kind: 'spent', key: 'fund.ecash.fm.spent' };
    case 'issuance_failed':
      return { kind: 'stuck', key: 'fund.ecash.fm.stuck' };
    default:
      return err?.retryable ? { kind: 'pending', key: 'fund.ecash.fm.pending' } : yours('fund.ecash.fm.failed');
  }
}

/**
 * The notes' id, as the receiver and the engine name them (notes.rs notes_id): SHA-256 over a fixed
 * label, the module, the federation id's first 4 bytes and each note's public key in order. The same
 * notes have the same id however they were written. The person reads it out to whoever helps them.
 * Resolves the hex id, or null when the text is not notes.
 */
export async function notesIdOf(text) {
  const r = parse(text);
  if (!r) return null;
  const { secp256k1, sha256 } = await import('../../vendor/noble.js');
  const keys = r.secrets.map((s) => secp256k1.getPublicKey(s, true));
  keys.sort((a, b) => {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
  });
  const enc = new TextEncoder();
  const parts = [enc.encode('forge-fedimint-receiver/notes-id/1\0'), enc.encode(r.module), new Uint8Array([0]), Uint8Array.from(r.prefix.match(/../g).map((h) => parseInt(h, 16))), ...keys];
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  return hex(sha256(all));
}

/** A short form of the notes' id for the screen: its first 12 characters. The whole id is copied. */
export const shortId = (id) => String(id ?? '').slice(0, 12);
