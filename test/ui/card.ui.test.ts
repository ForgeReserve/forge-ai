import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig, writeBundle } from '../../scripts/lib/android-web.ts';
import { type Gateway, MINT_A, mintsUp, startGateway } from '../e2e/helpers.ts';
import { mintSigner, provision } from '../support/cards.ts';
import { CardSim } from '../support/cardsim.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Tap a card in a phone-sized browser (slice A13). On the website the row says a page cannot read
// cards. In the Android app's bundle (served from its own origin as Capacitor serves it), a stand-in for
// Capacitor's bridge plays the ForgeNfc plugin, and every command it is given goes to a simulated card
// in this test (test/support/cardsim.ts) loaded with pieces minted at the local mint. The engine is the
// local gateway, so the card's swap really goes through the engine's relay to the mint.
const ROOT = resolve(import.meta.dirname, '..', '..');
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let g: Gateway;
let browser: Browser;
let site: Server;
let app: string;

function serveBundle(dir: string): Promise<Server> {
  const s = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false' } });
  const assets = mkdtempSync(join(tmpdir(), 'forge-apk-assets-'));
  writeBundle(join(ROOT, 'public'), assets, readConfig(join(ROOT, 'capacitor.config.json')));
  site = await serveBundle(join(assets, 'public'));
  app = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
  await g?.close();
});

/** The app with a reader whose cards are `card`, on the local engine. */
async function appWithCard(card: CardSim) {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  await ctx.exposeFunction('__cardTx', async (hex: string) => {
    const answer = await card.transceive(Array.from(Buffer.from(hex, 'hex')));
    return Buffer.from(answer).toString('hex');
  });
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__native = { calls: [] as any[], listeners: [] as any[], cardId: 0 };
    w.Capacitor = {
      isNativePlatform: () => true,
      nativePromise: async (plugin: string, method: string, opts: any) => {
        w.__native.calls.push({ plugin, method, opts });
        if (plugin === 'ForgeNfc' && method === 'status') return { available: true, enabled: true };
        if (plugin === 'ForgeNfc' && method === 'transceive') {
          if (opts.id !== w.__native.cardId) throw Object.assign(new Error('The card is gone.'), { code: 'tag_gone' });
          return { data: await w.__cardTx(opts.apdu) };
        }
        if (plugin === 'ForgeShareIn' && method === 'waiting') return { waiting: false };
        return undefined;
      },
      addListener: (plugin: string, event: string, fn: (ev: any) => void) => {
        const l = { plugin, event, fn };
        w.__native.listeners.push(l);
        return { remove: async () => (w.__native.listeners = w.__native.listeners.filter((x: any) => x !== l)) };
      },
    };
    // A card comes into the field.
    w.__tap = () => {
      w.__native.cardId += 1;
      for (const l of w.__native.listeners) if (l.plugin === 'ForgeNfc' && l.event === 'card') l.fn({ id: w.__native.cardId, isoDep: true });
    };
  });
  // Nothing leaves this computer: Forge's own engine (the app's default) is answered with a refusal.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort('blockedbyclient'));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(m.text()) && errors.push(m.text()));
  // Use the local engine, as a person would in More, Engine.
  await page.goto(`${app}/#/more/engine`);
  await page.waitForSelector('[data-screen=engine]');
  await page.fill('#engineAddress', `${g.url}/`);
  await Promise.all([page.waitForEvent('load'), page.click('#engineUse')]);
  await page.waitForSelector('[data-screen=home]');
  return { ctx, page, errors };
}

/** The card is held to the phone. */
async function tap(page: Page, card: CardSim) {
  card.tap();
  await page.evaluate(() => (window as any).__tap());
}

const cardStore = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.cards') ?? '{"jobs":[]}').jobs);
const vault = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.vault') ?? '{"in":[],"out":[]}'));

async function openCard(page: Page) {
  await page.goto(`${app}/#/funds/add`);
  await page.waitForSelector('[data-screen=addFunds]');
  await page.click('#fund-card');
  await page.waitForSelector('#cardHold');
}

describe('Tap a card', () => {
  it('on the website: listed after Scan a note, and says only the app can read cards', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('[data-screen=addFunds]');
    const ids = await page.locator('.fund-groups .row').evaluateAll((rows) => rows.map((r) => r.id));
    expect(ids.indexOf('fund-card')).toBe(ids.indexOf('fund-note') + 1);
    expect(await page.textContent('#fund-card')).toContain('Tap a card');
    await page.click('#fund-card');
    await page.waitForSelector('#cardAppOnly');
    expect(await page.textContent('#cardAppOnly')).toBe('Cards work in the Forge app for Android. A web page cannot talk to a card.');
    expect(await page.getAttribute('#cardGetApp', 'href')).toBe('/download');
    // The page did not fetch the curve library: nothing is loaded for cards on the website.
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/vendor/noble.js')))).toBe(false);
    await ctx.close();
  }, 60_000);

  it('in the app: tap, the card shows what it holds, a wrong PIN shows the tries left, then all of it moves to the funds', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [64, 32, 4]);
    const { ctx, page, errors } = await appWithCard(card);
    await openCard(page);
    expect(await page.textContent('#cardHold')).toBe('Hold the card to the back of your phone');
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    expect(await page.textContent('.card-art-amount')).toBe('100 sat');
    expect(await page.textContent('#cardMint')).toBe('From 127.0.0.1:3338');
    expect(await page.getAttribute('#cardAll', 'aria-checked')).toBe('true');
    expect(await page.textContent('#cardGet')).toBe('You get 100 sat.');
    expect(await page.textContent('#cardMove')).toBe('Move 100 sat');
    expect(await page.textContent('.card-view')).not.toMatch(/null|undefined/);
    // Nothing is held on the phone before the card is asked to sign.
    expect(await cardStore(page)).toEqual([]);

    await page.fill('#cardPin', '1111');
    await page.click('#cardMove');
    await expect.poll(() => page.textContent('.card-view .msg')).toBe('Wrong PIN. 2 tries left.');
    expect(card.balance()).toBe(100);

    let heldWhileSending: any = null;
    await page.route('**/v1/wallet/topup', async (route) => {
      heldWhileSending = await vault(page);
      await route.continue();
    });
    await page.fill('#cardPin', '1234');
    await page.click('#cardMove');
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('100 sat');
    expect(card.balance()).toBe(0);
    // The card's eCash was in the vault while it was sent, and nothing is left once credited.
    expect(heldWhileSending.in).toHaveLength(1);
    expect(heldWhileSending.in[0].token).toMatch(/^cashuB/);
    expect((await vault(page)).in).toEqual([]);
    expect(await cardStore(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: part of it, and a card lifted after it signed loses nothing; the next tap finishes it with the PIN given', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [16, 8, 4, 2]);
    const { ctx, page, errors } = await appWithCard(card);
    await openCard(page);
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await page.click('#cardSome');
    await page.fill('#cardAmount', '21');
    expect(await page.textContent('#cardGet')).toBe('You get 21 sat.');
    expect(await page.textContent('#cardBack')).toBe('1 sat goes back onto the card.');
    expect(await page.textContent('.card-view')).not.toMatch(/null|undefined/);
    await page.fill('#cardPin', '1234');
    // The card leaves the field right after it signed: its answer never arrives.
    card.breaks.push({ ins: 0x24, when: 'after' });
    await page.click('#cardMove');
    await page.waitForSelector('#cardHoldLine:has-text("Nothing is lost")', { timeout: 20_000 });
    expect(await page.textContent('#cardHoldLine')).toBe('The card left before it finished. Nothing is lost. Hold the same card to the phone again.');
    // The pieces are burned on the card and the payment is held on the phone.
    expect(card.balance()).toBe(8);
    expect((await cardStore(page))[0].state).toBe('ready');

    await tap(page, card);
    // The next tap: the card gives its signature again, the swap is made, the change goes back on it.
    await page.waitForSelector('#cardMove', { timeout: 30_000 });
    await expect.poll(() => card.balance()).toBe(9);
    await page.goto(`${app}/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('21 sat');
    expect(await cardStore(page)).toEqual([]);
    expect((await vault(page)).in).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
