// A new deploy shows without asking anyone to reload (owner, 2026-11-15: an iPhone showed the old app
// from a restored tab). The v2 worker's script carries a build id (src/sw.ts), so each deploy installs
// a new worker, which takes over at once (skipWaiting and clients.claim, public/v2/sw.js). When it
// takes over a page an older worker served, the page reloads once to pick up the new files, unless the
// person is in the middle of something; then it reloads at the next screen change. Pure rules, tested
// in Node; app.js wires them to the worker and the screens.

/** The session key that keeps a reload from ever looping. */
export const RELOAD_KEY = 'forge2.updateReload';
/** Within this time of the last update reload, another is never made (a loop cannot form). */
export const RELOAD_GAP_MS = 60 * 60 * 1000;

/**
 * storage: sessionStorage (or a stand-in), with getItem and setItem; it may throw.
 * hadController: the page was served under a worker when it loaded. The first worker taking over a
 * page that had none is not an update, so it never reloads; a later one is.
 * busy(): the person is mid-way: Listen playing, typed words not sent, a recording, an answer being
 * read aloud or streaming. reload(): reloads the page. now(): the clock.
 * Returns {controllerChanged(), screenChanged() -> true when it reloaded, pending()}.
 */
export function createUpdater({ storage, hadController, busy, reload, now = () => Date.now() }) {
  let pending = false;
  let controlled = !!hadController;
  const recent = () => {
    try {
      const at = Number(storage?.getItem(RELOAD_KEY));
      return Number.isFinite(at) && at > 0 && now() - at < RELOAD_GAP_MS;
    } catch {
      return true; // no storage: no way to guard against a loop, so no automatic reload
    }
  };
  const go = () => {
    if (recent()) return (pending = false);
    try {
      storage.setItem(RELOAD_KEY, String(now()));
    } catch {
      return (pending = false);
    }
    pending = false;
    reload();
    return true;
  };
  return {
    controllerChanged() {
      // The first worker claiming a page that had none: nothing old to replace.
      if (!controlled) return ((controlled = true), false);
      if (recent()) return false;
      pending = true;
      return busy() ? false : go();
    },
    screenChanged() {
      if (!pending || busy()) return false;
      return go();
    },
    pending: () => pending,
  };
}
