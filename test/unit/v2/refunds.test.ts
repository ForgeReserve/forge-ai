import { describe, expect, it } from 'vitest';

// Which issued refunds the phone offers (public/v2/core/refunds.js).
const R: any = await import('../../../public/v2/core/refunds.js' as string);

const done = (id: string) => ({ id, status: 'done', token: `cashuB${id}`, amount: 100, unit: 'usd' });

describe('refunds to offer', () => {
  it('the first time a balance is seen here, takes issued refunds as shown (v1 showed them)', () => {
    const r = R.refundsToOffer({ list: [done('r1')], shownBefore: undefined });
    expect(r.keep).toEqual([]);
    expect(r.shown).toEqual(['r1']);
  });

  it('offers a refund issued later once, after it was seen', () => {
    const r = R.refundsToOffer({ list: [done('r1'), done('r2')], shownBefore: ['r1'] });
    expect(r.keep.map((x: any) => x.id)).toEqual(['r2']);
    expect(R.refundsToOffer({ list: [done('r1'), done('r2')], shownBefore: r.shown }).keep).toEqual([]);
  });

  it('never skips a 202 refund, even when the first refunds list failed', () => {
    // Take funds out answered 202 (no token) and the id was recorded as awaited. The refunds list was
    // never read on this phone, so nothing was stored as shown.
    const awaited = ['r9'];
    // Still owed: nothing to offer, still awaited.
    let r = R.refundsToOffer({ list: [{ id: 'r9', status: 'owed', token: null }], shownBefore: undefined, awaited });
    expect(r.keep).toEqual([]);
    expect(r.awaited).toEqual(['r9']);
    // Issued: offered, though shownBefore is undefined, and no longer awaited.
    r = R.refundsToOffer({ list: [done('r9'), done('old')], shownBefore: undefined, awaited: r.awaited });
    expect(r.keep.map((x: any) => x.id)).toEqual(['r9']);
    expect(r.awaited).toEqual([]);
    expect(r.shown.sort()).toEqual(['old', 'r9']);
    // Offered once only.
    expect(R.refundsToOffer({ list: [done('r9')], shownBefore: r.shown, awaited: r.awaited }).keep).toEqual([]);
  });

  it('offers an awaited refund even if its id was already marked shown', () => {
    const r = R.refundsToOffer({ list: [done('r3')], shownBefore: ['r3'], awaited: ['r3'] });
    expect(r.keep.map((x: any) => x.id)).toEqual(['r3']);
  });

  it('does not offer again what the vault already keeps', () => {
    const r = R.refundsToOffer({ list: [done('r4')], shownBefore: [], awaited: ['r4'], outgoing: ['r4'] });
    expect(r.keep).toEqual([]);
    expect(r.awaited).toEqual([]);
    expect(r.shown).toContain('r4');
  });
});
