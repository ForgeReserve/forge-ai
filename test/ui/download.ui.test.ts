import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { fakeApk } from '../support/apk.ts';

const { tokens: LIGHT }: { tokens: Record<string, string> } = await import('../../public/v2/modules/look/light/index.js' as string);

// The /download page (public/v2/download/) in a phone-sized browser, with each phone's user agent: the
// app's own button in its rings, and a row of ways under it, a picture and a word each, the phone's own
// ways first. Picking a way changes what the button does and turns the rings. Android and GrapheneOS
// from this site (version, size, the SHA-256 behind Check with Copy, four pictures of how to install,
// which play once the download starts), Google Play and iPhone dim with Soon (no way to pick them) until
// FORGE_PLAY_URL and FORGE_IOS_URL are set, the browser always. An iPhone is never offered an Android way.
// An event pass in the address goes into Open. Nothing is boxed: no pills and no cards. Nothing is asked
// of another site, the page's policy refuses nothing, and nothing is logged as an error.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const ANDROID = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: ANDROID_UA };
const SMALL = { ...ANDROID, viewport: { width: 360, height: 640 } };
const IPHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3, userAgent: IPHONE_UA };
const DESKTOP = { viewport: { width: 1440, height: 900 }, userAgent: DESKTOP_UA };
const PLAY = 'https://play.google.com/store/apps/details?id=com.forgereserve.ai';
const TESTFLIGHT = 'https://testflight.apple.com/join/AbCd1234';
const hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

// both: the two APKs; plain: nothing set; linked: one APK, and the Play and iPhone links.
let both: Gateway;
let plain: Gateway;
let linked: Gateway;
let browser: Browser;
let apk: Buffer;
let pv: Buffer;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  const dir = mkdtempSync(join(tmpdir(), 'forge-dl-'));
  apk = fakeApk('1.2.3', 7, 300_000);
  pv = fakeApk('1.2.3', 7, 700_000);
  writeFileSync(join(dir, 'forge.apk'), apk);
  writeFileSync(join(dir, 'pv.apk'), pv);
  both = await startGateway({ env: { FORGE_APK_PATH: join(dir, 'forge.apk'), FORGE_APK_PRIVATE_VOICE_PATH: join(dir, 'pv.apk') } });
  plain = await startGateway();
  linked = await startGateway({ env: { FORGE_APK_PATH: join(dir, 'forge.apk'), FORGE_PLAY_URL: PLAY, FORGE_IOS_URL: TESTFLIGHT } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all([both?.close(), plain?.close(), linked?.close()]);
});

interface Opened {
  page: Page;
  errors: string[];
  away: string[];
  close: () => Promise<void>;
}

/** The page on this phone, once its ways are drawn. */
async function open(device: object, g: Gateway, { hash = '', look, clipboard = false, still = true }: { hash?: string; look?: object; clipboard?: boolean; still?: boolean } = {}): Promise<Opened> {
  const ctx = await browser.newContext({ ...device, reducedMotion: still ? 'reduce' : 'no-preference' });
  if (clipboard) await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: g.url });
  if (look) await ctx.addInitScript((l) => localStorage.setItem('forge2.look', JSON.stringify(l)), look);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const away: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A file or a request the page's policy refused shows here too.
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => new URL(r.url()).origin !== g.url && away.push(r.url()));
  await page.goto(`${g.url}/download${hash}`);
  await page.waitForSelector('#downloadBody:not([aria-busy])', { state: 'attached' });
  return { page, errors, away, close: () => ctx.close() };
}

/** The ways in the row, in order: their id, '?' after one that is not there yet. */
const plan = (page: Page) => page.getAttribute('#downloadBody', 'data-plan');

/** Each way in the row: whether it is picked, whether it can be picked, what it says and whether it has its picture. */
const ways = (page: Page) =>
  page.$$eval('#ways [role=radio]', (xs) =>
    Object.fromEntries(
      xs.map((x) => [
        x.getAttribute('data-way'),
        { checked: x.getAttribute('aria-checked'), disabled: x.getAttribute('aria-disabled'), tab: (x as HTMLElement).tabIndex, word: x.textContent, name: x.getAttribute('aria-label'), icon: !!x.querySelector('svg') },
      ]),
    ),
  );

/** The button: its id, where it goes, its file name and what it says. */
const button = (page: Page) => page.$eval('.go', (a) => ({ id: a.id, href: a.getAttribute('href'), download: a.getAttribute('download'), text: a.textContent, icon: !!a.querySelector('svg') }));

/** Sideways scroll, if any. */
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

/** The rings' turn, as the browser has it now. */
const turn = (page: Page) => page.$eval('.turn', (g) => getComputedStyle(g).transform);

/** WCAG contrast of an element's text against the page's own ground. */
const contrast = (page: Page, sel: string) =>
  page.$eval(sel, (e) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const a = lum(rgb(getComputedStyle(e).color));
    const b = lum(rgb(getComputedStyle(document.body).backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });

/**
 * Anything on the page drawn as a pill or a card: a class of that kind, or a rounded box with a fill or an
 * edge. The app's round button (and the ring of light that goes out from it) is the one round thing.
 */
const boxes = (page: Page) =>
  page.$$eval('main *', (xs) =>
    xs
      .filter((x) => !x.closest('svg') && !x.matches('.go, .ripple'))
      .filter((x) => {
        if (/\b(tag|chip|pill|card|badge|lozenge)\b/i.test(x.getAttribute('class') ?? '')) return true;
        const s = getComputedStyle(x);
        const r = parseFloat(s.borderTopLeftRadius) || 0;
        const fill = (s.backgroundColor.match(/[\d.]+/g) ?? []).map(Number)[3] !== 0 && s.backgroundColor !== 'rgba(0, 0, 0, 0)';
        const edge = ['Top', 'Right', 'Bottom', 'Left'].some((k) => parseFloat((s as any)[`border${k}Width`]) > 0 && (s as any)[`border${k}Style`] !== 'none');
        return r > 4 && (fill || edge || s.boxShadow !== 'none');
      })
      .map((x) => `${x.tagName.toLowerCase()}.${x.getAttribute('class') ?? ''}#${x.id}`),
  );

describe('the /download page on Android', () => {
  it('leads with the APK: the button downloads it, with its version, size, the SHA-256 behind Check, and the steps', async () => {
    const { page, errors, away, close } = await open(ANDROID, both, { clipboard: true });
    try {
      expect(await page.textContent('h1')).toBe('Download');
      expect(await page.title()).toBe('Download');
      expect(await plan(page)).toBe('android graphene play? iphone? web');
      const w = await ways(page);
      expect(w.android).toEqual({ checked: 'true', disabled: null, tab: 0, word: 'Android', name: 'Android', icon: true });
      expect(w.graphene).toEqual({ checked: 'false', disabled: null, tab: -1, word: 'Graphene', name: 'GrapheneOS', icon: true });
      expect(w.web).toMatchObject({ checked: 'false', disabled: null, word: 'Browser', icon: true });
      // Google Play and the iPhone app: there, dim, Soon, and no way to pick them or tab to them.
      expect(w.play).toEqual({ checked: 'false', disabled: 'true', tab: -1, word: 'Soon', name: 'Google Play, Soon', icon: true });
      expect(w.iphone).toEqual({ checked: 'false', disabled: 'true', tab: -1, word: 'Soon', name: 'iPhone, Soon', icon: true });
      expect(await contrast(page, '#way-play .way-word')).toBeGreaterThanOrEqual(4.5);

      expect(await button(page)).toEqual({ id: 'downloadApk', href: '/download/forge.apk', download: 'forge.apk', text: 'Download0.3 MB', icon: true });
      expect(await page.textContent('#apkSub')).toBe('Forge · Version 1.2.3');
      expect(await page.locator('#downloadSteps li').count()).toBe(4);
      expect(await page.locator('#downloadSteps li svg').count()).toBe(4);
      expect(await page.$$eval('#downloadSteps li', (xs) => xs.map((x) => x.textContent))).toEqual(['Download', 'Open file', 'Allow install', 'Open Forge']);
      // The file is the one the button names.
      const got = await page.evaluate(async () => {
        const r = await fetch('/download/forge.apk');
        return { type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
      });
      expect(got).toEqual({ type: 'application/vnd.android.package-archive', size: apk.length });

      // The fingerprint stays out of the way until Check; then it shows in place, with Copy.
      expect(await page.isVisible('#downloadPrint')).toBe(false);
      await page.click('#downloadCheck');
      expect(await page.getAttribute('#downloadCheck', 'aria-expanded')).toBe('true');
      expect((await page.textContent('#downloadHash'))!.replaceAll(' ', '')).toBe(hex(apk));
      expect(await page.locator('#downloadHash span').count()).toBe(8);
      await page.click('#downloadCopy');
      await expect.poll(() => page.textContent('#downloadCopy')).toBe('Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(hex(apk));
      expect(await page.textContent('#downloadCopied')).toBe('Copied');

      // What the one picked is, behind the info button.
      expect(await page.isVisible('#downloadAbout')).toBe(false);
      await page.click('#downloadInfo');
      expect(await page.textContent('#downloadAbout')).toBe('Forge. For most phones.');

      // GrapheneOS picked: the button downloads Forge Private Voice, and the rings turn towards it.
      const before = await turn(page);
      await page.click('#way-graphene');
      await expect.poll(() => button(page)).toEqual({ id: 'downloadApk', href: '/download/forge-private-voice.apk', download: 'forge-private-voice.apk', text: 'Download0.7 MB', icon: true });
      expect(await page.getAttribute('#way-graphene', 'aria-checked')).toBe('true');
      expect(await page.getAttribute('#way-android', 'aria-checked')).toBe('false');
      expect(await page.textContent('#apkSub')).toBe('Forge Private Voice · Version 1.2.3');
      await page.click('#downloadInfo');
      expect(await page.textContent('#downloadAbout')).toBe('Forge Private Voice. For GrapheneOS: it turns your voice into words on the phone. A bigger file.');
      await page.click('#downloadCheck');
      expect((await page.textContent('#downloadHash'))!.replaceAll(' ', '')).toBe(hex(pv));
      expect(await turn(page)).not.toBe(before);

      // A Soon way does nothing when tapped.
      await page.click('#way-play', { force: true });
      expect(await page.getAttribute('#way-graphene', 'aria-checked')).toBe('true');
      // The arrows move along the ways that are there, past the Soon ones.
      await page.focus('#way-graphene');
      await page.keyboard.press('ArrowRight');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('way-web');
      await expect.poll(() => button(page)).toMatchObject({ id: 'openWeb', href: '/v2/', text: 'OpenForge' });
      await page.keyboard.press('ArrowRight');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('way-android');
      // Tab goes from the picked way to the button and on, never to a Soon way.
      const stops: string[] = [];
      for (let i = 0; i < 12; i++) {
        await page.keyboard.press('Tab');
        stops.push(await page.evaluate(() => document.activeElement?.id ?? ''));
      }
      expect(stops).not.toContain('way-play');
      expect(stops).not.toContain('way-iphone');

      // The download starts: the button shows a check and Started, and the steps play.
      await page.evaluate(() => document.getElementById('downloadApk')!.addEventListener('click', (e) => e.preventDefault()));
      await page.click('#downloadApk');
      expect(await page.getAttribute('main', 'data-state')).toBe('started');
      expect(await page.textContent('.go')).toBe('Started0.3 MB');
      // (Reduced motion here: the steps stand still.)
      expect(await page.getAttribute('#downloadSteps', 'data-play')).toBeNull();
      expect(await page.getAttribute('#footPrivacy', 'href')).toBe('/privacy');
      expect(await boxes(page)).toEqual([]);
      expect(await sideways(page)).toBe(0);
      expect(away).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('on a 360 by 640 phone: the button is on the first screen, every target is 48 px or more, every word fits', async () => {
    const { page, errors, close } = await open(SMALL, both);
    try {
      const go = (await page.locator('.go').boundingBox())!;
      expect(go.y + go.height).toBeLessThanOrEqual(640);
      expect(go.width).toBeGreaterThanOrEqual(120);
      const row = (await page.locator('#ways').boundingBox())!;
      expect(row.y + row.height).toBeLessThanOrEqual(640);
      expect(await sideways(page)).toBe(0);
      const bad = await page.$$eval('a[href], button', (xs) =>
        xs
          .filter((x) => x.checkVisibility() && !x.closest('.skip'))
          .map((x) => ({ id: x.id || x.className, r: x.getBoundingClientRect(), icon: !!x.querySelector('svg'), words: (x.textContent ?? '').trim().split(/\s+/).filter(Boolean).length }))
          .filter((x) => Math.min(x.r.width, x.r.height) < 48 || (!x.icon && x.words > 1))
          .map((x) => x.id),
      );
      expect(bad).toEqual([]);
      // The ways are 56 px or more to tap.
      for (const b of await page.$$eval('#ways [role=radio]', (xs) => xs.map((x) => x.getBoundingClientRect().toJSON()))) expect(Math.min(b.width, b.height)).toBeGreaterThanOrEqual(56);
      for (const sel of ['.way-word', '.step-word']) expect(await page.$$eval(sel, (xs) => xs.every((x) => x.scrollWidth <= x.clientWidth + 1)), sel).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('with no APK on the site: Android says Soon, and the button opens Forge in the browser', async () => {
    const { page, errors, close } = await open(ANDROID, plain);
    try {
      expect(await page.textContent('h1')).toBe('Download');
      expect(await plan(page)).toBe('android? play? iphone? web');
      const w = await ways(page);
      expect(w.android).toMatchObject({ disabled: 'true', word: 'Soon', name: 'Android, Soon', tab: -1 });
      expect(w.web).toMatchObject({ checked: 'true', tab: 0 });
      expect(await button(page)).toMatchObject({ id: 'openWeb', href: '/v2/' });
      expect(await page.locator('#downloadApk, #downloadSteps, #way-graphene').count()).toBe(0);
      expect(await page.locator('a[href$=".apk"]').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('links Google Play and the iPhone app once their links are set', async () => {
    const { page, errors, close } = await open(ANDROID, linked);
    try {
      expect(await plan(page)).toBe('android play iphone web');
      const w = await ways(page);
      expect(w.play).toMatchObject({ disabled: null, word: 'Play', name: 'Google Play' });
      expect(w.iphone).toMatchObject({ disabled: null, word: 'iPhone', name: 'iPhone' });
      // One APK: no info button.
      expect(await page.locator('#downloadInfo').count()).toBe(0);
      await page.click('#way-play');
      await expect.poll(() => button(page)).toMatchObject({ id: 'downloadPlay', href: PLAY, text: 'GetGoogle Play' });
      await page.click('#way-iphone');
      await expect.poll(() => button(page)).toMatchObject({ id: 'downloadIos', href: TESTFLIGHT, text: 'GetTestFlight' });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('carries an event pass from its address into Open, as /j does', async () => {
    const { page, errors, close } = await open(ANDROID, both, { hash: '#pass-AbCd1234_efgh' });
    try {
      await page.click('#way-web');
      await expect.poll(() => page.getAttribute('.go', 'href')).toBe('/v2/#join=pass-AbCd1234_efgh');
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
    // Something that is not a pass is left out.
    const other = await open(ANDROID, plain, { hash: '#<b>' });
    expect(await other.page.getAttribute('#openWeb', 'href')).toBe('/v2/');
    await other.close();
  }, 60_000);
});

describe('the /download page on an iPhone', () => {
  it('no iPhone app yet: the button opens Forge, the Home Screen steps under it, the iPhone app as Soon, nothing for Android', async () => {
    const { page, errors, close } = await open(IPHONE, both, { hash: '#join=pass-AbCd1234_efgh' });
    try {
      expect(await page.textContent('h1')).toBe('Download');
      expect(await page.getAttribute('#downloadBody', 'data-offer')).toBe('addHome');
      expect(await plan(page)).toBe('iphone? web');
      expect(await button(page)).toMatchObject({ id: 'openWeb', href: '/v2/#join=pass-AbCd1234_efgh' });
      expect(await page.$$eval('#addHome .add-home-step', (xs) => xs.map((x) => [x.querySelector('svg') ? 'icon' : 'none', (x.textContent ?? '').trim()]))).toEqual([
        ['icon', 'Open Forge'],
        ['icon', 'Share'],
        ['icon', 'Add to Home Screen'],
      ]);
      expect(await page.textContent('#addHomeHead')).toBe('Put Forge on your Home Screen.');
      expect((await ways(page)).iphone).toMatchObject({ disabled: 'true', word: 'Soon', name: 'iPhone, Soon' });
      // The site has two APKs; the iPhone is offered none, and no Android way at all.
      expect(await page.locator('#downloadApk, #way-android, #way-graphene, #way-play').count()).toBe(0);
      expect(await page.locator('a[href$=".apk"]').count()).toBe(0);
      expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Android|Google|Graphene/);
      expect(await sideways(page)).toBe(0);
      expect(await boxes(page)).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('with the iPhone app\'s link: the button opens it, and the browser is the other way; still nothing for Android', async () => {
    const { page, errors, close } = await open(IPHONE, linked);
    try {
      expect(await page.getAttribute('#downloadBody', 'data-offer')).toBe('link');
      expect(await plan(page)).toBe('iphone web');
      expect(await button(page)).toMatchObject({ id: 'downloadIos', href: TESTFLIGHT, text: 'GetTestFlight' });
      expect(await page.locator('#addHome').count()).toBe(0);
      await page.click('#way-web');
      await expect.poll(() => button(page)).toMatchObject({ id: 'openWeb', href: '/v2/' });
      expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Android|Google|Graphene/);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
});

describe('the /download page on a computer', () => {
  it('Download on the left with the ways under it, the button in its rings on the right; the rings draw on the way in', async () => {
    const { page, errors, away, close } = await open(DESKTOP, linked, { still: false });
    try {
      expect(await page.textContent('h1')).toBe('Download');
      expect(await plan(page)).toBe('web android play iphone');
      expect(await button(page)).toMatchObject({ id: 'openWeb', href: '/v2/' });
      // The way in: the rings draw and their tips run round, by stroke-dashoffset and transform.
      expect(await page.$$eval('.arc', (xs) => xs.map((x) => getComputedStyle(x).animationName))).toEqual(['draw', 'draw']);
      expect(await page.$eval('.run', (x) => getComputedStyle(x).animationName)).toBe('run');
      await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished)));
      const stage = (await page.locator('.stage').boundingBox())!;
      const row = (await page.locator('#ways').boundingBox())!;
      expect(stage.x).toBeGreaterThan(row.x + row.width);
      expect(stage.y).toBeLessThan(900);
      // Picking a way turns the rings and changes the button's face.
      const before = await turn(page);
      await page.click('#way-android');
      await expect.poll(() => button(page)).toMatchObject({ id: 'downloadApk' });
      await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished)));
      expect(await turn(page)).not.toBe(before);
      // A download started: light runs round the rings and the steps play.
      await page.evaluate(() => document.getElementById('downloadApk')!.addEventListener('click', (e) => e.preventDefault()));
      await page.click('#downloadApk');
      expect(await page.$eval('.lit', (x) => getComputedStyle(x).animationName)).toBe('sweep');
      expect(await page.getAttribute('#downloadSteps', 'data-play')).toBe('');
      expect(await boxes(page)).toEqual([]);
      expect(await sideways(page)).toBe(0);
      expect(away).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('stands still under reduced motion, and takes the look this phone keeps from the app', async () => {
    const { page, errors, close } = await open(ANDROID, both, { look: { look: 'light', scheme: 'light', tokens: LIGHT } });
    try {
      expect(await page.getAttribute('html', 'data-scheme')).toBe('light');
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe(LIGHT.bg);
      expect(await contrast(page, '#way-play .way-word')).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(page, '#apkSub')).toBeGreaterThanOrEqual(4.5);
      await page.click('#way-web');
      expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
      expect(await page.$eval('.arc', (x) => getComputedStyle(x).strokeDashoffset)).toBe('0px');
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
});

describe('the privacy page', () => {
  it('opens from the footer of the landing page and of this page, at one address, and fits a phone', async () => {
    const { page, errors, close } = await open(ANDROID, plain);
    try {
      await page.click('#footPrivacy');
      await page.waitForURL(`${plain.url}/privacy`);
      expect(await page.textContent('h1')).toBe('Privacy');
      expect(await page.locator('section.pv').count()).toBe(13);
      expect(await sideways(page)).toBe(0);
      await page.goto(`${plain.url}/`);
      await page.click('#footPrivacy');
      await page.waitForURL(`${plain.url}/privacy`);
      await page.goto(`${plain.url}/privacy/`);
      await page.waitForURL(`${plain.url}/privacy`);
      await page.click('#footDownload');
      await page.waitForURL(`${plain.url}/download`);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
});
