import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Share unseen on a wide crowd photo in a phone-sized Chrome: the face finder looks in tiles enlarged
// 1.6 times, so the faces 15 to 40 pixels tall in the 1280 px protest photo are covered (the finder
// before found none of them). The spots it was not sure of are offered as blocks to add with one tap.
// The faces are those marked by hand in test/unit/fixtures/photos/crowd/faces.json.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const CROWD = resolve(import.meta.dirname, '../unit/fixtures/photos/crowd');
const WIDE = readFileSync(resolve(CROWD, 'protest-wide.jpg'));
const MARKS: [number, number, number, number][] = JSON.parse(readFileSync(resolve(CROWD, 'faces.json'), 'utf8')).photos['protest-wide.jpg'].faces;
const COVERS: any = await import('../../public/v2/core/covers.js' as string);

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

/** The covers on the photo, as the screen holds them (photo.ui.test.ts reads them the same way). */
const blocks = (page: import('playwright-core').Page) =>
  page.locator('#coverLayer .cover-box').evaluateAll((n) =>
    n.map((x) => {
      const num = (a: string) => x.getAttribute(a)?.split(',').map(Number);
      const [bx, by, bw, bh] = num('data-box')!;
      const e = num('data-ellipse');
      return { kind: x.getAttribute('data-kind')!, x: bx!, y: by!, w: bw!, h: bh!, ...(e ? { shape: 'ellipse', cx: e[0], cy: e[1], rx: e[2], ry: e[3] } : {}) };
    }),
  );

/** How much of the marked face [x, y, w, h] is under the covers. */
function under(covers: any[], [x, y, w, h]: [number, number, number, number]) {
  const mask: Uint8Array = COVERS.coverMask(covers, 1280, 853);
  let n = 0;
  for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) n += mask[yy * 1280 + xx]!;
  return n / (w * h);
}

describe('Share unseen on a crowd photo', () => {
  it('covers the small faces of a wide protest photo, and covers the spots it was not sure of with one tap', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${g.url}/v2/#/photo`);
    await page.waitForSelector('[data-screen=photo]');
    await page.setInputFiles('#photoFile', { name: 'IMG_0618.jpg', mimeType: 'image/jpeg', buffer: WIDE });
    await page.waitForSelector('#photoChanges', { timeout: 90_000 });
    expect(await page.getAttribute('#photoStage', 'data-size')).toBe('1280x853');

    // Every face of a person near the front (20 pixels tall or more) is under a cover, and all but one at
    // most of the smaller ones behind: 90% of each marked face under covers.
    const found = await blocks(page);
    const faces = found.filter((b) => b.kind === 'face');
    const missed = MARKS.filter((m) => under(faces, m) < 0.9);
    expect(missed.filter((m) => m[3] >= 20), JSON.stringify(missed)).toEqual([]);
    expect(missed.length, JSON.stringify(missed)).toBeLessThanOrEqual(1);
    const rows = await page.locator('#photoChanges .change-row').evaluateAll((n) => n.map((x) => [x.querySelector('span')!.textContent, x.getAttribute('data-state')]));
    expect(rows).toContainEqual([`${faces.length} faces`, 'covered']);

    // The spots it was not sure of: a line that small faces can be missed and one button to cover them,
    // which adds them as the person's own blocks and goes away.
    await page.waitForSelector('#photoMaybeBox:not([hidden])');
    expect(await page.textContent('#photoMaybe .say-head')).toBe('Small faces can be missed.');
    const label = (await page.textContent('#photoCoverMaybe'))!;
    const n = Number(/Cover (\d+) more/.exec(label)?.[1]);
    expect(n).toBeGreaterThan(0);
    await page.click('#photoCoverMaybe');
    expect(await page.isHidden('#photoMaybeBox')).toBe(true);
    const after = await blocks(page);
    expect(after.length).toBe(found.length + n);
    expect(after.filter((b) => b.kind === 'mine')).toHaveLength(n);
    const rows2 = await page.locator('#photoChanges .change-row').evaluateAll((r) => r.map((x) => x.querySelector('span')!.textContent));
    expect(rows2).toContain(n === 1 ? '1 block you added' : `${n} blocks you added`);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
