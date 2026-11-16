import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, startGateway } from '../e2e/helpers.ts';

// The API guide at /docs/ in a real browser: readable on a 360 px phone with no sideways scroll (code
// blocks and tables scroll inside themselves), the section menu opens and closes, copy buttons copy, and
// on a wide screen the nav sits on the left and follows the section being read.
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

async function open(viewport: { width: number; height: number }, mobile: boolean, path = '/docs/'): Promise<Page> {
  // Reduced motion: anchor jumps land at once instead of scrolling smoothly down a long page.
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${g.url}${path}`);
  await page.waitForLoadState('networkidle');
  expect(errors).toEqual([]);
  return page;
}

const sidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

describe('API guide in a browser', () => {
  it('fits a 360 px phone, with the section menu and copy buttons working', async () => {
    const page = await open({ width: 360, height: 740 }, true);
    expect(await page.evaluate(() => document.fonts.check('16px Inter'))).toBe(true);
    expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
    // Long code scrolls inside its block, never the page.
    await page.locator('#post-v1-chat-completions').scrollIntoViewIfNeeded();
    expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);

    const menu = page.locator('.menu-btn');
    await expect.poll(() => page.locator('#toc').isVisible()).toBe(false);
    await menu.click();
    expect(await menu.getAttribute('aria-expanded')).toBe('true');
    expect(await page.locator('#toc').isVisible()).toBe(true);
    await page.locator('#toc a[href="#errors"]').click();
    expect(await page.locator('#toc').isVisible()).toBe(false);
    expect(await menu.getAttribute('aria-expanded')).toBe('false');
    await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('errors')!.getBoundingClientRect().top))).toBeLessThan(200);

    const first = page.locator('.code').first();
    await first.locator('.copy').click();
    await expect.poll(() => first.locator('.copy').textContent()).toBe('Copied');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toBe(await first.locator('pre code').textContent());
    expect(copied).toContain('curl -s https://ai.forge-reserve.com/v1/models');
    await page.context().close();
  });

  it('shows the nav on the left of a wide screen and marks the section being read', async () => {
    const page = await open({ width: 1280, height: 800 }, false);
    expect(await page.locator('#toc').isVisible()).toBe(true);
    expect(await page.locator('.menu-btn').isVisible()).toBe(false);
    const side = await page.locator('#toc').boundingBox();
    const main = await page.locator('#content').boundingBox();
    expect(side!.x + side!.width).toBeLessThanOrEqual(main!.x + 1);
    await page.locator('#toc a[href="#rate-limits"]').click();
    await expect.poll(() => page.locator('#toc a[aria-current="true"]').getAttribute('href')).toBe('#rate-limits');
    // Every heading has its own link.
    const heads = await page.locator('.doc :is(h2, h3, h4)[id]').count();
    expect(await page.locator('.doc :is(h2, h3, h4)[id] > a.anchor').count()).toBe(heads);
    expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });
});

// The module guide (/docs/modules/) is built by the same script into the same page shell.
describe('module guide in a browser', () => {
  it.each(['/docs/modules/', '/docs/modules/fund', '/docs/modules/first-module', '/docs/modules/list'])('%s fits a 360 px phone, with the section menu and copy buttons working', async (path) => {
    const page = await open({ width: 360, height: 740 }, true, path);
    expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
    // Wide tables and long code scroll inside themselves, never the page.
    for (const sel of ['.table-wrap', '.code']) {
      const n = await page.locator(sel).count();
      for (let i = 0; i < n; i++) await page.locator(sel).nth(i).scrollIntoViewIfNeeded();
      expect(await sidewaysScroll(page), sel).toBeLessThanOrEqual(0);
    }
    const menu = page.locator('.menu-btn');
    expect(await page.locator('#toc').isVisible()).toBe(false);
    await menu.click();
    expect(await page.locator('#toc').isVisible()).toBe(true);
    // The menu holds the list of pages, this one marked, and this page's sections.
    expect(await page.locator('#toc .pages a[aria-current="page"]').getAttribute('href')).toBe(path);
    expect(await page.locator('#toc .pages a').count()).toBe(11);
    const first = page.locator('#toc nav[aria-label="Sections"] a').first();
    const target = (await first.getAttribute('href'))!;
    await first.click();
    expect(await page.locator('#toc').isVisible()).toBe(false);
    await expect.poll(() => page.evaluate((id) => Math.round(document.getElementById(id)!.getBoundingClientRect().top), target.slice(1))).toBeLessThan(200);

    // The module list has tables and no code; every other page has code to copy.
    if (path !== '/docs/modules/list') {
      const code = page.locator('.code').first();
      await code.scrollIntoViewIfNeeded();
      await code.locator('.copy').click();
      await expect.poll(() => code.locator('.copy').textContent()).toBe('Copied');
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(await code.locator('pre code').textContent());
    }
    await page.context().close();
  });

  it('shows the pages and the sections on the left of a wide screen, and moves between pages', async () => {
    const page = await open({ width: 1280, height: 800 }, false, '/docs/modules/');
    expect(await page.locator('#toc').isVisible()).toBe(true);
    expect(await page.locator('.menu-btn').isVisible()).toBe(false);
    const side = await page.locator('#toc').boundingBox();
    const main = await page.locator('#content').boundingBox();
    expect(side!.x + side!.width).toBeLessThanOrEqual(main!.x + 1);
    await page.locator('#toc a[href="#what-is-built-and-what-is-designed"]').click();
    await expect.poll(() => page.locator('#toc a[aria-current="true"]').getAttribute('href')).toBe('#what-is-built-and-what-is-designed');
    const heads = await page.locator('.doc :is(h2, h3, h4)[id]').count();
    expect(await page.locator('.doc :is(h2, h3, h4)[id] > a.anchor').count()).toBe(heads);
    // A link to another page, and a link to a heading on another page.
    await page.locator('#toc .pages a[href="/docs/modules/fund"]').click();
    await page.waitForURL(`${g.url}/docs/modules/fund`);
    expect(await page.locator('h1').textContent()).toContain('Fund modules');
    await page.locator('.doc a[href="/docs/modules/list#fund"]').first().click();
    await page.waitForURL(`${g.url}/docs/modules/list#fund`);
    await expect.poll(() => page.evaluate(() => Math.round(document.getElementById('fund')!.getBoundingClientRect().top))).toBeLessThan(200);
    expect(await sidewaysScroll(page)).toBeLessThanOrEqual(0);
    await page.context().close();
  });

  it('the API guide lists the module pages', async () => {
    const page = await open({ width: 1280, height: 800 }, false);
    expect(await page.locator('#toc .pages a[aria-current="page"]').getAttribute('href')).toBe('/docs/');
    await page.locator('#toc .pages a[href="/docs/modules/first-module"]').click();
    await page.waitForURL(`${g.url}/docs/modules/first-module`);
    expect(await page.locator('h1').textContent()).toContain('Write your first module');
    await page.context().close();
  });
});
