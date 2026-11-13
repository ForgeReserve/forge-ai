// Paper notes: reading an eCash note scanned from paper (or pasted) on the phone, before anything is
// sent. Pure, tested in Node.
//
// A note is a Cashu token (cashuB, NUT-00 version 4: CBOR in base64url). This reads its mint, unit and
// amount so the person sees them before adding it. It does not check the proofs: only the mint can say
// whether a note is real and unspent, and the phone talks only to the engine, which asks the mint when
// the note is added.

/** The longest note text read here. A paper note is one QR code, far below this. */
export const MAX_NOTE = 20_000;

/** Base64url (or base64) to bytes. Throws on a character outside the alphabet. */
function fromBase64(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error('not base64');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A small CBOR reader (RFC 8949) for what a cashuB token holds: unsigned and negative integers, byte
 * and text strings, arrays, maps, true, false and null, all of definite length. Anything else throws.
 */
export function readCbor(bytes) {
  let at = 0;
  const need = (n) => {
    if (at + n > bytes.length) throw new Error('cbor: truncated');
  };
  const u8 = () => (need(1), bytes[at++]);
  const len = (info) => {
    if (info < 24) return info;
    if (info === 24) return u8();
    if (info === 25) return (u8() << 8) | u8();
    if (info === 26) return (u8() * 2 ** 24) + ((u8() << 16) | (u8() << 8) | u8());
    if (info === 27) {
      const hi = (u8() * 2 ** 24) + ((u8() << 16) | (u8() << 8) | u8());
      const lo = (u8() * 2 ** 24) + ((u8() << 16) | (u8() << 8) | u8());
      const v = hi * 2 ** 32 + lo;
      if (!Number.isSafeInteger(v)) throw new Error('cbor: number too large');
      return v;
    }
    throw new Error('cbor: indefinite or reserved length');
  };
  const item = (depth) => {
    if (depth > 16) throw new Error('cbor: too deep');
    const b = u8();
    const major = b >> 5;
    const info = b & 31;
    switch (major) {
      case 0:
        return len(info);
      case 1:
        return -1 - len(info);
      case 2: {
        const n = len(info);
        need(n);
        const v = bytes.slice(at, at + n);
        at += n;
        return v;
      }
      case 3: {
        const n = len(info);
        need(n);
        const v = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(at, at + n));
        at += n;
        return v;
      }
      case 4: {
        const n = len(info);
        if (n > bytes.length) throw new Error('cbor: array too long');
        const a = [];
        for (let i = 0; i < n; i++) a.push(item(depth + 1));
        return a;
      }
      case 5: {
        const n = len(info);
        if (n > bytes.length) throw new Error('cbor: map too long');
        const m = new Map();
        for (let i = 0; i < n; i++) {
          const k = item(depth + 1);
          m.set(k, item(depth + 1));
        }
        return m;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        throw new Error('cbor: unsupported simple value');
      default:
        throw new Error('cbor: tags are not used in tokens');
    }
  };
  const v = item(0);
  if (at !== bytes.length) throw new Error('cbor: trailing bytes');
  return v;
}

/** A mint address as the engine compares it: trimmed, no trailing slash. */
export const normalizeMint = (url) => String(url ?? '').trim().replace(/\/+$/, '');

/** A short name for a mint: its host (and port), or the address as given when it is not a URL. */
export function mintLabel(url) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/**
 * Reads scanned or pasted text as a paper note.
 * Returns {ok: true, token, mint, unit, amount, proofs, memo} or {ok: false, reason}, where reason is
 *   'empty': nothing was read,
 *   'not_ecash': the text is not an eCash token (a website link, a balance key, any other code),
 *   'old_format': a cashuA token, which the engine does not take,
 *   'unreadable': it starts like a token but is damaged or not a valid token.
 */
export function readNote(text) {
  const raw = String(text ?? '').replace(/\s+/g, '');
  if (!raw) return { ok: false, reason: 'empty' };
  const token = raw.replace(/^cashu:(?=cashu)/i, '');
  if (/^cashuA/.test(token)) return { ok: false, reason: 'old_format' };
  if (!/^cashuB/.test(token)) return { ok: false, reason: 'not_ecash' };
  if (token.length > MAX_NOTE) return { ok: false, reason: 'unreadable' };
  let v;
  try {
    v = readCbor(fromBase64(token.slice(6)));
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const bad = { ok: false, reason: 'unreadable' };
  if (!(v instanceof Map)) return bad;
  const mint = v.get('m');
  const unit = v.get('u') ?? 'sat';
  const memo = v.get('d');
  const groups = v.get('t');
  if (typeof mint !== 'string' || !mint || typeof unit !== 'string' || !Array.isArray(groups) || !groups.length) return bad;
  let amount = 0;
  let proofs = 0;
  for (const g of groups) {
    if (!(g instanceof Map) || !(g.get('i') instanceof Uint8Array) || !Array.isArray(g.get('p'))) return bad;
    for (const p of g.get('p')) {
      const a = p instanceof Map ? p.get('a') : undefined;
      if (!Number.isSafeInteger(a) || a <= 0 || typeof p.get('s') !== 'string' || !(p.get('c') instanceof Uint8Array)) return bad;
      amount += a;
      proofs++;
    }
  }
  if (!proofs || !Number.isSafeInteger(amount)) return bad;
  return { ok: true, token, mint: normalizeMint(mint), unit, amount, proofs, memo: typeof memo === 'string' && memo ? memo : null };
}

/**
 * What the phone can say about a note before adding it.
 *   mints: the mints the engine takes (from /v1/models). An empty list means not known yet: the engine
 *     decides when the note is added.
 *   aliases: other addresses of those mints (/v1/models mint_aliases). The engine takes a note made
 *     under one of them as a note from its main address.
 *   units: the units the engine takes. balanceUnit: the unit of the balance on this phone, if any.
 *   otherMint: whether the engine offers the other-mint path.
 * Returns 'add', 'other_mint' (from a mint the engine does not take, other-mint path offered),
 * 'wrong_mint' (same, no path offered), 'wrong_unit' (the engine or this balance cannot hold its unit).
 * A unit other than usd and sat is always 'wrong_unit' once the mint is known: no engine holds one.
 */
export function noteVerdict(note, { mints = [], aliases = [], units = [], balanceUnit = null, otherMint = false } = {}) {
  const accepted = !mints.length || [...mints, ...aliases].some((m) => normalizeMint(m) === note.mint);
  if (!accepted) return otherMint && isNoteUnit(note.unit) ? 'other_mint' : 'wrong_mint';
  if (!isNoteUnit(note.unit) || (units.length && !units.includes(note.unit)) || (balanceUnit && balanceUnit !== note.unit)) return 'wrong_unit';
  return 'add';
}

/** The units an engine can hold, and so the only ones the phone shows an amount for. */
export const NOTE_UNITS = Object.freeze(['usd', 'sat']);
export const isNoteUnit = (unit) => NOTE_UNITS.includes(unit);

/**
 * What an engine refusal of a note means, in the words the note screen uses.
 *   'spent': the note has been used. 'other_mint': the engine does not take its mint.
 *   'wrong_unit': the balance or the engine cannot hold its unit. 'kept': not added yet, sent again later.
 *   'failed': anything else.
 */
export function refusalOf(err) {
  switch (err?.code) {
    case 'token_spent':
      return 'spent';
    case 'untrusted_mint':
      return 'other_mint';
    case 'wrong_unit':
      return 'wrong_unit';
    default:
      return err?.retryable ? 'kept' : 'failed';
  }
}
