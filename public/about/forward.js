// The Classic chat page was at / until the landing page took its place, and it is now at /classic/.
// What was meant for it still arrives here: a chat's link (#/c/<id>), its shortcuts (#new, #fund),
// and the Classic app put on a home screen before the move, which opens standalone at /. Each goes on
// to the Classic page, with its hash.

/** Where an address of the landing page goes instead, or null to stay. */
export function classicAddress(hash, standalone) {
  const route = /^#\/c\/./.test(hash) || hash === '#new' || hash === '#fund';
  if (route) return '/classic/' + hash;
  if (standalone) return '/classic/';
  return null;
}
