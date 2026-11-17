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

// The rings keep their place when Add or More opens (owner, 2026-11-17: "when pressing the add button, the
// big mic button moves down a bit"). The bottom row stays in the page while a sheet is open; taken out of
// it, its height went to the stage and the rings slid down by half of it or more. Measured in Default and
// in Playful, on the two phones and on a laptop-sized window.
describe('the rings keep their place under the sheets', () => {
  const VIEWS = [...SIZES.map((s) => ({ ...s, touch: true })), { width: 1280, height: 800, touch: false }];
  for (const v of VIEWS) {
    it(`Add and More leave the rings where they were (${v.width} by ${v.height})`, async () => {
      const ctx = await browser.newContext({ viewport: { width: v.width, height: v.height }, isMobile: v.touch, hasTouch: v.touch, deviceScaleFactor: 2 });
      await pastFirstRun(ctx);
      const page = await ctx.newPage();
      for (const mode of ['default', 'playful']) {
        if (mode === 'playful') {
          await page.goto(`${g.url}/v2/#/more/look`);
          await page.waitForSelector('[data-screen=look]');
          await page.click('#mode-playful');
          await expect.poll(() => page.getAttribute('#mode-playful', 'aria-checked')).toBe('true');
          // The helper's home, not the cover game it opens on by default (docs/PLAYFUL.md).
          if ((await page.getAttribute('#gameFirst', 'aria-checked')) === 'true') await page.click('#gameFirst');
          await expect.poll(() => page.getAttribute('#gameFirst', 'aria-checked')).toBe('false');
          // The mode applies at once: no reload, which could come before the settings are stored.
          await page.goto(`${g.url}/v2/#/`);
          await page.waitForSelector('[data-screen=home][data-mode=playful]');
        } else {
          await page.goto(`${g.url}/v2/`);
          await page.waitForSelector('[data-screen=home]');
        }
        await page.evaluate(() => document.fonts.ready);
        await page.waitForTimeout(300);
        const at = async () => (await page.locator('.rings').first().boundingBox())!;
        const row = async () => (await page.locator('.bottom-row').boundingBox())!;
        const before = await at();
        const rowBefore = await row();
        for (const name of ['add', 'more']) {
          await page.click(`#btn-${name}`);
          await page.waitForSelector('.float-wrap .float-card');
          await page.waitForTimeout(300);
          const open = await at();
          expect(Math.abs(open.y - before.y), `${mode}, ${name} open: the rings moved down or up`).toBeLessThanOrEqual(1);
          expect(Math.abs(open.x - before.x), `${mode}, ${name} open: the rings moved sideways`).toBeLessThanOrEqual(1);
          expect(Math.abs((await row()).y - rowBefore.y), `${mode}, ${name} open: the bottom row moved`).toBeLessThanOrEqual(1);
          // The sheet's card lines up with the row under it.
          const card = (await page.locator('.float-card').boundingBox())!;
          expect(Math.abs(card.x - rowBefore.x), `${mode}, ${name}: the sheet is not over the row`).toBeLessThanOrEqual(1);
          expect(Math.abs(card.width - rowBefore.width), `${mode}, ${name}: the sheet is wider or narrower than the row`).toBeLessThanOrEqual(1);
          // Close is on top of the sheet's layer, where the finger is.
          const onTop = await page.evaluate((n) => {
            const r = document.querySelector(`#btn-${n}`)!.getBoundingClientRect();
            return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(`#btn-${n}`);
          }, name);
          expect(onTop, `${mode}, ${name}: Close is under the sheet`).toBe(true);
          await page.click(`#btn-${name}`);
          await page.waitForSelector('.float-wrap', { state: 'detached' });
          await page.waitForTimeout(300);
          const after = await at();
          expect(Math.abs(after.y - before.y), `${mode}, ${name} closed: the rings did not come back`).toBeLessThanOrEqual(1);
        }
      }
      await ctx.close();
    }, 90_000);
  }
});
