import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// More, Privacy in the v2 app on the website (Google Play asks for the privacy policy inside the app):
// a row like its neighbours, the shield and the one word Privacy, 48 px or more to tap. It is a link to
// /privacy on this site that opens beside the app, and nothing asks for the page before the tap. In the
// Android and iPhone apps the same row goes to Forge's engine's page (android.ui.test.ts).
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

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

describe('More, Privacy', () => {
  it('opens the privacy page beside the app, and asks for nothing before the tap', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    const errors: string[] = [];
    const asked: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    ctx.on('request', (r) => asked.push(new URL(r.url()).pathname));
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.click('#btn-more');
    await page.waitForSelector('#moreSheet');
    const row = page.locator('#morePrivacy');
    // A row like its neighbours: the shield, one word, the outside-link picture; under Erase's neighbour.
    expect(await row.textContent()).toBe('Privacy');
    expect(await row.locator('svg').count()).toBe(2);
    expect(await row.locator('[data-icon=shield]').count()).toBe(1);
    expect(await page.$$eval('#moreSheet .row', (xs) => xs.map((x) => x.id).slice(-3))).toEqual(['moreIntro', 'morePrivacy', 'moreErase']);
    const box = (await row.boundingBox())!;
    expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(48);
    expect(await row.evaluate((a) => getComputedStyle(a).textDecorationLine)).toBe('none');
    // A link to this site's page, beside the app.
    expect(await row.getAttribute('href')).toBe('/privacy');
    expect(await row.getAttribute('target')).toBe('_blank');
    expect(await row.getAttribute('rel')).toBe('noopener');
    expect(asked.filter((p) => p.startsWith('/privacy'))).toEqual([]);
    // The tap opens it in a new tab; the app stays where it was.
    const [tab] = await Promise.all([ctx.waitForEvent('page'), row.click()]);
    await tab.waitForLoadState();
    expect(new URL(tab.url()).pathname).toBe('/privacy');
    expect(await tab.textContent('h1')).toBe('Privacy');
    expect(new URL(page.url()).pathname).toBe('/v2/');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
