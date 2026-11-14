// Which refunds the engine issued should this phone offer? Pure, tested in Node.
//
// A refund the engine could not issue at once answers 202 and is issued later; the app collects it from
// GET /v1/wallet/refunds. The first time a balance is seen on this phone, refunds already issued (in v1,
// say) are taken as shown, not offered again. A refund this phone asked for and got a 202 for is
// "awaited": it is always offered once it is done, whatever was seen before, so it is never skipped.

/**
 * list: the engine's refunds. shownBefore: ids already shown here, or undefined the first time this
 * balance is seen here. awaited: ids of refunds this phone was told to collect later. outgoing: ids
 * already kept in the vault. Returns {keep, shown, awaited}: the refunds to keep in the vault now, and
 * the new shown and awaited lists to store.
 */
export function refundsToOffer({ list, shownBefore, awaited = [], outgoing = [] }) {
  const shown = new Set(shownBefore ?? []);
  const wait = new Set(awaited);
  const kept = new Set(outgoing);
  const keep = [];
  for (const r of list ?? []) {
    if (r?.status !== 'done' || !r.token) continue;
    if (wait.has(r.id)) {
      wait.delete(r.id);
      shown.add(r.id);
      if (!kept.has(r.id)) keep.push(r);
      continue;
    }
    if (shown.has(r.id)) continue;
    shown.add(r.id);
    if (shownBefore === undefined && !kept.has(r.id)) continue;
    keep.push(r);
  }
  for (const id of kept) shown.add(id);
  return { keep, shown: [...shown], awaited: [...wait] };
}
