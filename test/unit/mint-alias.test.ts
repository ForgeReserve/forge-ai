import { afterEach, describe, expect, it } from 'vitest';
import { EnvSchema, mintAliasList, normalizeMintUrl, setMintAliases } from '../../src/config.ts';

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

  it('lists the aliases of the mints the engine takes, for /v1/models', () => {
    setMintAliases(DEFAULT);
    // Out of the box the engine takes the Forge mint, so its second address is listed.
    expect(mintAliasList(EnvSchema.parse({}).FORGE_TRUSTED_MINTS)).toEqual(['https://mint.forge-reserve.com']);
    expect(mintAliasList(['https://forge.flashapp.me/'])).toEqual(['https://mint.forge-reserve.com']);
    expect(mintAliasList()).toEqual(['https://mint.forge-reserve.com']);
    // An alias of a mint the engine does not take is not listed: the engine would refuse its notes.
    expect(mintAliasList(['http://127.0.0.1:3338'])).toEqual([]);
    setMintAliases([]);
    expect(mintAliasList(['https://forge.flashapp.me'])).toEqual([]);
  });

  it('rejects an entry without a main address', () => {
    expect(() => setMintAliases(['https://a.example'])).toThrow(/alias=main/);
  });
});
