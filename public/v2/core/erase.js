// Erase everything: every trace of Forge this browser keeps for this site, v2 and the Classic app
// alike, since they share the site's storage and the balance key. That is localStorage (the balance key,
// the eCash vault, settings), sessionStorage, every IndexedDB database (conversations, what was added
// to them, settings), every Cache Storage cache (the offline copy) and every service worker.
//
// The browser's own storage is passed in, so this runs against fakes in Node and against the real thing
// in the page. After erasing it looks again and returns what is left, so the screen never says
// "erased" when something stayed (another open tab can keep a database from being deleted).

/** Databases deleted even when the browser cannot list them (indexedDB.databases() is missing). */
export const KNOWN_DATABASES = Object.freeze(['forge2', 'forge-chat']);

/** Deletes one database. Resolves 'deleted', 'blocked' (still open elsewhere after waitMs) or 'failed'. */
function deleteDatabase(idb, name, waitMs) {
  return new Promise((resolve) => {
    let req;
    try {
      req = idb.deleteDatabase(name);
    } catch {
      resolve('failed');
      return;
    }
    let timer = null;
    const done = (r) => {
      if (timer) clearTimeout(timer);
      resolve(r);
    };
    req.onsuccess = () => done('deleted');
    req.onerror = () => done('failed');
    // Blocked: another tab still has it open. The delete goes on once that tab lets go, so wait a while.
    req.onblocked = () => (timer ??= setTimeout(() => resolve('blocked'), waitMs));
  });
}

/** What is still stored. Empty lists and zero counts mean nothing is left. */
export async function leftovers(env) {
  const out = { localStorage: 0, sessionStorage: 0, databases: [], caches: [], workers: 0 };
  try {
    out.localStorage = env.localStorage?.length ?? 0;
  } catch {
    /* blocked storage holds nothing */
  }
  try {
    out.sessionStorage = env.sessionStorage?.length ?? 0;
  } catch {
    /* blocked storage holds nothing */
  }
  try {
    if (env.indexedDB?.databases) out.databases = (await env.indexedDB.databases()).map((d) => d.name).filter(Boolean);
  } catch {
    /* cannot list */
  }
  try {
    if (env.caches) out.caches = await env.caches.keys();
  } catch {
    /* no Cache Storage */
  }
  try {
    if (env.serviceWorker?.getRegistrations) out.workers = (await env.serviceWorker.getRegistrations()).length;
  } catch {
    /* no service workers */
  }
  return out;
}

export const isEmpty = (l) => !l.localStorage && !l.sessionStorage && !l.databases.length && !l.caches.length && !l.workers;

/**
 * Erases everything. closeOwn() closes this page's own database connection first, so its delete is not
 * blocked. Returns {ok, left, blocked}: ok is true only when the check afterwards found nothing.
 */
export async function eraseEverything(env, { closeOwn = async () => {}, waitMs = 3000 } = {}) {
  await closeOwn();
  // The balance key and the eCash vault first: they matter most.
  for (const s of [env.localStorage, env.sessionStorage]) {
    try {
      s?.clear();
    } catch {
      /* reported by the check below */
    }
  }
  try {
    if (env.caches) for (const k of await env.caches.keys()) await env.caches.delete(k);
  } catch {
    /* reported below */
  }
  const names = new Set(KNOWN_DATABASES);
  try {
    if (env.indexedDB?.databases) for (const d of await env.indexedDB.databases()) if (d.name) names.add(d.name);
  } catch {
    /* the known names are still deleted */
  }
  const blocked = [];
  if (env.indexedDB) for (const n of names) if ((await deleteDatabase(env.indexedDB, n, waitMs)) !== 'deleted') blocked.push(n);
  try {
    if (env.serviceWorker?.getRegistrations) for (const r of await env.serviceWorker.getRegistrations()) await r.unregister();
  } catch {
    /* reported below */
  }
  const left = await leftovers(env);
  // A database that could not be listed but was blocked is still there.
  const ok = isEmpty(left) && !blocked.length;
  return { ok, left, blocked };
}
