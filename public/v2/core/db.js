// Storage on this phone: IndexedDB database `forge2`, for settings, the conversation and what is
// attached to it. Nothing here is sent anywhere except the messages of a question the person sends.
// Falls back to memory when IndexedDB is unavailable (some private windows), so the page still works.
// Erasing everything comes with slice A4.

export const DB_NAME = 'forge2';
const STORES = ['kv', 'chats'];

let dbp = null;
const memory = { kv: new Map(), chats: new Map() };

function open() {
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
    req.onsuccess = () => resolve(req.result);
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
          resolve(fn(null, memory[store]));
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
  };
}

export const kv = table('kv');
export const chats = table('chats');
