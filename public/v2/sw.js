// Forge AI v2 service worker, scope /v2/ (it lives in /v2/, so it cannot control v1 pages at /).
// Network first: when online the page always gets the files the gateway serves now, and each copy is
// kept so the app still opens offline. The engine API, POST requests and anything carrying a balance
// key or eCash are never cached or touched. The cache name does not start with "forge-", which v1's
// worker treats as its own and clears.
const CACHE = 'forge2-runtime-v1';
const SHELL = ['/v2/', '/v2/app.js', '/v2/style.css', '/v2/manifest.webmanifest'];
const MINE = /^\/(v2\/|js\/|vendor\/|icons\/|icon\.svg$)/;
const NEVER = /^\/(v1\/|v1$|admin|beta|attestation|\.well-known\/|healthz|__dev)/;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const c = await caches.open(CACHE);
      await c.addAll(SHELL.map((p) => new Request(p, { cache: 'no-cache' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k.startsWith('forge2-') && k !== CACHE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('authorization') || req.headers.has('x-cashu')) return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || NEVER.test(url.pathname)) return;
  if (req.mode === 'navigate') {
    if (url.pathname.startsWith('/v2/')) event.respondWith(networkFirst(req, '/v2/'));
    return;
  }
  if (MINE.test(url.pathname)) event.respondWith(networkFirst(req));
});

// Only install creates the cache. Once it is gone (Erase everything deleted it), nothing is put back, even
// by a worker that still runs for the page that erased it.
async function networkFirst(req, fallback) {
  try {
    const res = await fetch(req);
    if (res.ok && res.type === 'basic' && (await caches.has(CACHE))) await (await caches.open(CACHE)).put(fallback ?? req, res.clone());
    return res;
  } catch (e) {
    const opts = { cacheName: CACHE };
    const hit = (await caches.match(fallback ?? req, { ...opts, ignoreSearch: true })) ?? (fallback ? await caches.match(fallback, opts) : undefined);
    if (hit) return hit;
    throw e;
  }
}
