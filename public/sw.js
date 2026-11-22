// Forge AI service worker, for the Classic chat page at /classic/. The gateway serves this file at
// /sw.js with the three placeholders below filled in (src/sw.ts): a hash of the app shell, a hash of
// public/vendor, and the shell file list. A deploy that changes any shell file changes the hash, so the
// browser installs a new worker. Its scope stays / (the page's scripts and styles live at the root).
//
// - The shell (the page at /classic/, scripts, styles, icons, manifest) is precached as one set per
//   version and served cache first from that set, so a page never pairs new HTML with old JS. A new
//   version waits until the page confirms ("Update available", Reload) or until the next launch.
// - The front page (/) is the landing page and always comes from the network. Workers before
//   /classic/ kept the Classic page at / and answered / from their cache. A worker that replaces one of
//   them takes over as soon as it is installed, without waiting for the person (the open Classic page
//   reloads on the change, so it lands on the landing page, or on /classic/ for a chat's link), and
//   deletes their caches on activate, so / is never answered from a cache again.
// - The site's other pages, /download and /privacy, are not in the shell either: a visit to one goes to
//   the network, with the offline page when there is none.
// - Vendor files are cache first in their own cache, versioned by the vendor hash.
// - API calls, the admin and beta pages, POST requests and anything carrying Authorization or X-Cashu
//   are never cached or intercepted: they go straight to the network.
// - The v2 app under /v2/ has its own worker and scope; this one leaves it alone.
const VERSION = '__FORGE_SW_VERSION__';
const VENDOR_VERSION = '__FORGE_VENDOR_VERSION__';
const SHELL = __FORGE_SW_SHELL__;
const VENDOR_BOOT = ['/vendor/marked.js', '/vendor/purify.js'];
const SHELL_CACHE = `forge-shell-${VERSION}`;
const VENDOR_CACHE = `forge-vendor-${VENDOR_VERSION}`;
const OFFLINE = '/offline.html';
const CLASSIC = '/classic/';
const SHELL_SET = new Set(SHELL);
const BYPASS = /^\/(v1\/|v1$|v2\/|v2$|admin|beta|attestation|\.well-known\/|healthz|__dev|sw\.js$)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      // All or nothing: one failed file fails the install, and the old version keeps serving.
      const shell = await caches.open(SHELL_CACHE);
      await shell.addAll(SHELL.map((p) => new Request(p, { cache: 'no-cache' })));
      const vendor = await caches.open(VENDOR_CACHE);
      for (const p of VENDOR_BOOT) if (!(await vendor.match(p))) await vendor.add(new Request(p, { cache: 'no-cache' }));
      // Replacing a worker from before the move, which answers / with the Classic page: take over now,
      // without waiting for the person, so / is the landing page from the next load on.
      if (await keptClassicAtRoot()) await self.skipWaiting();
    })(),
  );
});

/** Whether an older worker's cache holds the Classic page at / (every worker before /classic/ kept it there). */
async function keptClassicAtRoot() {
  for (const k of await caches.keys()) if (k.startsWith('forge-shell-') && k !== SHELL_CACHE && (await (await caches.open(k)).match('/'))) return true;
  return false;
}

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('forge-') && k !== SHELL_CACHE && k !== VENDOR_CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('authorization') || req.headers.has('x-cashu')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || BYPASS.test(url.pathname)) return;
  const p = url.pathname;
  if (req.mode === 'navigate') {
    if (p === CLASSIC || p === '/classic/index.html') event.respondWith(fromShell(CLASSIC, true));
    else event.respondWith(fetch(req).catch(() => offline()));
    return;
  }
  if (SHELL_SET.has(p)) event.respondWith(fromShell(p, false));
  else if (p.startsWith('/vendor/')) event.respondWith(fromVendor(req));
});

async function fromShell(path, navigate) {
  const hit = await caches.match(path, { cacheName: SHELL_CACHE });
  if (hit) return hit;
  try {
    return await fetch(path, { cache: 'no-cache' });
  } catch (e) {
    if (navigate) return offline();
    throw e;
  }
}

async function offline() {
  return (await caches.match(OFFLINE, { cacheName: SHELL_CACHE })) ?? new Response("You're offline. Your chats are saved on this device.", { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

async function fromVendor(req) {
  const cache = await caches.open(VENDOR_CACHE);
  const hit = await cache.match(req, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok && res.type === 'basic') await cache.put(req, res.clone());
  return res;
}
