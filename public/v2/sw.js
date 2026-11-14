// Forge AI v2 service worker, scope /v2/ (it lives in /v2/, so it cannot control v1 pages at /).
// Network first: when online the page always gets the files the gateway serves now, and each copy is
// kept so the app still opens offline. The engine API, POST requests and anything carrying a balance
// key or eCash are never cached or touched. The cache name does not start with "forge-", which v1's
// worker treats as its own and clears.
const CACHE = 'forge2-runtime-v1';
// A photo shared in waits in its own cache (see the share target below). A new worker activating must
// not delete it before the page has taken it.
const SHARE = 'forge2-share';
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
      for (const k of await caches.keys()) if (k.startsWith('forge2-') && k !== CACHE && k !== SHARE) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

// Share target (manifest.webmanifest): another app shares a photo into Forge. The photo is kept in its
// own cache only until the page reads it (core/photo.js takeShared deletes it at once), and the page
// opens on Share unseen. Nothing is sent anywhere. Without this worker (it is not installed yet, or
// Erase everything removed it) the phone posts the photo to the gateway, which drops it unread and
// opens the page saying the phone sent it there (src/app.ts, route photo/sent).
const SHARE_KEY = '/v2/__shared-photo';
const SHARE_MAX = 40 * 1024 * 1024;

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/v2/share') return;
  event.respondWith(receiveShare(req));
});

async function receiveShare(req) {
  try {
    const form = await req.formData();
    const photo = form.getAll('photo').find((f) => typeof f === 'object' && f && /^image\//.test(f.type) && f.size > 0 && f.size <= SHARE_MAX);
    await caches.delete(SHARE);
    if (!photo) return Response.redirect('/v2/#/photo/none', 303);
    const box = await caches.open(SHARE);
    await box.put(SHARE_KEY, new Response(photo, { headers: { 'content-type': photo.type } }));
    return Response.redirect('/v2/#/photo/shared', 303);
  } catch {
    return Response.redirect('/v2/#/photo/missed', 303);
  }
}

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
