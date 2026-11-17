import { describe, expect, it } from 'vitest';

// The order of the wallet cards on Add money (public/v2/core/ways.js).
const WAYS: any = await import('../../../public/v2/core/ways.js' as string);
const ALL = ['free', 'note', 'card', 'fedimint', 'ecash', 'lightning', 'onchain', 'othermint'];

describe('the wallet cards', () => {
  it('give the main ways a card each, in their usual order, the two card ways one card, and put the rest on More', () => {
    expect(WAYS.orderWays({ ids: ALL })).toEqual({ cards: ['note', 'lightning', 'cards', 'ecash', 'more'], more: ['free', 'onchain', 'othermint'] });
  });

  it('leave out the ways the engine turns off, and More when nothing is left for it', () => {
    expect(WAYS.orderWays({ ids: ['note', 'card', 'ecash'] })).toEqual({ cards: ['note', 'card', 'ecash'], more: [] });
  });

  it('put the way used last first', () => {
    expect(WAYS.orderWays({ ids: ALL, last: 'ecash' }).cards).toEqual(['ecash', 'note', 'lightning', 'cards', 'more']);
  });

  it('give a way from More that was used last a card of its own, first', () => {
    expect(WAYS.orderWays({ ids: ALL, last: 'othermint' })).toEqual({ cards: ['othermint', 'note', 'lightning', 'cards', 'ecash', 'more'], more: ['free', 'onchain'] });
  });

  it('put Start free before everything while it is wanted, even before the way used last', () => {
    expect(WAYS.orderWays({ ids: ALL, start: true, last: 'lightning' }).cards).toEqual(['start', 'lightning', 'note', 'cards', 'ecash', 'more']);
  });

  it('ignore a way used last that the engine no longer allows', () => {
    expect(WAYS.orderWays({ ids: ['note', 'ecash'], last: 'lightning' }).cards).toEqual(['note', 'ecash']);
  });

  // The two card ways are equally plain (owner, 2026-11-17). Both there: one card, 'cards', with the
  // printed Cashu card and Fedimint card side by side (a tile on More was the Fedimint card's place). One
  // alone: its own card. Either used last puts the shared card first.
  it('put the Cashu card and the Fedimint card on one card when both are there, each on its own card when alone', () => {
    expect(WAYS.orderWays({ ids: ['card', 'fedimint', 'onchain'] })).toEqual({ cards: ['cards', 'more'], more: ['onchain'] });
    expect(WAYS.orderWays({ ids: ['note', 'card'] }).cards).toEqual(['note', 'card']);
    expect(WAYS.orderWays({ ids: ['note', 'fedimint'] }).cards).toEqual(['note', 'fedimint']);
    expect(WAYS.orderWays({ ids: ALL, last: 'fedimint' }).cards).toEqual(['cards', 'note', 'lightning', 'ecash', 'more']);
    expect(WAYS.orderWays({ ids: ['note', 'fedimint'], last: 'fedimint' }).cards).toEqual(['fedimint', 'note']);
    expect(WAYS.cardOf('card', ['note', 'cards'])).toBe('cards');
    expect(WAYS.cardOf('card', ['note', 'card'])).toBe('card');
  });
});
