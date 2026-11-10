import { describe, expect, it } from 'vitest';
import { parseContact } from '../../src/beta.ts';

describe('beta waitlist contact', () => {
  it('accepts an email and lowercases it', () => {
    expect(parseContact(' Ana@Example.org ')).toEqual({ contact: 'ana@example.org', kind: 'email' });
  });
  it('accepts a valid npub', () => {
    const npub = 'npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63m';
    expect(parseContact(npub)).toEqual({ contact: npub, kind: 'npub' });
  });
  it('rejects junk and broken npubs', () => {
    expect(parseContact('')).toBeNull();
    expect(parseContact('not an email')).toBeNull();
    expect(parseContact('npub1sg6plzptd64u62a878hep2kev88swjh3tw00gjsfl8f237lmu63q0uf63n')).toBeNull();
    expect(parseContact('a@b')).toBeNull();
    expect(parseContact('x'.repeat(250) + '@example.org')).toBeNull();
  });
});
