// The order of the wallet cards on Add money (screens/wallet.js). Pure, tested in Node.
//
// Four ways have a card of their own: Scan a note, Lightning, Tap a card and eCash. Any other way the
// engine allows (another mint, on-chain, free questions, a Fedimint card, a module added later) waits on
// the More card, unless it is the way used last on this phone: that one gets a card of its own, first.
// Start free comes before everything while it is wanted (free models, and a $0 balance). Ways the engine
// turns off are not passed in, so they get no card at all.

/** The ways with a card of their own, in their usual order. */
export const MAIN_WAYS = Object.freeze(['note', 'lightning', 'card', 'ecash']);

/**
 * ids: the fund modules the engine allows, in the registry's order (the invite module left out: Start
 * free is its card). start: Start free is wanted. last: the way used last on this phone, or ''.
 * Returns {cards, more}: the card ids in order ('start' for Start free, 'more' for the More card, last)
 * and the ways on the More card.
 */
export function orderWays({ ids, start = false, last = '' }) {
  let cards = MAIN_WAYS.filter((id) => ids.includes(id));
  let more = ids.filter((id) => !MAIN_WAYS.includes(id));
  if (last && more.includes(last)) {
    more = more.filter((id) => id !== last);
    cards = [last, ...cards];
  } else if (last && cards.includes(last)) cards = [last, ...cards.filter((id) => id !== last)];
  if (start) cards = ['start', ...cards];
  if (more.length) cards = [...cards, 'more'];
  return { cards, more };
}
