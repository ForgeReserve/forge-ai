import { afterEach, describe, expect, it } from 'vitest';
import { EnvSchema, normalizeMintUrl, setMintAliases } from '../../src/config.ts';

const DEFAULT = EnvSchema.parse({}).FORGE_MINT_ALIASES;
afterEach(() => setMintAliases(DEFAULT));

describe('mint aliases', () => {
  it('folds the second Forge address onto the main one by default', () => {
    setMintAliases(DEFAULT);
    expect(normalizeMintUrl('https://mint.forge-reserve.com/')).toBe('https://forge.flashapp.me');
    expect(normalizeMintUrl(' https://mint.forge-reserve.com ')).toBe('https://forge.flashapp.me');
    expect(normalizeMintUrl('https://forge.flashapp.me/')).toBe('https://forge.flashapp.me');
  });

  it('leaves other mints alone', () => {
    setMintAliases(DEFAULT);
    expect(normalizeMintUrl('https://mint.minibits.cash/Bitcoin/')).toBe('https://mint.minibits.cash/Bitcoin');
  });

  it('can be emptied', () => {
    setMintAliases([]);
    expect(normalizeMintUrl('https://mint.forge-reserve.com')).toBe('https://mint.forge-reserve.com');
  });

  it('rejects an entry without a main address', () => {
    expect(() => setMintAliases(['https://a.example'])).toThrow(/alias=main/);
  });
});
