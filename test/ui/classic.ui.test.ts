import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { ABOUT_CSP } from '../../src/app.ts';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The Classic chat page at /classic/, where it moved when the landing page took the front page (/).
// It works there: it opens, reads its balance key, sends a question, opens its hash routes, and its
// worker keeps it for offline use, while / comes from the network every time. And a browser that still
// has the worker from before the move (which kept the Classic page at / and answered / from its cache)
// comes over by itself on its first visit: the old page shows a moment, the new worker takes over and
// the page reloads into the landing page at / (or a chat's link into that chat at /classic/), with its
// key and chats kept. A later Classic update still waits for the person, as before.
//
// The site before the move is played by a small proxy in front of the gateway: while it plays the old
// site it answers /, /sw.js, the manifest and the offline page with the files as they were
// (test/support/classic-at-root/, from the commit before the move, the worker filled in as the old
// src/sw.ts did), and passes everything else to the gateway. Switched to the new site, it passes
// everything through; playing a later deploy, it serves the worker with another version.
const OLD = resolve(import.meta.dirname, '..', 'support', 'classic-at-root');
const LANDING = 'Forge AI, private AI for activists';

let g: Gateway;
let browser: Browser;
let proxy: Server;
/** The proxy's address: the site the browser sees. */
let site: string;
let playing: 'old' | 'new' | 'newer' = 'new';
/** The old site's own answers, by path. */
let old: Record<string, { type: string; body: string }> = {};

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway();
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  // The old worker: its template with the version, the vendor version (the same as now: this deploy
  // leaves public/vendor alone) and the shell of that time (the Classic page at /, the rest as now).
  const now = await (await fetch(`${g.url}/sw.js`)).text();
  const vendor = /const VENDOR_VERSION = "([0-9a-f]+)"/.exec(now)![1]!;
  const shell: string[] = JSON.parse(/const SHELL = (\[.*\]);/.exec(now)![1]!);
  const oldShell = ['/', ...shell.filter((p) => p !== '/classic/')];
  const worker = readFileSync(join(OLD, 'sw.js'), 'utf8')
    .replace("'__FORGE_SW_VERSION__'", JSON.stringify('00000000000000aa'))
    .replace("'__FORGE_VENDOR_VERSION__'", JSON.stringify(vendor))
    .replace('__FORGE_SW_SHELL__', JSON.stringify(oldShell));
  const page = { type: 'text/html; charset=utf-8', body: readFileSync(join(OLD, 'index.html'), 'utf8') };
  old = {
    '/': page,
    '/index.html': page,
    '/sw.js': { type: 'text/javascript; charset=utf-8', body: worker },
    '/manifest.webmanifest': { type: 'application/manifest+json', body: readFileSync(join(OLD, 'manifest.webmanifest'), 'utf8') },
    '/offline.html': { type: 'text/html; charset=utf-8', body: readFileSync(join(OLD, 'offline.html'), 'utf8') },
  };

  proxy = createServer((req, res) => void pass(req, res).catch((e) => (res.writeHead(502), res.end(String(e)))));
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => (proxy ? proxy.close(r) : r(null)));
  await g?.close();
});

async function pass(req: IncomingMessage, res: ServerResponse) {
  const path = new URL(req.url!, site).pathname;
  const own = playing === 'old' && req.method === 'GET' ? old[path] : undefined;
  if (playing === 'newer' && path === '/sw.js') {
    const now = await (await fetch(`${g.url}/sw.js`)).text();
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(now.replace(/const VERSION = "[0-9a-f]+";/, 'const VERSION = "ffffffffffffffff";'));
    return;
  }
  if (own) {
    res.writeHead(200, { 'content-type': own.type, 'cache-control': 'no-cache' });
    res.end(own.body);
    return;
  }
  const headers = Object.fromEntries(Object.entries(req.headers).filter(([k]) => !['host', 'connection', 'content-length'].includes(k))) as Record<string, string>;
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (Readable.toWeb(req) as ReadableStream);
  const r = await fetch(g.url + req.url, { method: req.method, headers, body, redirect: 'manual', duplex: 'half' } as RequestInit);
  res.writeHead(r.status, Object.fromEntries([...r.headers].filter(([k]) => !['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k))));
  if (r.body) Readable.fromWeb(r.body as any).pipe(res);
  else res.end();
}

async function desktop(): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

/** A balance key funded with $2.00 through the API. */
async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 200);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

/** The balance the Classic page shows (its digits roll, so their words are in the label). */
const balance = (page: Page) => page.evaluate(() => document.getElementById('balanceText')!.getAttribute('aria-label') ?? document.getElementById('balanceText')!.textContent);

/** Waits for the Classic page to be up and its worker to control it. */
async function classicUp(page: Page) {
  await page.waitForSelector('#composer-input');
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller).catch(() => false), { timeout: 15_000 }).toBe(true);
}

/** What the site keeps in this browser: each cache with its paths, the balance key, the chats. */
const kept = (page: Page) =>
  page.evaluate(async () => {
    const caches_: Record<string, string[]> = {};
    for (const name of await caches.keys()) caches_[name] = (await (await caches.open(name)).keys()).map((r) => new URL(r.url).pathname);
    const chats = await new Promise<string[]>((done) => {
      const req = indexedDB.open('forge-chat', 1);
      req.onsuccess = () => {
        const all = req.result.transaction('conversations').objectStore('conversations').getAll();
        all.onsuccess = () => (done(all.result.map((c: any) => c.title)), req.result.close());
      };
      req.onerror = () => done([]);
    });
    const reg = await navigator.serviceWorker.getRegistration('/');
    return { caches: caches_, key: localStorage.getItem('forge.balanceKey'), chats, active: reg?.active?.scriptURL ?? null, waiting: !!reg?.waiting, scope: reg?.scope ?? null };
  });

/** Puts a chat in the Classic page's database, as the page saves one. */
const saveChat = (page: Page, chat: object) =>
  page.evaluate(
    (c) =>
      new Promise<void>((done, fail) => {
        const req = indexedDB.open('forge-chat', 1);
        req.onsuccess = () => {
          const t = req.result.transaction('conversations', 'readwrite');
          t.objectStore('conversations').put(c);
          t.oncomplete = () => (req.result.close(), done());
          t.onerror = () => fail(t.error);
        };
      }),
    chat,
  );

const aChat = (id: string, marker: string) => ({
  id,
  title: `Chat ${marker}`,
  model: 'mock-echo',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  messages: [
    { role: 'user', content: `Question ${marker}` },
    { role: 'assistant', content: `Answer ${marker}` },
  ],
});

describe('the Classic page at /classic/', () => {
  it('opens, reads its key, answers a question, opens its hash routes, and works offline from its worker', async () => {
    playing = 'new';
    const { ctx, page, errors } = await desktop();
    // /classic moves to /classic/, which is the Classic page.
    await page.goto(`${site}/classic`);
    expect(new URL(page.url()).pathname).toBe('/classic/');
    await classicUp(page);
    expect(await page.title()).toBe('Forge AI');
    const reg = await kept(page);
    expect(reg.scope).toBe(`${site}/`);
    expect(reg.active).toBe(`${site}/sw.js`);
    // Its own brand link opens it again; its manifest is linked from here.
    expect(await page.getAttribute('.brand', 'href')).toBe('/classic/');
    expect(await page.getAttribute('link[rel=manifest]', 'href')).toBe('/manifest.webmanifest');

    // Its balance key, stored as it stores it, is read on the next open.
    const key = await fundedKey();
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.reload();
    await classicUp(page);
    await expect.poll(() => balance(page)).toContain('2.00');

    // A question, answered and saved: the address takes the chat's hash, under /classic/.
    await page.waitForFunction(() => !document.querySelector('#modelName .skel'));
    await page.click('#modelBtn');
    await page.click('#modelList .opt[data-id="mock-echo"]');
    await page.fill('#composer-input', 'Where do we meet on Saturday? marker-classic-1');
    await page.press('#composer-input', 'Enter');
    await page.waitForSelector('#messages .msg.assistant');
    await expect.poll(() => page.getAttribute('#sendBtn', 'aria-label'), { timeout: 20_000 }).toBe('Send message');
    await expect.poll(() => new URL(page.url()).hash).toMatch(/^#\/c\/c_/);
    const url = new URL(page.url());
    expect(url.pathname).toBe('/classic/');
    const chatHash = url.hash;

    // Its hash routes, each from a fresh page: the chat, New chat and Add funds.
    const fresh = async (hash: string) => {
      const p = await ctx.newPage();
      p.on('pageerror', (e) => errors.push(e.message));
      await p.goto(`${site}/classic/${hash}`);
      await p.waitForSelector('#composer-input');
      return p;
    };
    const chatPage = await fresh(chatHash);
    await chatPage.waitForSelector('#messages .msg.user');
    expect(await chatPage.textContent('#messages')).toContain('marker-classic-1');
    expect(chatPage.url()).toBe(`${site}/classic/${chatHash}`);
    await chatPage.close();
    const newPage = await fresh('#new');
    await expect.poll(() => newPage.url()).toBe(`${site}/classic/`);
    expect(await newPage.locator('#messages .msg').count()).toBe(0);
    await newPage.close();
    const fundPage = await fresh('#fund');
    await fundPage.waitForSelector('#walletDialog[open]');
    await expect.poll(() => fundPage.url()).toBe(`${site}/classic/`);
    await fundPage.close();

    // Offline: the page and the chat open from the worker's cache; / does not (it is the landing page,
    // never kept), and gets the offline page, whose link opens the Classic page.
    expect(Object.values((await kept(page)).caches).flat()).not.toContain('/');
    await ctx.setOffline(true);
    await page.goto(`${site}/classic/${chatHash}`);
    await page.waitForSelector('#messages .msg.user');
    expect(await page.textContent('#messages')).toContain('marker-classic-1');
    expect(await page.isVisible('#offlineBar')).toBe(true);
    await page.goto(`${site}/`);
    await page.waitForSelector('text=You\'re offline. Your chats are saved on this device.');
    expect(await page.getAttribute('a', 'href')).toBe('/classic/');
    await page.click('a');
    await page.waitForSelector('#composer-input');
    expect(new URL(page.url()).pathname).toBe('/classic/');
    await ctx.setOffline(false);

    // Online, / is the landing page from the network, under its own policy, with the worker in place.
    const res = await page.goto(`${site}/`);
    expect(await page.title()).toBe(LANDING);
    expect(res!.headers()['content-security-policy']).toBe(ABOUT_CSP);
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${site}/sw.js`);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('is where the v2 app\'s Classic card goes', async () => {
    playing = 'new';
    const { ctx, page, errors } = await desktop();
    await pastFirstRun(ctx);
    await page.goto(`${site}/v2/#/more/look`);
    await page.waitForSelector('#modeClassic');
    expect(await page.getAttribute('#modeClassic', 'href')).toBe('/classic/');
    await page.click('#modeClassic');
    await page.waitForURL(`${site}/classic/`);
    await page.waitForSelector('#composer-input');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('a browser that has the Classic worker from before the move', () => {
  /**
   * The old site, the Classic page at / with its worker in control, a balance key and two chats in it;
   * then the deploy (the proxy plays the new site from here on).
   */
  async function before(marker: string) {
    playing = 'old';
    const { ctx, page, errors } = await desktop();
    await page.goto(`${site}/`);
    await classicUp(page);
    expect(await page.title()).toBe('Forge AI');
    const key = await fundedKey();
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await saveChat(page, aChat(`c_${marker}a`, `${marker}-a`));
    await saveChat(page, aChat(`c_${marker}b`, `${marker}-b`));
    // The old worker keeps the Classic page at / and answers / from its cache.
    const was = await kept(page);
    expect(was.caches['forge-shell-00000000000000aa']).toContain('/');
    playing = 'new';
    return { ctx, page, errors, key };
  }

  /** The new worker in control, every cache of the old one gone, / kept nowhere. */
  async function moved(page: Page, key: string, marker: string) {
    await expect.poll(async () => (await kept(page)).active, { timeout: 15_000 }).toBe(`${site}/sw.js`);
    const now = await kept(page);
    expect(Object.keys(now.caches).filter((k) => k.endsWith('00000000000000aa'))).toEqual([]);
    expect(Object.keys(now.caches).some((k) => k.startsWith('forge-shell-'))).toBe(true);
    for (const [name, paths] of Object.entries(now.caches)) {
      expect(paths, name).not.toContain('/');
      if (name.startsWith('forge-shell-')) expect(paths, name).toContain('/classic/');
    }
    // The key and the chats are where they were.
    expect(now.key).toBe(key);
    expect(now.chats.sort()).toEqual([`Chat ${marker}-a`, `Chat ${marker}-b`]);
  }

  /** The Classic page at /classic/ with its key and a chat from before. */
  async function classicThere(page: Page, marker: string) {
    await page.goto(`${site}/classic/#/c/c_${marker}a`);
    await classicUp(page);
    await page.waitForSelector('#messages .msg.user');
    expect(await page.textContent('#messages')).toContain(`Answer ${marker}-a`);
    await expect.poll(() => balance(page)).toContain('2.00');
    expect(await page.textContent('#chatList')).toContain(`Chat ${marker}-b`);
  }

  it('shows the old Classic page a moment on the first visit, then reloads into the landing page by itself', async () => {
    const { ctx, page, errors, key } = await before('first');
    // Every address the tab shows, and whether the old worker answered it.
    const seen: string[] = [];
    page.on('response', (r) => r.request().isNavigationRequest() && r.request().frame() === page.mainFrame() && seen.push(`${new URL(r.url()).pathname} ${r.fromServiceWorker() ? 'worker' : 'network'}`));
    // The first visit after the deploy: the old worker still answers / with the old Classic page from
    // its cache. That page asks for the worker again; the new one installs, sees the old worker's
    // Classic page at /, and takes over at once; the page reloads on the change into the landing page.
    await page.goto(`${site}/`);
    await expect.poll(() => page.title().catch(() => ''), { timeout: 15_000 }).toBe(LANDING);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(seen[0]).toBe('/ worker'); // the old Classic page, once
    expect(seen.length).toBe(2);
    await moved(page, key, 'first');
    // From then on / is the landing page from the network, and the Classic page is at /classic/.
    const again = await page.goto(`${site}/`);
    expect(await page.title()).toBe(LANDING);
    expect(again!.headers()['content-security-policy']).toBe(ABOUT_CSP);
    expect(await page.locator('#composer-input').count()).toBe(0);
    await classicThere(page, 'first');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('brings a person who had a chat open back to that chat, at /classic/', async () => {
    const { ctx, page: was, errors, key } = await before('chat');
    // A chat's own address on the old site, opened again after the deploy (from a bookmark, say).
    await was.close();
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${site}/#/c/c_chata`);
    // The page reloads at /#/c/<id> when the new worker takes over; that is the landing page now, and it
    // sends the chat's link on to the Classic page.
    await page.waitForURL(`${site}/classic/#/c/c_chata`, { timeout: 15_000 });
    await page.waitForSelector('#messages .msg.user');
    expect(await page.textContent('#messages')).toContain('Answer chat-a');
    await moved(page, key, 'chat');
    await page.goto(`${site}/`);
    expect(await page.title()).toBe(LANDING);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('still lets a later Classic update wait for the person, with Update available', async () => {
    playing = 'new';
    const { ctx, page, errors } = await desktop();
    await page.goto(`${site}/classic/`);
    await classicUp(page);
    const first = (await kept(page)).caches;
    // A later deploy that changes the Classic page: a new worker, which does not take over by itself.
    playing = 'newer';
    await page.reload();
    await classicUp(page);
    await expect.poll(async () => (await kept(page)).waiting, { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.evaluate(() => document.getElementById('updateToast')!.matches(':popover-open'))).toBe(true);
    await page.waitForTimeout(1000);
    expect((await kept(page)).waiting).toBe(true);
    expect(Object.keys((await kept(page)).caches)).toEqual(expect.arrayContaining(Object.keys(first)));
    // Reload takes it.
    await page.click('#updateReload');
    await expect.poll(async () => (await kept(page)).waiting, { timeout: 15_000 }).toBe(false);
    await classicUp(page);
    expect(Object.keys((await kept(page)).caches).some((k) => k === 'forge-shell-ffffffffffffffff')).toBe(true);
    playing = 'new';
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});
