import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { balanceCacheSecret, CACHE_SECRET_INFO, clientCacheSecret, deriveSeedKey, freshCacheSecret } from '../../src/cache-secret.ts';
import { GatewayWallet } from '../../src/cashu/wallet.ts';
import { openDb } from '../../src/db.ts';

// The Tinfoil cache secret of a balance (src/cache-secret.ts, docs/PRIVACY.md, Prompt caching).

const seed = Buffer.from('ab'.repeat(64), 'hex');
const key = deriveSeedKey(seed, CACHE_SECRET_INFO);

describe('cache secret derivation', () => {
  // Known answers, worked out apart from src/cache-secret.ts (node:crypto hkdfSync and createHmac over the
  // length-prefixed fields). Every balance's Tinfoil prompt cache is named by these values: a change to the
  // label, the HKDF, the framing, the HMAC or the encoding changes them, and with them every balance's
  // secret, so every balance starts with an empty cache. Change these strings only on purpose.
  it('gives the pinned outputs for a fixed seed', () => {
    expect(CACHE_SECRET_INFO).toBe('forge-ai/tinfoil/user_cache_secret/v1');
    expect(key.toString('hex')).toBe('2df0a03020278455ba096edaac387ac607aacbc9ed94ad8d9b9ed1a5924860cc');
    const id = 'acct_00000000-0000-4000-8000-000000000001';
    const plain = balanceCacheSecret(key, id);
    const withClient = balanceCacheSecret(key, id, 'client-value');
    expect(plain).toBe('a5SWOO64_3BYLzIBeCx9pixBcSuFlGdaFXB7xIptKKo');
    expect(withClient).toBe('Mi-VEB3_Bw2JD3FpzWz2gWuSGlpg80mTXUsh1evYNok');
    for (const s of [plain, withClient]) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('is deterministic for one balance, and 43 base64url characters', () => {
    const a = balanceCacheSecret(key, 'acct_1');
    expect(balanceCacheSecret(deriveSeedKey(seed, CACHE_SECRET_INFO), 'acct_1')).toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('differs between balances, and between client values within one balance', () => {
    const ids = Array.from({ length: 200 }, (_, i) => `acct_${i}`);
    expect(new Set(ids.map((id) => balanceCacheSecret(key, id))).size).toBe(ids.length);
    const a = balanceCacheSecret(key, 'acct_1');
    const withClient = balanceCacheSecret(key, 'acct_1', 'mine');
    expect(withClient).not.toBe(a);
    expect(balanceCacheSecret(key, 'acct_1', 'mine')).toBe(withClient);
    expect(balanceCacheSecret(key, 'acct_1', 'other')).not.toBe(withClient);
    // The same client value under two balances gives two secrets.
    expect(balanceCacheSecret(key, 'acct_2', 'mine')).not.toBe(withClient);
  });

  it('frames its fields, so moving bytes between the id and the client value reaches no other secret', () => {
    expect(balanceCacheSecret(key, 'acct_1', '2')).not.toBe(balanceCacheSecret(key, 'acct_12'));
    expect(balanceCacheSecret(key, 'acct_1', '23')).not.toBe(balanceCacheSecret(key, 'acct_12', '3'));
    // The empty string is a value of its own here; clientCacheSecret (below) never passes one.
    expect(balanceCacheSecret(key, 'acct_1', '')).not.toBe(balanceCacheSecret(key, 'acct_1'));
  });

  it('differs per label and per seed', () => {
    const other = deriveSeedKey(seed, CACHE_SECRET_INFO + '-other');
    expect(other.equals(key)).toBe(false);
    expect(balanceCacheSecret(other, 'acct_1')).not.toBe(balanceCacheSecret(key, 'acct_1'));
    const otherSeed = deriveSeedKey(Buffer.from('cd'.repeat(64), 'hex'), CACHE_SECRET_INFO);
    expect(balanceCacheSecret(otherSeed, 'acct_1')).not.toBe(balanceCacheSecret(key, 'acct_1'));
    expect(key).toHaveLength(32);
  });

  it('is equal to none of its inputs, and no input appears in it', () => {
    const id = 'acct_' + randomBytes(8).toString('hex');
    const s = balanceCacheSecret(key, id, 'client-value');
    for (const input of [id, 'client-value', seed.toString('hex'), seed.toString('base64url'), key.toString('hex'), key.toString('base64url')]) {
      expect(s).not.toBe(input);
      expect(s.includes(input)).toBe(false);
    }
    // Nor is it a plain hash or an HMAC under the seed itself: the key is the HKDF output.
    expect(s).not.toBe(createHmac('sha256', seed).update(id).digest('base64url'));
    expect(key.equals(seed.subarray(0, 32))).toBe(false);
  });

  it('a fresh secret is new every time', () => {
    const many = new Set(Array.from({ length: 100 }, freshCacheSecret));
    expect(many.size).toBe(100);
    for (const s of many) expect(s).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("reads the client's value as Tinfoil does: a non-empty string, else none", () => {
    expect(clientCacheSecret('x')).toBe('x');
    for (const v of ['', undefined, null, 0, 1, {}, [], true]) expect(clientCacheSecret(v)).toBeUndefined();
  });

  it('the wallet derives the key from its seed, the same after the database is reopened', () => {
    const db = openDb(':memory:');
    const opts = { trustedMints: ['http://127.0.0.1:1'], units: ['usd' as const], maxTokenBytes: 64_000 };
    const w = new GatewayWallet(db, opts);
    const k = w.deriveKey(CACHE_SECRET_INFO);
    // A second wallet on the same database reads the stored seed back.
    expect(new GatewayWallet(db, opts).deriveKey(CACHE_SECRET_INFO).equals(k)).toBe(true);
    expect(w.deriveKey('another label').equals(k)).toBe(false);
    // A seed given in FORGE_WALLET_SEED is used as given.
    expect(new GatewayWallet(openDb(':memory:'), { ...opts, seed }).deriveKey(CACHE_SECRET_INFO).equals(key)).toBe(true);
  });
});
