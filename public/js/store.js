// Conversation history in IndexedDB, in this browser only. Nothing here is ever sent to the gateway
// except the messages of the chat being continued. Falls back to memory when IndexedDB is unavailable
// (some private windows), so the page still works for the session.

const DB_NAME = 'forge-chat';
const STORE = 'conversations';
let dbp = null;
const memory = new Map();

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
      const s = req.result.createObjectStore(STORE, { keyPath: 'id' });
      s.createIndex('updatedAt', 'updatedAt');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbp;
}

function run(mode, fn) {
  return open().then(
    (db) =>
      new Promise((resolve, reject) => {
        if (!db) {
          resolve(fn(null));
          return;
        }
        const t = db.transaction(STORE, mode);
        const r = fn(t.objectStore(STORE));
        t.oncomplete = () => resolve(r?.result ?? r);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const chats = {
  async all() {
    const rows = await run('readonly', (s) => (s ? s.getAll() : [...memory.values()]));
    return (rows ?? []).sort((a, b) => b.updatedAt - a.updatedAt);
  },
  get: (id) => run('readonly', (s) => (s ? s.get(id) : memory.get(id))),
  put: (c) => run('readwrite', (s) => (s ? s.put(structuredClone(c)) : memory.set(c.id, structuredClone(c)))),
  del: (id) => run('readwrite', (s) => (s ? s.delete(id) : memory.delete(id))),
  clear: () => run('readwrite', (s) => (s ? s.clear() : memory.clear())),
};

export function newId(prefix = 'c') {
  return prefix + '_' + (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36)).replaceAll('-', '').slice(0, 20);
}
