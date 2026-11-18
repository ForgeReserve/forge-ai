import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay } from './ways.ts';

// Get the app on an iPhone (public/v2/core/getapp.js), in phone-sized Chrome with each phone's user
// agent. iPhone Safari never gets the Android page or its APK: the Cashu card's Get the app shows the
// Home Screen steps (Share, Add to Home Screen), the /download page says Forge for iPhone with the same
// steps after Open Forge, and the Fedimint card (no till in the iPhone app) offers nothing. A site with
// the iPhone app's link (FORGE_IOS_URL) gets that link instead. Put on the Home Screen already, an
// iPhone is shown no steps. Android and a computer keep the /download page and its APK, as before.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const IPHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: IPHONE_UA };
const ANDROID = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: ANDROID_UA };
const DESKTOP = { viewport: { width: 1280, height: 800 }, userAgent: DESKTOP_UA };
const LINK = 'https://testflight.apple.com/join/AbCd1234';

// plain: no iPhone link, with an APK (an iPhone must never be offered it); linked: FORGE_IOS_URL set.
let plain: Gateway;
let linked: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  const apk = join(mkdtempSync(join(tmpdir(), 'forge-apk-')), 'forge.apk');
  writeFileSync(apk, Buffer.from('PK\u0003\u0004'.padEnd(4000, 'x')));
  plain = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_APK_PATH: apk } });
  linked = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_IOS_URL: LINK } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await plain?.close();
  await linked?.close();
});

interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  asked: string[];
}

/** A phone past the first run. installed: Forge opened from the Home Screen (Safari's navigator.standalone). */
async function phone(device: object, { installed = false } = {}): Promise<Phone> {
  const ctx = await browser.newContext(device);
  await pastFirstRun(ctx);
  if (installed) await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { get: () => true, configurable: true }));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} ${m.location().url}`));
  const asked: string[] = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  return { ctx, page, errors, asked };
}

/** The Cashu card's screen on the website, where it says cards need the app. */
async function cardScreen(page: Page, g: Gateway) {
  await page.goto(`${g.url}/v2/#/funds/add/card`);
  await page.waitForSelector('#cardAppOnly');
}

/** The Fedimint card's screen on the website, from Add money (the way is listed once the engine's methods are in). */
async function fedimintScreen(page: Page, g: Gateway) {
  await page.goto(`${g.url}/v2/#/funds/add`);
  await openWay(page, 'fedimint');
  await page.waitForSelector('#fedAppOnly');
}

/** Waits until the offer is drawn in `sel` (core/getapp.js marks it with its kind), and returns the kind. */
async function offered(page: Page, sel: string) {
  return (await page.waitForSelector(`${sel}[data-offer]`, { state: 'attached' })).getAttribute('data-offer');
}
const FOOT = '[data-screen=fund] .foot';

/** The Home Screen steps: their sentence and each step's words, with an icon each. */
async function steps(page: Page) {
  await page.waitForSelector('#addHome');
  return {
    head: await page.textContent('#addHomeHead'),
    steps: await page.$$eval('#addHome .add-home-step', (xs) => xs.map((x) => [x.querySelector('svg') ? 'icon' : 'none', (x.textContent ?? '').trim()])),
  };
}

const linksTo = (page: Page, re: RegExp) => page.$$eval('a[href]', (as, src) => as.some((a) => new RegExp(src).test(a.getAttribute('href') ?? '')), re.source);

describe('Get the app on an iPhone', () => {
  it('Safari, no iPhone app: the Home Screen steps in place of the Android page, on the card and on /download', async () => {
    const { ctx, page, errors, asked } = await phone(IPHONE);
    await cardScreen(page, plain);
    expect(await offered(page, FOOT)).toBe('addHome');
    expect(await steps(page)).toEqual({
      head: 'Put Forge on your Home Screen.',
      steps: [
        ['icon', 'Share'],
        ['icon', 'Add to Home Screen'],
      ],
    });
    // Nothing leads to the Android page or its APK.
    expect(await page.$('#cardGetApp')).toBeNull();
    expect(await linksTo(page, /download/)).toBe(false);
    // The steps fit the phone: no sideways scroll, each icon a 48 px square.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const box of await page.$$eval('.add-home-ico', (xs) => xs.map((x) => x.getBoundingClientRect().toJSON()))) expect([box.width, box.height]).toEqual([48, 48]);

    // The Fedimint card is Android's only: no button and no steps.
    await fedimintScreen(page, plain);
    expect(await offered(page, FOOT)).toBe('none');
    expect(await page.$('#fedGetApp')).toBeNull();
    expect(await page.$('#addHome')).toBeNull();
    expect(await linksTo(page, /download/)).toBe(false);

    // /download: Forge for iPhone, Open Forge first (so the Home Screen gets Forge), then the steps. The
    // site has an APK; the iPhone is not offered it.
    await page.goto(`${plain.url}/download`);
    expect(await offered(page, '#downloadBody')).toBe('addHome');
    expect(await steps(page)).toEqual({
      head: 'Put Forge on your Home Screen.',
      steps: [
        ['icon', 'Open Forge'],
        ['icon', 'Share'],
        ['icon', 'Add to Home Screen'],
      ],
    });
    expect(await page.textContent('h1')).toBe('Forge for iPhone');
    expect(await page.title()).toBe('Forge for iPhone');
    expect(await page.getAttribute('#addHomeOpen', 'href')).toBe('/v2/');
    expect(await page.$('#downloadApk')).toBeNull();
    expect(await linksTo(page, /\.apk$/)).toBe(false);
    expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Android/);
    // An event link with no pass leads here too.
    await page.goto(`${plain.url}/j`);
    await page.waitForURL(/\/download$/);
    await page.waitForSelector('#addHome');
    await page.click('#addHomeOpen');
    await page.waitForSelector('[data-screen=home]');
    expect(asked.filter((p) => p.endsWith('.apk'))).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('already on the Home Screen: no steps and no button', async () => {
    const { ctx, page, errors } = await phone(IPHONE, { installed: true });
    await cardScreen(page, plain);
    expect(await offered(page, FOOT)).toBe('none');
    expect(await page.$('#addHome')).toBeNull();
    expect(await page.$('#cardGetApp')).toBeNull();
    expect(await page.$eval(FOOT, (n) => n.children.length)).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a site with the iPhone app’s link: Get the app opens it, on the card and on /download, also from the Home Screen', async () => {
    for (const installed of [false, true]) {
      const { ctx, page, errors } = await phone(IPHONE, { installed });
      await cardScreen(page, linked);
      expect(await offered(page, FOOT)).toBe('link');
      expect(await page.getAttribute('#cardGetApp', 'href')).toBe(LINK);
      expect(await page.textContent('#cardGetApp')).toBe('Get the app');
      expect(await page.$('#addHome')).toBeNull();
      // The iPhone app has no till: the Fedimint card still offers nothing.
      await fedimintScreen(page, linked);
      expect(await offered(page, FOOT)).toBe('none');
      expect(await page.$('#fedGetApp')).toBeNull();
      await page.goto(`${linked.url}/download`);
      expect(await offered(page, '#downloadBody')).toBe('link');
      expect(await page.textContent('h1')).toBe('Forge for iPhone');
      expect(await page.getAttribute('#downloadIos', 'href')).toBe(LINK);
      expect(await page.getAttribute('#openWeb', 'href')).toBe('/v2/');
      expect(await page.$('#addHome')).toBeNull();
      expect(errors).toEqual([]);
      await ctx.close();
    }
  }, 60_000);
});

describe('Get the app on Android and a computer, as before', () => {
  for (const [name, device] of [
    ['Android', ANDROID],
    ['a computer', DESKTOP],
  ] as const) {
    it(`${name}: the button opens /download, which offers the APK; the iPhone link is never shown`, async () => {
      for (const g of [plain, linked]) {
        const { ctx, page, errors, asked } = await phone(device);
        await cardScreen(page, g);
        expect(await offered(page, FOOT)).toBe('download');
        expect(await page.getAttribute('#cardGetApp', 'href')).toBe('/download');
        expect(await page.textContent('#cardGetApp')).toBe('Get the app');
        expect(await page.$('#addHome')).toBeNull();
        await fedimintScreen(page, g);
        expect(await offered(page, FOOT)).toBe('download');
        expect(await page.getAttribute('#fedGetApp', 'href')).toBe('/download');
        // The screens ask the site nothing for it.
        expect(asked).not.toContain('/download/info');
        await page.click('#fedGetApp');
        await page.waitForSelector('[data-screen=download]');
        expect(await page.textContent('h1')).toBe('Forge for Android');
        expect(await page.title()).toBe('Forge for Android');
        if (g === plain) expect(await (await page.waitForSelector('#downloadApk')).getAttribute('href')).toBe('/download/forge.apk');
        else await page.waitForSelector('#downloadComing');
        expect(await linksTo(page, /testflight/)).toBe(false);
        expect(await page.$('#addHome')).toBeNull();
        expect(errors).toEqual([]);
        await ctx.close();
      }
    }, 60_000);
  }
});
