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

async function open(viewport: { width: number; height: number }, mobile: boolean): Promise<Page> {
  // Reduced motion: anchor jumps land at once instead of scrolling smoothly down a long page.
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${g.url}/docs/`);
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
