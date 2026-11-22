import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { fakeApk } from '../support/apk.ts';

const { tokens: LIGHT }: { tokens: Record<string, string> } = await import('../../public/v2/modules/look/light/index.js' as string);

// The /download page (public/v2/download/) in a phone-sized browser, with each phone's user agent: every
// way to get Forge as a card with an icon, a word or two and its state, the ones for this phone first.
// Android from this site (one APK or two, with its version, size, SHA-256 and Copy, and the steps), or a
// card saying it is not here yet; Google Play and the iPhone app as Soon (no link, not focusable) until
// FORGE_PLAY_URL and FORGE_IOS_URL are set, then links; the web app always. An iPhone is never offered an
// APK or any other Android way. An event pass in the address goes into Open Forge. Nothing is asked of
// another site, the page's policy refuses nothing, and nothing is logged as an error.
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';
const ANDROID = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, userAgent: ANDROID_UA };
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

/** The page on this phone, once its cards are drawn. */
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
  await page.waitForSelector('#downloadBody:not([aria-busy])');
  return { page, errors, away, close: () => ctx.close() };
}

/** The ways in the order the page shows them: the lead, then Other ways. */
const plan = (page: Page) => page.getAttribute('#downloadBody', 'data-plan');

/** Each card: its way, its state, whether it is a link (and where), whether it can be focused, its tag. */
const cards = (page: Page) =>
  page.$$eval('[data-way]', (xs) =>
    Object.fromEntries(
      xs.map((x) => [
        x.getAttribute('data-way'),
        {
          state: x.getAttribute('data-state'),
          tag: x.tagName.toLowerCase(),
          href: x.getAttribute('href'),
          disabled: x.getAttribute('aria-disabled'),
          focusable: (x as HTMLElement).tabIndex >= 0 || x.querySelectorAll('a[href], button, [tabindex]').length > 0,
          soon: x.querySelector('.soon')?.textContent ?? null,
          icon: !!x.querySelector('svg'),
          other: !!x.closest('#downloadOther'),
        },
      ]),
    ),
  );

/** Sideways scroll, if any. */
const sideways = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - innerWidth);

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

describe('the /download page on Android', () => {
  it('leads with the APKs: the choice, the version, the size, the SHA-256 with Copy, and the steps', async () => {
    const { page, errors, away, close } = await open(ANDROID, both, { clipboard: true });
    try {
      expect(await page.textContent('h1')).toBe('Forge for Android');
      expect(await page.title()).toBe('Forge for Android');
      expect(await plan(page)).toBe('apk | web play iphone');
      // Android first and picked: its file, its version, size and fingerprint.
      expect(await page.textContent('#apk-android')).toBe('Android');
      expect(await page.textContent('#apk-graphene')).toBe('GrapheneOS');
      expect(await page.getAttribute('#apk-android', 'aria-checked')).toBe('true');
      expect(await page.getAttribute('#downloadApk', 'href')).toBe('/download/forge.apk');
      expect(await page.getAttribute('#downloadApk', 'download')).toBe('forge.apk');
      expect(await page.textContent('#downloadApk')).toBe('Download the app, 0.3 MB');
      expect(await page.textContent('#apkSub')).toBe('Forge · Version 1.2.3');
      expect((await page.textContent('#downloadHash'))!.replaceAll(' ', '')).toBe(hex(apk));
      expect(await page.locator('#downloadHash span').count()).toBe(8);
      expect(await page.locator('#downloadSteps li').count()).toBe(4);
      expect(await page.locator('#downloadSteps li svg').count()).toBe(4);
      expect(await page.textContent('#way-apk .tag-ready')).toBe('Ready');
      // The file is the one the page names.
      const got = await page.evaluate(async () => {
        const r = await fetch('/download/forge.apk');
        return { type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
      });
      expect(got).toEqual({ type: 'application/vnd.android.package-archive', size: apk.length });

      // Copy puts the fingerprint, without its spaces, on the clipboard, and says so.
      await page.click('#downloadCopy');
      await expect.poll(() => page.textContent('#downloadCopy')).toBe('Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(hex(apk));
      expect(await page.textContent('#downloadCopied')).toBe('Copied');

      // The info under each choice shows only when asked for.
      expect(await page.isVisible('#downloadAbout')).toBe(false);
      await page.click('#apk-graphene-info');
      expect(await page.textContent('#downloadAbout')).toBe('Forge Private Voice. For GrapheneOS: it turns your voice into words on the phone. A bigger file.');
      expect(await page.getAttribute('#apk-graphene-info', 'aria-expanded')).toBe('true');
      await page.click('#apk-graphene-info');
      expect(await page.isVisible('#downloadAbout')).toBe(false);

      // GrapheneOS picked: Forge Private Voice's file, version, size and fingerprint; Copy copies that one.
      await page.click('#apk-graphene');
      expect(await page.getAttribute('#apk-graphene', 'aria-checked')).toBe('true');
      expect(await page.getAttribute('#apk-android', 'aria-checked')).toBe('false');
      expect(await page.getAttribute('#downloadApk', 'href')).toBe('/download/forge-private-voice.apk');
      expect(await page.getAttribute('#downloadApk', 'download')).toBe('forge-private-voice.apk');
      expect(await page.textContent('#downloadApk')).toBe('Download the app, 0.7 MB');
      expect(await page.textContent('#apkSub')).toBe('Forge Private Voice · Version 1.2.3');
      expect((await page.textContent('#downloadHash'))!.replaceAll(' ', '')).toBe(hex(pv));
      await page.click('#downloadCopy');
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(hex(pv));
      // The arrow keys move along the choice, as in any radio group.
      await page.focus('#apk-graphene');
      await page.keyboard.press('ArrowLeft');
      expect(await page.getAttribute('#apk-android', 'aria-checked')).toBe('true');
      expect(await page.evaluate(() => document.activeElement?.id)).toBe('apk-android');

      // Other ways: the web app (a link), Google Play and the iPhone app as Soon.
      const c = await cards(page);
      expect(c.web).toMatchObject({ state: 'ready', tag: 'a', href: '/v2/', other: true, icon: true });
      expect(c.play).toMatchObject({ state: 'soon', tag: 'div', href: null, disabled: 'true', focusable: false, soon: 'Soon', other: true, icon: true });
      expect(c.iphone).toMatchObject({ state: 'soon', tag: 'div', href: null, disabled: 'true', focusable: false, soon: 'Soon', other: true, icon: true });
      expect(await page.textContent('#otherHead')).toBe('Other ways');
      expect(await page.getAttribute('[data-way=play]', 'aria-label')).toBe('Google Play, Soon');
      expect(await page.getAttribute('[data-way=iphone]', 'aria-label')).toBe('iPhone, Soon');
      // A Soon card is quiet and still readable: its words keep 4.5:1 against the page.
      expect(await contrast(page, '[data-way=play] .way-name')).toBeGreaterThanOrEqual(4.5);
      expect(await contrast(page, '[data-way=play] .way-sub')).toBeGreaterThanOrEqual(4.5);
      // Tab never lands on a Soon card.
      const stops: string[] = [];
      for (let i = 0; i < 30; i++) {
        await page.keyboard.press('Tab');
        stops.push(await page.evaluate(() => (document.activeElement?.closest('[data-way]') as HTMLElement | null)?.dataset.way ?? document.activeElement?.id ?? ''));
      }
      expect(stops).toContain('web');
      expect(stops).not.toContain('play');
      expect(stops).not.toContain('iphone');
      // The footer goes to the privacy page.
      expect(await page.getAttribute('#footPrivacy', 'href')).toBe('/privacy');
      expect(await sideways(page)).toBe(0);
      expect(away).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('fits a 360 px phone, and every button is an icon and its words, at least 48 px to tap', async () => {
    const { page, errors, close } = await open({ ...ANDROID, viewport: { width: 360, height: 740 } }, both);
    try {
      expect(await sideways(page)).toBe(0);
      const small = await page.$$eval('a[href], button', (xs) =>
        xs
          .filter((x) => x.checkVisibility() && !x.closest('.skip'))
          .map((x) => ({ id: x.id || x.className, r: x.getBoundingClientRect(), icon: !!x.querySelector('svg'), words: (x.textContent ?? '').trim().split(/\s+/).filter(Boolean).length }))
          .filter((x) => Math.min(x.r.width, x.r.height) < 48 || (!x.icon && x.words > 1))
          .map((x) => x.id),
      );
      expect(small).toEqual([]);
      // The choice's two words show whole.
      for (const sel of ['#apk-android span', '#apk-graphene span']) expect(await page.$eval(sel, (e) => e.scrollWidth <= e.clientWidth), sel).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('with no APK on the site: the web app first, and the Android card says it is not here yet', async () => {
    const { page, errors, close } = await open(ANDROID, plain);
    try {
      expect(await page.textContent('h1')).toBe('Forge for Android');
      expect(await plan(page)).toBe('web apk | play iphone');
      expect(await page.textContent('#downloadComing')).toBe('Not on this site yet.');
      expect(await page.locator('#downloadApk').count()).toBe(0);
      expect(await page.locator('a[href$=".apk"]').count()).toBe(0);
      const c = await cards(page);
      expect(c.web).toMatchObject({ state: 'ready', tag: 'a', href: '/v2/', other: false });
      expect(c.apk).toMatchObject({ state: 'soon', tag: 'div', href: null, disabled: 'true', focusable: false, soon: 'Soon', other: false });
      expect(c.play).toMatchObject({ state: 'soon', tag: 'div', other: true });
      expect(c.iphone).toMatchObject({ state: 'soon', tag: 'div', other: true });
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('links Google Play and the iPhone app once their links are set', async () => {
    const { page, errors, close } = await open(ANDROID, linked);
    try {
      expect(await plan(page)).toBe('apk play | web iphone');
      const c = await cards(page);
      expect(c.play).toMatchObject({ state: 'ready', tag: 'a', href: PLAY, other: false, soon: null });
      expect(c.iphone).toMatchObject({ state: 'ready', tag: 'a', href: TESTFLIGHT, other: true, soon: null });
      expect(await page.textContent('#downloadPlay .way-name')).toBe('Google Play');
      expect(await page.textContent('#downloadIos .way-sub')).toBe('TestFlight');
      // One APK: no choice to make.
      expect(await page.locator('.apk-pick').count()).toBe(0);
      expect(await page.textContent('#apkSub')).toBe('Forge · Version 1.2.3');
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('carries an event pass from its address into Open Forge, as /j does', async () => {
    const { page, errors, close } = await open(ANDROID, both, { hash: '#pass-AbCd1234_efgh' });
    try {
      expect(await page.getAttribute('#openWeb', 'href')).toBe('/v2/#join=pass-AbCd1234_efgh');
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
    // Something that is not a pass is left out.
    const other = await open(ANDROID, both, { hash: '#<b>' });
    expect(await other.page.getAttribute('#openWeb', 'href')).toBe('/v2/');
    await other.close();
  }, 60_000);
});

describe('the /download page on an iPhone', () => {
  it('no iPhone app yet: the web app with the Home Screen steps, the iPhone app as Soon, and nothing for Android', async () => {
    const { page, errors, close } = await open(IPHONE, both, { hash: '#join=pass-AbCd1234_efgh' });
    try {
      expect(await page.textContent('h1')).toBe('Forge for iPhone');
      expect(await page.title()).toBe('Forge for iPhone');
      expect(await page.getAttribute('#downloadBody', 'data-offer')).toBe('addHome');
      expect(await plan(page)).toBe('web iphone |');
      // Open Forge first (with the pass), then Share and Add to Home Screen.
      expect(await page.getAttribute('#addHomeOpen', 'href')).toBe('/v2/#join=pass-AbCd1234_efgh');
      expect(await page.$$eval('#addHome .add-home-step', (xs) => xs.map((x) => (x.textContent ?? '').trim()))).toEqual(['Open Forge', 'Share', 'Add to Home Screen']);
      const c = await cards(page);
      expect(Object.keys(c).sort()).toEqual(['iphone', 'web']);
      expect(c.iphone).toMatchObject({ state: 'soon', tag: 'div', href: null, disabled: 'true', focusable: false, soon: 'Soon' });
      // The site has two APKs; the iPhone is offered none, and no Android way at all.
      expect(await page.locator('#downloadApk, .apk-pick, [data-way=apk], [data-way=play], #downloadOther').count()).toBe(0);
      expect(await page.locator('a[href$=".apk"]').count()).toBe(0);
      expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Android|Google/);
      expect(await sideways(page)).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('with the iPhone app\'s link: that link first, then Open Forge; still no Android way', async () => {
    const { page, errors, close } = await open(IPHONE, linked);
    try {
      expect(await page.getAttribute('#downloadBody', 'data-offer')).toBe('link');
      expect(await plan(page)).toBe('iphone web |');
      const c = await cards(page);
      expect(c.iphone).toMatchObject({ state: 'ready', tag: 'a', href: TESTFLIGHT });
      expect(c.web).toMatchObject({ state: 'ready', tag: 'a', href: '/v2/' });
      expect(await page.locator('#addHome').count()).toBe(0);
      expect(await page.locator('[data-way=play], [data-way=apk]').count()).toBe(0);
      expect(await page.evaluate(() => document.body.innerText)).not.toMatch(/Android|Google/);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);
});

describe('the /download page on a computer', () => {
  it('Get Forge: the APK card on the left, the web app and the other ways beside it', async () => {
    const { page, errors, away, close } = await open(DESKTOP, linked, { still: false });
    try {
      expect(await page.textContent('h1')).toBe('Get Forge');
      // After the way in (the cards rise into place).
      await page.evaluate(() => Promise.all(document.getAnimations().map((x) => x.finished)));
      expect(await plan(page)).toBe('web apk | play iphone');
      const main = (await page.locator('.dl-main').boundingBox())!;
      const web = (await page.locator('#openWeb').boundingBox())!;
      expect(web.x).toBeGreaterThan(main.x + main.width);
      expect(Math.abs(web.y - main.y)).toBeLessThan(2);
      const c = await cards(page);
      expect(c.play).toMatchObject({ state: 'ready', href: PLAY });
      expect(c.iphone).toMatchObject({ state: 'ready', href: TESTFLIGHT });
      // The four steps side by side.
      const tops = await page.$$eval('#downloadSteps li', (xs) => xs.map((x) => Math.round(x.getBoundingClientRect().top)));
      expect(new Set(tops).size).toBe(1);
      expect(await sideways(page)).toBe(0);
      expect(away).toEqual([]);
      expect(errors).toEqual([]);
    } finally {
      await close();
    }
  }, 60_000);

  it('takes the look this phone keeps from the app', async () => {
    const light = { look: 'light', scheme: 'light', tokens: LIGHT };
    const { page, errors, close } = await open(ANDROID, both, { look: light });
    try {
      expect(await page.getAttribute('html', 'data-scheme')).toBe('light');
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim())).toBe(LIGHT.bg);
      expect(await contrast(page, '[data-way=play] .way-name')).toBeGreaterThanOrEqual(4.5);
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
