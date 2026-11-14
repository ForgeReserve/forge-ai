import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Layout on small phones (first mobile feedback, 2026-11-14): the Add and More sheets cover the whole
// home, the talk button included, with Close in view without scrolling; and Type fits above the
// keyboard. The keyboard is simulated by shrinking the visual viewport (window.visualViewport is
// replaced before the app loads), the way a phone browser shrinks it when the keyboard opens without
// resizing the page.
const SIZES = [
  { width: 360, height: 640 },
  { width: 412, height: 915 },
];

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function phone(viewport: { width: number; height: number }): Promise<Page> {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pastFirstRun(ctx);
  // A visual viewport the test can shrink, as an on-screen keyboard does.
  await ctx.addInitScript(() => {
    const w = window as any;
    const vv = new EventTarget() as any;
    w.__kb = 0;
    const def = (k: string, get: () => number) => Object.defineProperty(vv, k, { get });
    def('width', () => innerWidth);
    def('height', () => innerHeight - w.__kb);
    def('offsetTop', () => 0);
    def('offsetLeft', () => 0);
    def('pageTop', () => scrollY);
    def('pageLeft', () => scrollX);
    def('scale', () => 1);
    Object.defineProperty(window, 'visualViewport', { get: () => vv });
    w.__keyboard = (h: number) => {
      w.__kb = h;
      vv.dispatchEvent(new Event('resize'));
    };
  });
  return ctx.newPage();
}

/** True when the element at the talk button's centre belongs to the open sheet. */
const sheetOnTop = (page: Page) =>
  page.evaluate(() => {
    const r = document.querySelector('#talkBtn')!.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return !!hit?.closest('.float-wrap');
  });

/** True when the element is wholly inside the visible area, given the visual viewport's height. */
const inView = (page: Page, sel: string, visibleHeight?: number) =>
  page.evaluate(
    ([s, h]) => {
      const r = document.querySelector(s as string)!.getBoundingClientRect();
      const bottom = (h as number | null) ?? window.innerHeight;
      return r.top >= 0 && r.left >= 0 && r.bottom <= bottom + 0.5 && r.right <= window.innerWidth + 0.5;
    },
    [sel, visibleHeight ?? null] as const,
  );

describe('layout on small phones', () => {
  for (const size of SIZES) {
    it(`Add and More cover the home, the talk button included, with Close in view (${size.width} by ${size.height})`, async () => {
      const page = await phone(size);
      await page.goto(`${g.url}/v2/`);
      await page.waitForSelector('[data-screen=home]');
      for (const name of ['more', 'add']) {
        await page.click(`#btn-${name}`);
        await page.waitForSelector('.float-wrap .float-card');
        expect(await page.textContent(`#btn-${name}`)).toContain('Close');
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
        expect(await sheetOnTop(page)).toBe(true);
        expect(await inView(page, `#btn-${name}`)).toBe(true);
        // Every row of the sheet can be reached: the card fits, or scrolls inside itself.
        const lastRow = page.locator('.float-card .row').last();
        await lastRow.scrollIntoViewIfNeeded();
        expect(await inView(page, `#btn-${name}`)).toBe(true);
        await page.click(`#btn-${name}`);
        await page.waitForSelector('.float-wrap', { state: 'detached' });
      }
      await page.context().close();
    }, 60_000);

    it(`Type fits above the keyboard: the field, the price line and Send stay in view (${size.width} by ${size.height})`, async () => {
      const page = await phone(size);
      await page.goto(`${g.url}/v2/#/type`);
      await page.waitForSelector('[data-screen=type]');
      const keyboard = Math.round(size.height * 0.42);
      await page.evaluate((h) => (window as any).__keyboard(h), keyboard);
      const visible = size.height - keyboard;
      await expect.poll(() => inView(page, '#sendBtn', visible)).toBe(true);
      expect(await inView(page, '#priceLine', visible)).toBe(true);
      expect(await inView(page, '#question', visible)).toBe(true);
      const field = (await page.locator('#question').boundingBox())!;
      expect(field.height).toBeGreaterThanOrEqual(48);
      // The keyboard closes: Type takes the whole screen again.
      await page.evaluate(() => (window as any).__keyboard(0));
      await expect.poll(async () => (await page.locator('#sendBtn').boundingBox())!.y).toBeGreaterThan(visible - 60);
      await page.context().close();
    }, 60_000);
  }
});
