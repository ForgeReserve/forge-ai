import { cpSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { serviceWorkerScript, shellFiles } from '../../src/sw.ts';

const PUBLIC = resolve(import.meta.dirname, '..', '..', 'public');

describe('service worker script', () => {
  it('lists the app shell and nothing behind the API', () => {
    const shell = shellFiles(PUBLIC);
    // The Classic page is at /classic/; / is the landing page, which the worker never keeps.
    expect(shell[0]).toBe('/classic/');
    expect(shell).not.toContain('/');
    expect(shell.some((p) => p.startsWith('/about'))).toBe(false);
    for (const p of ['/app.js', '/style.css', '/theme.js', '/icon.svg', '/manifest.webmanifest', '/offline.html', '/js/files.js', '/js/extract.js', '/js/wallet.js', '/icons/icon-192.png', '/icons/apple-touch-icon.png']) expect(shell).toContain(p);
    expect(shell).not.toContain('/sw.js');
    expect(shell).not.toContain('/index.html');
    expect(shell.some((p) => p.startsWith('/vendor/') || p.startsWith('/admin') || p.startsWith('/beta') || p.startsWith('/v1'))).toBe(false);
  });

  it('fills in the version and changes it when a shell file or a vendor file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-sw-'));
    cpSync(join(PUBLIC, 'sw.js'), join(dir, 'sw.js'));
    mkdirSync(join(dir, 'classic'));
    writeFileSync(join(dir, 'classic', 'index.html'), '<html>1</html>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    mkdirSync(join(dir, 'js'));
    writeFileSync(join(dir, 'js', 'a.js'), 'export {}');
    mkdirSync(join(dir, 'vendor'));
    writeFileSync(join(dir, 'vendor', 'lib.js'), 'v1');
    const sw = serviceWorkerScript(dir);
    const a = sw();
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(a.body).not.toContain('__FORGE_');
    expect(a.body).toContain(`const VERSION = "${a.version}"`);
    expect(a.body).toContain('const SHELL = ["/classic/","/app.js","/js/a.js"]');
    expect(sw()).toBe(a); // unchanged files: cached

    // The Classic page is in the shell, so a change to it is a new version.
    writeFileSync(join(dir, 'classic', 'index.html'), '<html>2</html>');
    utimesSync(join(dir, 'classic', 'index.html'), new Date(), new Date(Date.now() + 3000));
    const page = sw();
    expect(page.version).not.toBe(a.version);

    writeFileSync(join(dir, 'js', 'a.js'), 'export const x = 2');
    utimesSync(join(dir, 'js', 'a.js'), new Date(), new Date(Date.now() + 5000));
    const b = sw();
    expect(b.version).not.toBe(page.version);

    writeFileSync(join(dir, 'vendor', 'lib.js'), 'v2');
    utimesSync(join(dir, 'vendor', 'lib.js'), new Date(), new Date(Date.now() + 9000));
    const c = sw();
    expect(c.version).toBe(b.version); // the shell did not change
    expect(c.body).not.toBe(b.body); // but the vendor version did, so the script differs
  });
});

describe('the v2 worker script', () => {
  it('carries a build id that changes when an app file changes, and not for the voice files', async () => {
    const { v2WorkerScript } = await import('../../src/sw.ts');
    const dir = mkdtempSync(join(tmpdir(), 'forge-sw2-'));
    mkdirSync(join(dir, 'v2', 'core'), { recursive: true });
    mkdirSync(join(dir, 'v2', 'voice', 'phonon'), { recursive: true });
    cpSync(join(PUBLIC, 'v2', 'sw.js'), join(dir, 'v2', 'sw.js'));
    writeFileSync(join(dir, 'v2', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'v2', 'core', 'ui.js'), 'export {}');
    writeFileSync(join(dir, 'v2', 'voice', 'phonon', 'model.bin'), 'x');
    const sw = v2WorkerScript(dir);
    const a = sw();
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(a.body).toContain(`const VERSION = "${a.version}"`);
    expect(a.body).not.toContain('__FORGE_');
    writeFileSync(join(dir, 'v2', 'voice', 'phonon', 'model.bin'), 'changed');
    expect(sw().version).toBe(a.version);
    writeFileSync(join(dir, 'v2', 'core', 'ui.js'), 'export const changed = 1');
    utimesSync(join(dir, 'v2', 'core', 'ui.js'), new Date(), new Date(Date.now() + 5000));
    expect(sw().version).not.toBe(a.version);
  });
});

/**
 * The Classic worker (public/sw.js as the gateway fills it in), run in a small stand-in for a browser's
 * worker: caches in memory and a network that answers every path with its own name.
 */
function classicWorker(cached: Record<string, Record<string, string>> = {}) {
  const { body } = serviceWorkerScript(PUBLIC)();
  const listeners: Record<string, (e: any) => void> = {};
  const stores = new Map<string, Map<string, Response>>(Object.entries(cached).map(([name, files]) => [name, new Map(Object.entries(files).map(([p, b]) => [p, new Response(b)]))]));
  const net: string[] = [];
  const key = (r: { url: string } | string) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const caches = {
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    open: async (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const m = stores.get(name)!;
      return {
        match: async (r: { url: string } | string) => m.get(key(r))?.clone(),
        add: async (r: { url: string } | string) => void m.set(key(r), await fetch(r)),
        addAll: async (rs: Array<{ url: string } | string>) => {
          for (const r of rs) m.set(key(r), await fetch(r));
        },
        put: async (r: { url: string } | string, res: Response) => void m.set(key(r), res),
      };
    },
    match: async (r: { url: string } | string, o: { cacheName: string }) => stores.get(o.cacheName)?.get(key(r))?.clone(),
  };
  const fetch = async (r: { url: string } | string) => {
    net.push(key(r));
    return new Response(`network ${key(r)}`);
  };
  const skipped: number[] = [];
  const self = { location: { origin: ORIGIN }, clients: { claim: async () => {} }, skipWaiting: async () => void skipped.push(1), addEventListener: (t: string, f: (e: any) => void) => (listeners[t] = f) };
  // A worker's Request takes a path on its own origin.
  const Req = class {
    url: string;
    constructor(path: string) {
      this.url = new URL(path, ORIGIN).href;
    }
  };
  runInNewContext(body, { self, caches, fetch, Request: Req, Response, URL, Set, Map });
  const waitUntil = async (t: string) => {
    let p: Promise<unknown> = Promise.resolve();
    listeners[t]!({ waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  /** What the worker answers for a navigation (or a plain GET) to path, or undefined when it lets it pass. */
  const get = async (path: string, mode = 'navigate') => {
    let answer: Promise<Response> | undefined;
    listeners.fetch!({ request: { method: 'GET', mode, url: ORIGIN + path, headers: new Headers() }, respondWith: (r: Promise<Response>) => (answer = r) });
    return answer ? (await answer).text() : undefined;
  };
  const message = (data: unknown) => listeners.message!({ data });
  return { install: () => waitUntil('install'), activate: () => waitUntil('activate'), get, message, net, stores, skipped };
}
const ORIGIN = 'https://ai.forge-reserve.com';

describe('the Classic worker', () => {
  it('keeps the Classic page at /classic/ and never answers / from its cache', async () => {
    const w = classicWorker();
    await w.install();
    expect(w.skipped).toEqual([]); // the first worker in this browser has nothing to replace
    await w.activate();
    const shell = [...w.stores.values()].find((m) => m.has('/classic/'))!;
    expect(shell.has('/')).toBe(false);
    w.net.length = 0;
    // The Classic page and its files: from the cache, no request.
    expect(await w.get('/classic/')).toBe('network /classic/'); // the copy kept at install
    expect(await w.get('/classic/index.html')).toBe('network /classic/');
    expect(await w.get('/app.js', 'cors')).toBe('network /app.js');
    expect(w.net).toEqual([]);
    // The landing page (/ and its files): always the network.
    expect(await w.get('/')).toBe('network /');
    expect(await w.get('/index.html')).toBe('network /index.html');
    expect(await w.get('/about/about.js', 'cors')).toBeUndefined();
    expect(w.net).toEqual(['/', '/index.html']);
  });

  it('waits for the person to take a new version, as before', async () => {
    // A browser with a worker of this kind already (its shell has the Classic page at /classic/).
    const w = classicWorker({ 'forge-shell-0123456789abcdef': { '/classic/': 'Classic', '/app.js': 'app' } });
    await w.install();
    expect(w.skipped).toEqual([]);
    w.message({ type: 'SKIP_WAITING' }); // Reload in "Update available"
    expect(w.skipped).toEqual([1]);
  });

  it('takes over at once from a worker that kept the Classic page at /, and removes its caches', async () => {
    // As a browser has it from before the move: the old worker's shell, with the Classic page at /.
    const w = classicWorker({ 'forge-shell-0123456789abcdef': { '/': 'old Classic', '/app.js': 'old app' }, 'forge-vendor-0123456789abcdef': {}, 'forge2-keep': {} });
    await w.install();
    expect(w.skipped).toEqual([1]);
    await w.activate();
    const names = [...w.stores.keys()];
    expect(names).not.toContain('forge-shell-0123456789abcdef');
    expect(names).not.toContain('forge-vendor-0123456789abcdef');
    expect(names).toContain('forge2-keep'); // the v2 app's caches are its own
    expect(await w.get('/')).toBe('network /');
  });
});
