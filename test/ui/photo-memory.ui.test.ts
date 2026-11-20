import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// What Share unseen keeps once a photo is checked, in a phone-sized Chrome. On a Galaxy A16 the app held
// 346 MB of graphics memory after Share unseen, and taps seemed to go unanswered. In desktop Chrome the
// face finder's TensorFlow.js kept about 220 MB of textures on the graphics chip after one 2,048 pixel
// photo, and never gave them back. These tests check that it gives them back, that no canvas the app made
// for the checks still holds pixels, and that Share, Ask about it, Save and Another photo show as not
// ready while one of them runs.
//
// The graphics chip test needs WebGL. Chrome on a machine with no graphics chip (the Linux image of
// scripts/ui-linux.sh and CI) draws WebGL in software only when it is asked to, so Chrome is started with
// --enable-unsafe-swiftshader: there the same TensorFlow.js code runs on SwiftShader. If WebGL still
// cannot start, the face finder runs on the processor, and that test is skipped and says so.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const CREW = readFileSync(resolve(import.meta.dirname, '../unit/fixtures/photos/crew.jpg'));
const TF = '/vendor/face-api/face-api.js';
/** TensorFlow.js as the face filter has it: the same address, so the same module. Vitest would rewrite a plain import() here. */
const tfOf = `(async () => (await new Function('s', 'return import(s)')('${TF}')).tf)()`;

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

/**
 * Share unseen on a phone, with every canvas the page makes recorded (where it was made, and the canvas
 * itself, held weakly), and a share sheet that answers only when the test lets it (window.__answer()).
 */
async function phone() {
  const ctx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
  await pastFirstRun(ctx);
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__canvases = [];
    const make = Document.prototype.createElement;
    Document.prototype.createElement = function (this: Document, name: string, ...rest: any[]) {
      const e = (make as any).call(this, name, ...rest);
      if (String(name).toLowerCase() === 'canvas') w.__canvases.push({ ref: new WeakRef(e), from: new Error().stack ?? '' });
      return e;
    } as typeof make;
    w.__shared = 0;
    Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: () =>
        new Promise<void>((done) => {
          w.__answer = () => ((w.__shared += 1), done());
        }),
    });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${g.url}/v2/#/photo`);
  await page.waitForSelector('[data-screen=photo]');
  // The face finder starts loading 300 ms after the screen opens (prepare): its model is in once it holds tensors.
  await expect.poll(async () => (await tfState(page)).tensors, { timeout: 30_000 }).toBeGreaterThan(0);
  return { ctx, page, errors };
}

/** TensorFlow.js's backend and memory, and what its WebGL texture manager holds, in bytes. */
const tfState = (page: Page) =>
  page.evaluate(async (src) => {
    const tf: any = await eval(src);
    const m = tf.memory();
    return { backend: tf.getBackend() as string, tensors: m.numTensors as number, inUse: (m.numBytesInGPU ?? 0) as number, held: (m.numBytesInGPUAllocated ?? 0) as number, kept: (m.numBytesInGPUFree ?? 0) as number };
  }, tfOf);

/** The canvases the app's own code made (not TensorFlow.js's) that still hold pixels: [width, height, shown]. */
const fullCanvases = (page: Page) =>
  page.evaluate(() =>
    (window as any).__canvases
      .filter((c: any) => !c.from.includes('/vendor/'))
      .map((c: any) => c.ref.deref())
      .filter((e: any) => e && e.width * e.height > 0)
      .map((e: any) => [e.width, e.height, e.isConnected]),
  );

async function check(page: Page) {
  await page.setInputFiles('#photoFile', { name: 'IMG_2041.jpg', mimeType: 'image/jpeg', buffer: CREW });
  await page.waitForSelector('#photoChanges', { timeout: 90_000 });
}

describe('Share unseen lets go of what the checks used', () => {
  it('gives back the textures the face finder kept on the graphics chip once the photo is checked', async ({ skip }) => {
    const { ctx, page, errors } = await phone();
    const before = await tfState(page);
    if (before.backend !== 'webgl') {
      await ctx.close();
      skip(`no WebGL in this Chrome: the face finder runs on ${before.backend}`);
    }
    // Notes whether a texture was deleted with no WebGL commands sent after it: such a texture stays on the chip.
    await page.evaluate(async (src) => {
      const gl: any = (await eval(src)).backend().gpgpu.gl;
      const w = window as any;
      w.__unsent = false;
      const wrap = (name: string, unsent: boolean) => {
        const f = gl[name].bind(gl);
        gl[name] = (...a: unknown[]) => {
          w.__unsent = unsent;
          return f(...a);
        };
      };
      wrap('deleteTexture', true);
      wrap('flush', false);
      wrap('finish', false);
    }, tfOf);
    await check(page);
    expect(await page.evaluate(() => (window as any).__unsent)).toBe(false);
    // Faces were found, so the finder did run on the graphics chip.
    expect(await page.locator('#coverLayer .cover-box[data-kind=face]').count()).toBeGreaterThanOrEqual(3);
    const after = await tfState(page);
    // Only the model's weights (about 0.2 MB) stay; nothing is kept to use again. Before the fix about
    // 230 MB stayed kept after this photo (looked at twice its size, in tiles).
    expect(after.kept).toBe(0);
    expect(after.held).toBe(after.inUse);
    expect(after.held).toBeLessThan(1 << 20);
    expect(after.tensors).toBe(before.tensors);
    // A second photo: the same again, whatever the first one left.
    await page.click('#photoAnother');
    await check(page);
    const again = await tfState(page);
    expect(again.kept).toBe(0);
    expect(again.held).toBeLessThan(1 << 20);
    expect(again.tensors).toBe(before.tensors);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('keeps no canvas of the checks, no picture of the last photo after Another photo, and no tensor', async () => {
    const { ctx, page, errors } = await phone();
    const before = await tfState(page);
    await check(page);
    // The photo's own canvas and the one on the screen; the parts the face finder looked at are emptied.
    const kept = await fullCanvases(page);
    expect(kept.sort()).toEqual([
      [960, 754, false],
      [960, 754, true],
    ]);
    expect((await tfState(page)).tensors).toBe(before.tensors);
    // Back to Take or pick a photo: nothing of that photo is held for the screen.
    await page.click('#photoAnother');
    await page.waitForSelector('#photoTake');
    expect(await fullCanvases(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('shows Share, Ask about it, Save and Another photo as not ready while Share is under way', async () => {
    const { ctx, page, errors } = await phone();
    await check(page);
    const ids = ['#photoShare', '#photoAsk', '#photoSave', '#photoAnother'];
    const disabled = () => page.evaluate((ids) => ids.map((id) => (document.querySelector(id) as HTMLButtonElement).disabled), ids);
    expect(await disabled()).toEqual([false, false, false, false]);
    await page.tap('#photoShare');
    // The share sheet is up (it has not answered): the four buttons show they cannot act yet.
    await page.waitForFunction(() => typeof (window as any).__answer === 'function');
    expect(await disabled()).toEqual([true, true, true, true]);
    // The sheet answers: they are ready again, and the photo went out once.
    await page.evaluate(() => (window as any).__answer());
    await expect.poll(disabled).toEqual([false, false, false, false]);
    expect(await page.evaluate(() => (window as any).__shared)).toBe(1);
    // A second Share opens the sheet again: the first tap is answered.
    await page.evaluate(() => delete (window as any).__answer);
    await page.tap('#photoShare');
    await page.waitForFunction(() => typeof (window as any).__answer === 'function');
    await page.evaluate(() => (window as any).__answer());
    await expect.poll(() => page.evaluate(() => (window as any).__shared)).toBe(2);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
