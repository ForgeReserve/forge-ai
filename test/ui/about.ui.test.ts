import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, startGateway } from '../e2e/helpers.ts';

// The landing page at /about in a real browser: it fits a 320 px phone with no sideways scroll, the three
// actions sit at the top right and go where they say, the download buttons show Soon while their links
// are empty and become links once set, the phone pictures load, and nothing is asked of another site.
let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  g = await startGateway();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

interface Opened {
  page: Page;
  errors: string[];
  /** Every request to another origin. */
  away: string[];
}

async function open(width: number, { links }: { links?: Record<string, string> } = {}): Promise<Opened> {
  const mobile = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height: mobile ? 740 : 900 }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const away: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A file the page's policy refused shows here too.
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== g.url) away.push(r.url());
  });
  if (links)
    await page.route('**/about/', async (route) => {
      const res = await route.fetch();
      let body = await res.text();
      for (const [k, v] of Object.entries(links)) body = body.replace(`data-download="${k}" data-href=""`, `data-download="${k}" data-href="${v}"`);
      await route.fulfill({ response: res, body });
    });
  // The page at /about/, through the move from /about (a moved request is not routed, so a test that changes the page opens /about/).
  await page.goto(`${g.url}${links ? "/about/" : "/about"}`);
  await page.waitForLoadState('networkidle');
  // Bring every lazy picture in.
  await page.evaluate(async () => {
    for (const img of document.querySelectorAll('img')) {
      img.scrollIntoView();
      await img.decode().catch(() => {});
    }
    window.scrollTo(0, 0);
  });
  return { page, errors, away };
}

/** How far the page reaches past the right edge of the screen, by its width and by any one element. */
const overflow = (page: Page) =>
  page.evaluate(() => {
    const w = window.innerWidth;
    let worst = document.documentElement.scrollWidth - w;
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (r.width && r.height) worst = Math.max(worst, Math.round(r.right - w), Math.round(-r.left));
    }
    return worst;
  });

describe('the landing page in a browser', () => {
  it.each([320, 390])('fits a %i px phone with its actions in the top right', async (width) => {
    const { page, errors, away } = await open(width);
    expect(new URL(page.url()).pathname).toBe('/about/');
    expect(await page.title()).toBe('Forge AI, private AI for activists');
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(await page.evaluate(() => document.fonts.check('16px Inter'))).toBe(true);

    // The three actions: in the bar at the top, at its right, each at least 48 px to tap.
    const bar = (await page.locator('header.top').boundingBox())!;
    expect(bar.y).toBe(0);
    const brand = (await page.locator('.brand').boundingBox())!;
    const targets = { '#topOpen': '/v2/', '#topDownload': '#download', '#topCode': 'https://github.com/ForgeReserve/forge-ai' };
    for (const [sel, href] of Object.entries(targets)) {
      expect(await page.getAttribute(sel, 'href'), sel).toBe(href);
      const box = (await page.locator(sel).boundingBox())!;
      expect(box.y + box.height, sel).toBeLessThanOrEqual(bar.y + bar.height);
      expect(box.x, sel).toBeGreaterThan(brand.x + brand.width);
      expect(Math.min(box.width, box.height), sel).toBeGreaterThanOrEqual(48);
    }
    const code = (await page.locator('#topCode').boundingBox())!;
    expect(width - (code.x + code.width)).toBeLessThanOrEqual(20);
    expect(await page.getAttribute('#topCode', 'aria-label')).toBe('The code on GitHub');
    expect(await page.textContent('#topOpen')).toContain('Open the app');
    expect(await page.textContent('#topDownload')).toContain('Download');

    // No link yet: each download button says Soon and goes nowhere.
    for (const sel of ['#dlAndroid', '#dlIphone']) {
      expect(await page.getAttribute(sel, 'href'), sel).toBeNull();
      expect(await page.textContent(`${sel} .soon`), sel).toBe('Soon');
      expect(await page.isVisible(`${sel} .soon`), sel).toBe(true);
    }
    expect(await page.textContent('#dlAndroid')).toContain('Android');
    expect(await page.textContent('#dlIphone')).toContain('iPhone');
    // Download in the top bar scrolls to them.
    await page.click('#topDownload');
    await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('download')!.getBoundingClientRect().top))).toBeLessThan(400);

    // Every phone picture loaded, with words for a screen reader.
    const imgs = await page.locator('img').evaluateAll((xs) => xs.map((x) => ({ w: (x as HTMLImageElement).naturalWidth, alt: x.getAttribute('alt') ?? '' })));
    expect(imgs.length).toBe(4);
    for (const i of imgs) {
      expect(i.w).toBe(600);
      expect(i.alt.length).toBeGreaterThan(20);
    }
    // Every section starts with an icon.
    expect(await page.locator('main section').evaluateAll((ss) => ss.every((s) => s.querySelector('svg')))).toBe(true);
    expect(await page.getAttribute('a[href="https://bellows.forgereserve.org"]', 'href')).toBe('https://bellows.forgereserve.org');

    expect(await overflow(page)).toBeLessThanOrEqual(0);
    expect(away).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('opens the app from Open the app', async () => {
    const { page, errors } = await open(390);
    await page.click('#heroOpen');
    await page.waitForURL(`${g.url}/v2/`);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('lays text and phone side by side on a wide screen', async () => {
    const { page, errors, away } = await open(1280);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    const text = (await page.locator('.hero-text').boundingBox())!;
    const phone = (await page.locator('.hero-phone').boundingBox())!;
    expect(phone.x).toBeGreaterThan(text.x + text.width - 1);
    expect(await page.textContent('#topOpen')).toContain('Open the app');
    const code = (await page.locator('#topCode').boundingBox())!;
    expect(1280 - (code.x + code.width)).toBeLessThanOrEqual(20);
    expect(away).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('turns a download button into a link once its link is set', async () => {
    const { page, errors } = await open(390, { links: { android: '/download/' } });
    expect(await page.getAttribute('#dlAndroid', 'href')).toBe('/download/');
    expect(await page.locator('#dlAndroid .soon').count()).toBe(0);
    expect(await page.getAttribute('#dlIphone', 'href')).toBeNull();
    expect(await page.textContent('#dlIphone .soon')).toBe('Soon');
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('takes the look this phone keeps from the app', async () => {
    const mobile = { viewport: { width: 390, height: 740 }, isMobile: true, hasTouch: true };
    const ctx = await browser.newContext(mobile);
    await ctx.addInitScript(() => localStorage.setItem('forge2.look', JSON.stringify({ look: 'light', scheme: 'light', tokens: { bg: '#F6F5F1', ink: '#14161A' } })));
    const page = await ctx.newPage();
    await page.goto(`${g.url}/about/`);
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 245, 241)');
    expect(await page.getAttribute('html', 'data-scheme')).toBe('light');
    await ctx.close();
  });
});
