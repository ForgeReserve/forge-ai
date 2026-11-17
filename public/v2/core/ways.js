// The order of the wallet cards on Add money (screens/wallet.js). Pure, tested in Node.
//
// Scan a note, Lightning, the two card ways (Tap a Cashu card, Tap a Fedimint card) and eCash have a card
// of their own. When the engine allows both card ways they share one card, 'cards', with the two printed
// cards side by side, so each is as plain as the other and the icon row still fits a 360 px phone with
// 48 px tabs. Any other way the engine allows (another mint, on-chain, free questions, a module added
// later) waits on the More card, unless it is the way used last on this phone: that one gets a card of its
// own, first.
// Start free comes before everything while it is wanted (free models, and a $0 balance). Ways the engine
// turns off are not passed in, so they get no card at all.

/** The ways with a card of their own, in their usual order. */
export const MAIN_WAYS = Object.freeze(['note', 'lightning', 'card', 'fedimint', 'ecash']);

/** The two card ways, which share the card 'cards' when both are there. */
export const CARD_WAYS = Object.freeze(['card', 'fedimint']);

/** The card a way is shown on, among these cards: 'cards' for a card way that shares it. */
export const cardOf = (id, cards) => (CARD_WAYS.includes(id) && cards.includes('cards') ? 'cards' : id);

/**
 * ids: the fund modules the engine allows, in the registry's order (the invite module left out: Start
 * free is its card). start: Start free is wanted. last: the way used last on this phone, or ''.
 * Returns {cards, more}: the card ids in order ('start' for Start free, 'cards' for the two card ways
 * together, 'more' for the More card, last) and the ways on the More card.
 */
export function orderWays({ ids, start = false, last = '' }) {
  let cards = MAIN_WAYS.filter((id) => ids.includes(id));
  let more = ids.filter((id) => !MAIN_WAYS.includes(id));
  if (CARD_WAYS.every((id) => cards.includes(id))) {
    cards = cards.filter((id) => id !== CARD_WAYS[1]).map((id) => (id === CARD_WAYS[0] ? 'cards' : id));
    last = cardOf(last, cards);
  }
  if (last && more.includes(last)) {
    more = more.filter((id) => id !== last);
    cards = [last, ...cards];
  } else if (last && cards.includes(last)) cards = [last, ...cards.filter((id) => id !== last)];
  if (start) cards = ['start', ...cards];
  if (more.length) cards = [...cards, 'more'];
  return { cards, more };
}
