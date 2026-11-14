// Storage on this phone: IndexedDB database `forge2`, for settings, the conversation and what is
// attached to it. Nothing here is sent anywhere except the messages of a question the person sends.
// Falls back to memory when IndexedDB is unavailable (some private windows), so the page still works.
// Erasing everything is core/erase.js; shutdown() closes this page's connection first, and nothing is
// written to IndexedDB after it.

export const DB_NAME = 'forge2';
const STORES = ['kv', 'chats'];

let dbp = null;
let down = false;
let erasedElsewhere = () => {};

/**
 * fn runs when another tab deletes the database (Erase everything there). The app treats that as an
 * erase here too, so this tab does not open the database again and write its data back.
 */
export function onErasedElsewhere(fn) {
  erasedElsewhere = fn;
}
const memory = { kv: new Map(), chats: new Map() };

function open() {
  if (down) return Promise.resolve(null);
  dbp ??= new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      for (const s of STORES) if (!req.result.objectStoreNames.contains(s)) req.result.createObjectStore(s);
    };
    req.onsuccess = () => {
      // Another tab is deleting the database (Erase everything there): let go, so it is not blocked,
      // and tell the app, which stops writing (a write would open the database again and re-create it).
      // A delete has no new version; an upgrade by a newer copy of the app is not an erase.
      req.result.onversionchange = (e) => {
        req.result.close();
        dbp = null;
        if (e?.newVersion == null) erasedElsewhere();
      };
      resolve(req.result);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function run(store, mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) {
          resolve(down ? (mode === 'readonly' ? fn(null, new Map()) : undefined) : fn(null, memory[store]));
          return;
        }
        const t = db.transaction(store, mode);
        const r = fn(t.objectStore(store), null);
        t.oncomplete = () => resolve(typeof IDBRequest !== 'undefined' && r instanceof IDBRequest ? r.result : r);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

const clone = (v) => (v === undefined ? undefined : structuredClone(v));

function table(store) {
  return {
    get: (k) => run(store, 'readonly', (s, m) => (s ? s.get(k) : clone(m.get(k)))),
    put: (k, v) => run(store, 'readwrite', (s, m) => (s ? s.put(clone(v), k) : m.set(k, clone(v)))),
    del: (k) => run(store, 'readwrite', (s, m) => (s ? s.delete(k) : m.delete(k))),
    /** Every value in the store. */
    all: () => run(store, 'readonly', (s, m) => (s ? s.getAll() : [...m.values()].map(clone))),
    /** Removes every value in the store. */
    clear: () => run(store, 'readwrite', (s, m) => (s ? s.clear() : m.clear())),
  };
}

/**
 * Closes this page's connection and stops all reads and writes (Erase everything). Afterwards reads find
 * nothing and writes go nowhere, so a late write cannot bring anything back.
 */
export async function shutdown() {
  down = true;
  const db = await (dbp ?? Promise.resolve(null));
  dbp = null;
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  memory.kv.clear();
  memory.chats.clear();
}

export const kv = table('kv');
export const chats = table('chats');
