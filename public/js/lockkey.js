// "Lock refunds to my wallet key" (NUT-11 P2PK). The key is a public key, not a secret; it is kept in
// localStorage so refunds from this browser are locked to it. The gateway validates it again.
import { load, store } from './ui.js';

const STORE = 'forge.lockPubkey';
const P = 2n ** 256n - 2n ** 32n - 977n; // secp256k1 field prime
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function modpow(b, e, m) {
  let r = 1n;
  b %= m;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

/** True when x is the x coordinate of a point on secp256k1 (x^3 + 7 is a square mod p). */
function onCurve(xHex) {
  const x = BigInt('0x' + xHex);
  if (x >= P) return false;
  const rhs = (modpow(x, 3n, P) + 7n) % P;
  return modpow(rhs, (P - 1n) / 2n, P) === 1n;
}

function npubToHex(s) {
  const pos = s.lastIndexOf('1');
  if (s.slice(0, pos) !== 'npub') return null;
  const data = [];
  for (const ch of s.slice(pos + 1)) {
    const v = CHARSET.indexOf(ch);
    if (v < 0) return null;
    data.push(v);
  }
  const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  const hrp = [...'npub'].map((c) => c.charCodeAt(0));
  for (const v of [...hrp.map((c) => c >> 5), 0, ...hrp.map((c) => c & 31), ...data]) {
    const b = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >>> i) & 1) chk ^= G[i];
  }
  if (chk >>> 0 !== 1) return null;
  let acc = 0;
  let bits = 0;
  let hex = '';
  for (const v of data.slice(0, -6)) {
    acc = ((acc << 5) | v) & 0xfff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((acc >> bits) & 0xff).toString(16).padStart(2, '0');
    }
  }
  return hex.length === 64 ? hex : null;
}

/**
 * Returns the key as the gateway will use it (33-byte compressed hex), or throws with a message to show.
 * Accepts 02/03 + 64 hex (cashu.me's "P2PK Key"), an npub (Minibits, cashu.me) or 64-hex x-only key;
 * the last two become "02" + x, the convention those wallets use when they lock to a nostr key.
 */
export function parseLockKey(input) {
  const s = String(input ?? '').trim().toLowerCase();
  let hex;
  if (s.startsWith('npub1')) {
    const x = npubToHex(s);
    if (!x) throw new Error('That npub is not valid (check for a typo).');
    hex = '02' + x;
  } else if (/^0[23][0-9a-f]{64}$/.test(s)) hex = s;
  else if (/^[0-9a-f]{64}$/.test(s)) hex = '02' + s;
  else throw new Error('Paste a public key: 66 hex characters starting 02 or 03, or an npub.');
  if (!onCurve(hex.slice(2))) throw new Error('That is not a valid public key.');
  return hex;
}

/** The saved lock key, or '' (also when storage is unavailable). */
export function lockKey() {
  const v = load(STORE) ?? '';
  try {
    return v ? parseLockKey(v) : '';
  } catch {
    return '';
  }
}

export function saveLockKey(hex) {
  store(STORE, hex || null);
}

export const shortKey = (hex) => (hex ? `${hex.slice(0, 10)}…${hex.slice(-6)}` : '');
