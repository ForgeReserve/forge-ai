// A new deploy shows without asking anyone to reload (owner, 2026-11-15: an iPhone showed the old app
// from a restored tab). The v2 worker's script carries a build id (src/sw.ts), so each deploy installs
// a new worker, which takes over at once (skipWaiting and clients.claim, public/v2/sw.js). When it
// takes over a page an older worker served, the page reloads once to pick up the new files, unless the
// person is in the middle of something; then it reloads at the next screen change. A tab reloads once for
// each new build, and never twice for the same one within the hour. Pure rules, tested
// in Node; app.js wires them to the worker and the screens.

/** The session key that keeps a reload from ever looping: the builds this tab reloaded for, and when. */
export const RELOAD_KEY = 'forge2.updateReload';
/** Within this time of an update reload for a build, another for the same build is never made (a loop cannot form). */
export const RELOAD_GAP_MS = 60 * 60 * 1000;
/** However many builds arrive, a tab makes at most this many update reloads within that time. */
export const RELOAD_MAX = 6;
/** A reload made when the new worker did not say its build is kept under this name, and guards every build. */
const UNKNOWN = '?';

/**
 * storage: sessionStorage (or a stand-in), with getItem and setItem; it may throw.
 * hadController: the page was served under a worker when it loaded. The first worker taking over a
 * page that had none is not an update, so it never reloads; a later one is.
 * busy(): the person is mid-way: Listen playing, typed words not sent, a recording, an answer being
 * read aloud or streaming. reload(): reloads the page. now(): the clock.
 * Returns {controllerChanged(build), screenChanged() -> true when it reloaded, pending()}. build is the
 * new worker's build id (public/v2/sw.js VERSION): the tab reloads once for each new build, however
 * soon one deploy follows another (owner, 2026-11-21: two deploys within the hour left an open tab on
 * the first), never twice within the hour for the same one, and at most RELOAD_MAX times an hour. Without a build id the old rule
 * holds: one reload an hour.
 */
export function createUpdater({ storage, hadController, busy, reload, now = () => Date.now() }) {
  let pending = false;
  let wanted = UNKNOWN;
  let controlled = !!hadController;
  // The builds this tab reloaded for, as {build: time}. A value an older build left (a bare time) counts
  // as a reload for a build nobody named.
  const made = () => {
    const raw = storage.getItem(RELOAD_KEY);
    if (!raw) return {};
    const at = Number(raw);
    if (Number.isFinite(at)) return { [UNKNOWN]: at };
    const o = JSON.parse(raw);
    return o && typeof o === 'object' ? o : {};
  };
  const fresh = (at) => Number.isFinite(at) && at > 0 && now() - at < RELOAD_GAP_MS;
  const recent = (build) => {
    try {
      const m = made();
      const times = Object.values(m).filter(fresh);
      if (times.length >= RELOAD_MAX) return true;
      return build === UNKNOWN ? times.length > 0 : fresh(m[build]);
    } catch {
      return true; // no storage: no way to guard against a loop, so no automatic reload
    }
  };
  const go = () => {
    if (recent(wanted)) return (pending = false);
    try {
      const kept = Object.fromEntries(Object.entries(made()).filter(([, at]) => fresh(at)));
      storage.setItem(RELOAD_KEY, JSON.stringify({ ...kept, [wanted]: now() }));
    } catch {
      return (pending = false);
    }
    pending = false;
    reload();
    return true;
  };
  return {
    controllerChanged(build) {
      // The first worker claiming a page that had none: nothing old to replace.
      if (!controlled) return ((controlled = true), false);
      const b = typeof build === 'string' && build ? build : UNKNOWN;
      if (recent(b)) return false;
      wanted = b;
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
