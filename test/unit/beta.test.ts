import { describe, expect, it } from 'vitest';
import { mailtoLink, parseContact } from '../../src/beta.ts';

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

  it('accepts ordinary addresses with dots, plus tags, hyphens and punycode domains', () => {
    expect(parseContact('first.last+forge@mail.example.co.uk')?.contact).toBe('first.last+forge@mail.example.co.uk');
    expect(parseContact('a_b-c@sub-domain.example.org')?.kind).toBe('email');
    expect(parseContact('ana@example.xn--p1ai')?.kind).toBe('email');
  });
  it('rejects anything a mailto URI would read as a delimiter, escape or header (finding 11)', () => {
    // The red-team input: a query after the domain that a mail client reads as a Bcc header.
    expect(parseContact('victim@example.com?bcc=thief%40evil.net&x=.org')).toBeNull();
    for (const bad of [
      'a?b@example.org',
      'a&b@example.org',
      'a#b@example.org',
      'a%40b@example.org',
      'a,b@example.org',
      'a;b@example.org',
      'a:b@example.org',
      'a/b@example.org',
      'a=b@example.org',
      "a'b@example.org",
      'a b@example.org',
      'a\tb@example.org',
      'a\nb@example.org',
      'a@b@example.org',
      '"quoted"@example.org',
      'ana@example.org#frag',
      'ana@example.org&cc=x@y.org',
      'ana@[127.0.0.1]',
      'ana@-example.org',
      'ana@example..org',
      '.ana@example.org',
      'ana.@example.org',
      'an..a@example.org',
      'ana@example.c0m',
      'x'.repeat(65) + '@example.org',
    ]) expect(parseContact(bad), bad).toBeNull();
  });
});

describe('waitlist mailto link', () => {
  it('builds a link whose only parameters are the subject and body', () => {
    const link = mailtoLink('first.last+forge@example.org', 'Your invite', 'Code inv-1 & more? #yes')!;
    const u = new URL(link);
    expect(u.protocol).toBe('mailto:');
    expect(decodeURIComponent(u.pathname)).toBe('first.last+forge@example.org');
    expect([...u.searchParams.keys()]).toEqual(['subject', 'body']);
    expect(u.searchParams.get('body')).toBe('Code inv-1 & more? #yes');
    expect(u.hash).toBe('');
  });
  it('refuses a stored contact that the strict rule would not accept (rows from the older rule)', () => {
    expect(mailtoLink('victim@example.com?bcc=thief%40evil.net&x=.org', 's', 'b')).toBeNull();
    expect(mailtoLink('Ana@Example.org', 's', 'b')).toBeNull();
    expect(mailtoLink('npub180cvv07tjdrrgpa0j7j7tmnyl2yr6yr7l8j4s3evf6u64th6gkwsyjh6w6', 's', 'b')).toBeNull();
  });
});
