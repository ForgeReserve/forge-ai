import { describe, expect, it } from 'vitest';

// The order of the wallet cards on Add money (public/v2/core/ways.js).
const WAYS: any = await import('../../../public/v2/core/ways.js' as string);
const ALL = ['free', 'note', 'card', 'fedimint', 'ecash', 'lightning', 'onchain', 'othermint'];

describe('the wallet cards', () => {
  it('give four ways a card each, in their usual order, and put the rest on More', () => {
    expect(WAYS.orderWays({ ids: ALL })).toEqual({ cards: ['note', 'lightning', 'card', 'ecash', 'more'], more: ['free', 'fedimint', 'onchain', 'othermint'] });
  });

  it('leave out the ways the engine turns off, and More when nothing is left for it', () => {
    expect(WAYS.orderWays({ ids: ['note', 'card', 'ecash'] })).toEqual({ cards: ['note', 'card', 'ecash'], more: [] });
  });

  it('put the way used last first', () => {
    expect(WAYS.orderWays({ ids: ALL, last: 'ecash' }).cards).toEqual(['ecash', 'note', 'lightning', 'card', 'more']);
  });

  it('give a way from More that was used last a card of its own, first', () => {
    expect(WAYS.orderWays({ ids: ALL, last: 'othermint' })).toEqual({ cards: ['othermint', 'note', 'lightning', 'card', 'ecash', 'more'], more: ['free', 'fedimint', 'onchain'] });
  });

  it('put Start free before everything while it is wanted, even before the way used last', () => {
    expect(WAYS.orderWays({ ids: ALL, start: true, last: 'lightning' }).cards).toEqual(['start', 'lightning', 'note', 'card', 'ecash', 'more']);
  });

  it('ignore a way used last that the engine no longer allows', () => {
    expect(WAYS.orderWays({ ids: ['note', 'ecash'], last: 'lightning' }).cards).toEqual(['note', 'ecash']);
  });
});
