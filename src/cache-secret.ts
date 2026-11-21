/**
 * Tinfoil's prompt cache, kept to one payer (docs/PRIVACY.md, Prompt caching).
 *
 * Tinfoil's router picks a request's cache namespace from the API identity and the body's
 * `user_cache_secret` (docs.tinfoil.sh/sdk/prompt-caching). The gateway sends every request under its one
 * Tinfoil key, so on a plaintext request it sets that field itself:
 *  - paid from a balance (any kind: funded, free questions, opened with an invite or an event pass): an
 *    HMAC of the balance id, under a key derived from the wallet seed. The same balance always sends the
 *    same value, across top-ups and restarts, and no two balances share one. Neither a client nor Tinfoil
 *    can compute it, and it says nothing about the balance key or id.
 *  - paid per request with NUT-24: a fresh random value, so such a request shares no cache with any other.
 * A value the client put in the body is mixed into its balance's HMAC, so a client can split its own
 * cache further but never reach another balance's; on NUT-24 it is replaced like any other.
 *
 * The values are never logged or stored. src/app.ts takes the request's value out of supplier error text
 * before that text is logged or returned. A 200 answer, streamed or not, is passed on unread for it:
 * Tinfoil's router removes the field from the body before the model sees it.
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';

/** The HKDF label of the key behind every balance's cache secret. A new label starts every cache afresh. */
export const CACHE_SECRET_INFO = 'forge-ai/tinfoil/user_cache_secret/v1';

/** The body field Tinfoil's router reads (and removes before the model sees the body). */
export const CACHE_SECRET_FIELD = 'user_cache_secret';

/** A 32-byte key for one purpose, derived from server-side secret material (the wallet seed) with HKDF-SHA256. */
export function deriveSeedKey(seed: Uint8Array, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', seed, new Uint8Array(0), info, 32));
}

/** Length-prefixed fields, so no two different lists of fields give the same bytes. */
function framed(fields: string[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of fields) {
    const b = Buffer.from(f, 'utf8');
    const n = Buffer.alloc(4);
    n.writeUInt32BE(b.length);
    parts.push(n, b);
  }
  return Buffer.concat(parts);
}

/**
 * The cache secret of a balance: HMAC-SHA256(key, balance id [, the client's value]), base64url. Stable for
 * the balance, different for every other balance, and different again for each value the client supplies.
 */
export function balanceCacheSecret(key: Uint8Array, accountId: string, clientSecret?: string): string {
  const fields = clientSecret === undefined ? ['balance', accountId] : ['balance', accountId, clientSecret];
  return createHmac('sha256', key).update(framed(fields)).digest('base64url');
}

/** A cache secret no other request will carry: for NUT-24 requests, which are meant to be unlinkable. */
export function freshCacheSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** The client's own `user_cache_secret`, as Tinfoil reads it: a non-empty string, else none. */
export function clientCacheSecret(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
