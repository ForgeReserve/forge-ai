import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Share unseen in a phone-sized Chrome: a real photo with faces and a real phone photo with GPS, through
// the photo picker, the filters on the page, the before and after view, blocks added and taken away by
// hand, and out through a stand-in for the share sheet or as a download. The checks read the file that
// would be shared: no hidden details left, and every block solid in its pixels.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHOTOS = resolve(import.meta.dirname, '../unit/fixtures/photos');
const CREW = readFileSync(resolve(PHOTOS, 'crew.jpg'));
const SIGN = readFileSync(resolve(PHOTOS, 'sign.jpg'));
const META: any = await import('../../public/v2/core/photometa.js' as string);

// The three faces in crew.jpg (960 x 754), by their centres.
const FACES = [
  { x: 457, y: 195 },
  { x: 700, y: 344 },
  { x: 236, y: 326 },
];

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true' },
    // A standard model that reads photos, for Ask about it.
    editCatalog: (c) => c.models.push({ ...c.models.find((m: any) => m.id === 'mock-echo'), id: 'mock-see', upstream: 'mock-echo', vision: true }),
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  /** Every request the page made: [method, url]. */
  requests: [string, string][];
}

/** A phone with no balance. With `sheet`, navigator.share is a stand-in that keeps what it is given. */
async function phone({ sheet = true, workers = 'allow' as 'allow' | 'block', viewport = PHONE.viewport } = {}): Promise<Phone> {
  const ctx = await browser.newContext({ ...PHONE, viewport, acceptDownloads: true, serviceWorkers: workers });
  await pastFirstRun(ctx);
  if (sheet)
    await ctx.addInitScript(() => {
      const w = window as any;
      w.__shared = [];
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: any) => Array.isArray(d?.files) && d.files.length > 0 });
      Object.defineProperty(navigator, 'share', {
        configurable: true,
        value: async (d: any) => {
          for (const f of d.files) w.__shared.push({ name: f.name, type: f.type, bytes: Array.from(new Uint8Array(await f.arrayBuffer())) });
        },
      });
    });
  else await ctx.addInitScript(() => Object.defineProperty(navigator, 'share', { configurable: true, value: undefined }));
  const page = await ctx.newPage();
  const errors: string[] = [];
  const requests: [string, string][] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => requests.push([r.method(), r.url()]));
  return { ctx, page, errors, requests };
}

/** Opens Share unseen from Add and picks `photo`; resolves once the checks are done. */
async function pick(page: Page, name: string, buffer: Buffer) {
  await page.goto(`${g.url}/v2/`);
  await page.waitForSelector('[data-screen=home]');
  await page.click('#btn-add');
  await page.click('#addPhoto');
  await page.waitForSelector('[data-screen=photo]');
  expect(await page.textContent('[data-screen=photo]')).not.toMatch(/null|undefined/);
  await page.setInputFiles('#photoFile', { name, mimeType: 'image/jpeg', buffer });
  await page.waitForSelector('#photoChanges', { timeout: 60_000 });
}

/** The list of changes as [text, state] pairs. */
const changes = (page: Page) => page.locator('#photoChanges .change-row').evaluateAll((n) => n.map((x) => [x.querySelector('span')!.textContent, x.getAttribute('data-state')]));

/** The blocks on the photo, in its pixels, with their kind. */
const blocks = (page: Page) =>
  page.locator('#coverLayer .cover-box').evaluateAll((n) =>
    n.map((x) => {
      const [bx, by, bw, bh] = x.getAttribute('data-box')!.split(',').map(Number);
      return { kind: x.getAttribute('data-kind'), x: bx!, y: by!, w: bw!, h: bh! };
    }),
  );

/**
 * Decodes a JPEG in the page and checks each box: solid black or not. The decoder smooths colour across
 * the edge of a block (JPEG keeps colour at half size), so its outermost pixel takes a tint from the
 * pixels beside the block; the check starts 2 pixels in. What the encoder was given under a block is
 * checked exactly by the test that changes it and compares the files.
 */
async function solid(page: Page, bytes: number[], boxes: { x: number; y: number; w: number; h: number }[]) {
  return page.evaluate(
    async ({ bytes, boxes, src }) => {
      const { isFlat, alignBox } = await new Function('s', 'return import(s)')(src);
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext('2d')!;
      x.drawImage(bmp, 0, 0);
      const img = x.getImageData(0, 0, bmp.width, bmp.height);
      const inset = (b: any) => {
        const a = alignBox(b, bmp.width, bmp.height);
        return { x: a.x + 2, y: a.y + 2, w: a.w - 4, h: a.h - 4 };
      };
      return { width: bmp.width, height: bmp.height, flat: boxes.map((b) => isFlat(img, inset(b), [0, 0, 0], 4)) };
    },
    { bytes, boxes, src: '/v2/core/covers.js' },
  );
}

const inside = (p: { x: number; y: number }, b: { x: number; y: number; w: number; h: number }) => p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h;

/** The raw GPS latitude and longitude values (three rationals each) in a JPEG's Exif block. */
function gpsValues(jpeg: Buffer): Buffer[] {
  const t = jpeg.indexOf(Buffer.from('Exif\0\0', 'latin1')) + 6;
  const le = jpeg[t] === 0x49;
  const u16 = (o: number) => (le ? jpeg.readUInt16LE(t + o) : jpeg.readUInt16BE(t + o));
  const u32 = (o: number) => (le ? jpeg.readUInt32LE(t + o) : jpeg.readUInt32BE(t + o));
  const entries = (ifd: number) => Array.from({ length: u16(ifd) }, (_, i) => ifd + 2 + i * 12);
  const pointer = entries(u32(4)).find((e) => u16(e) === 0x8825)!;
  return entries(u32(pointer + 8))
    .filter((e) => u16(e) === 2 || u16(e) === 4)
    .map((e) => jpeg.subarray(t + u32(e + 8), t + u32(e + 8) + 24));
}
const SIGN_GPS = gpsValues(SIGN);

describe('Share unseen', () => {
  it('covers the faces, takes out the hidden details, and shares a clean file through the share sheet', async () => {
    const { ctx, page, errors, requests } = await phone();
    await pick(page, 'IMG_2041.jpg', CREW);

    // The three faces are found and covered. The original's hidden details are listed as removed.
    const found = await blocks(page);
    const faces = found.filter((b) => b.kind === 'face');
    for (const f of FACES) expect(faces.some((b) => inside(f, b)), JSON.stringify(f)).toBe(true);
    const rows = await changes(page);
    expect(rows).toContainEqual(['Which phone or camera took it', 'removed']);
    expect(rows).toContainEqual(['When it was taken', 'removed']);
    expect(rows).toContainEqual(['A small hidden copy of the picture', 'removed']);
    expect(rows).toContainEqual([`${faces.length} faces`, 'covered']);
    expect(await page.textContent('#photoMiss')).toBe('Automatic checks can miss things. Look before you share.');

    // Before shows the photo as it came in, without blocks; After shows them again.
    await page.click('#photo-before');
    expect(await page.getAttribute('#photoStage', 'data-view')).toBe('before');
    expect(await page.locator('#coverLayer .cover-box').count()).toBe(0);
    await page.click('#photo-after');
    expect(await page.locator('#coverLayer .cover-box').count()).toBe(found.length);

    // A tap on the photo adds a block there; a tap on that block takes it away. A drag covers an area.
    const box = (await page.locator('#photoCanvas').boundingBox())!;
    const at = (px: number, py: number) => ({ x: box.x + (px / 960) * box.width, y: box.y + (py / 754) * box.height });
    const corner = at(60, 60);
    await page.mouse.click(corner.x, corner.y);
    await expect.poll(async () => (await blocks(page)).filter((b) => b.kind === 'mine').length).toBe(1);
    expect(await changes(page)).toContainEqual(['1 block you added', 'covered']);
    await page.click('#coverLayer .cover-box[data-kind=mine]');
    await expect.poll(async () => (await blocks(page)).filter((b) => b.kind === 'mine').length).toBe(0);
    const a = at(820, 620);
    const b = at(930, 720);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
    const mine = (await blocks(page)).filter((x) => x.kind === 'mine');
    expect(mine).toHaveLength(1);
    expect(inside({ x: 870, y: 670 }, mine[0]!)).toBe(true);

    // Taking a face block away is listed, so the person sees that face will show.
    const first = page.locator('#coverLayer .cover-box[data-kind=face]').first();
    const taken = await first.getAttribute('data-box');
    await first.click();
    expect(await changes(page)).toContainEqual(['1 face block you took away', 'uncovered']);
    // ...and put back by hand with a drag over the same place.
    const [tx, ty, tw, th] = taken!.split(',').map(Number) as [number, number, number, number];
    const p0 = at(tx + 2, ty + 2);
    const p1 = at(tx + tw - 2, ty + th - 2);
    await page.mouse.move(p0.x, p0.y);
    await page.mouse.down();
    await page.mouse.move(p1.x, p1.y, { steps: 6 });
    await page.mouse.up();

    // Share: the share sheet gets one new JPEG, never the original.
    const before = requests.length;
    await page.click('#photoShare');
    await expect.poll(() => page.evaluate(() => (window as any).__shared.length)).toBe(1);
    const shared = await page.evaluate(() => (window as any).__shared[0]);
    expect(shared.name).toBe('photo.jpg');
    expect(shared.type).toBe('image/jpeg');
    const out = new Uint8Array(shared.bytes);
    expect(Buffer.from(out).equals(CREW)).toBe(false);
    expect(META.readDetails(out)).toEqual({ type: 'jpeg', known: true, found: [] });
    expect(META.leftDetails(out)).toEqual([]);
    expect(Buffer.from(out).includes(Buffer.from('Photoshop'))).toBe(false);

    // Every block on the screen is solid black in the shared file, and every face is under one.
    const now = await blocks(page);
    const px = await solid(page, shared.bytes, now);
    expect([px.width, px.height]).toEqual([960, 754]);
    expect(px.flat.every(Boolean)).toBe(true);
    for (const f of FACES) expect(now.some((x) => inside(f, x))).toBe(true);
    // The same places in the original are not flat: the check can tell.
    const orig = await solid(page, [...CREW], now.slice(0, 3));
    expect(orig.flat.some(Boolean)).toBe(false);

    // Nothing was sent anywhere while the photo was checked and shared: no request at all.
    expect(requests.slice(before)).toEqual([]);

    // Whatever is under the blocks, the new file is the same, byte for byte: nothing of it gets through.
    const same = await page.evaluate(
      async ({ bytes, boxes }) => {
        const imp = new Function('s', 'return import(s)');
        const P = await imp('/v2/core/photo.js');
        const C = await imp('/v2/core/covers.js');
        const strip = (await imp('/v2/modules/filter/strip-details/index.js')).create();
        const file = new File([new Uint8Array(bytes)], 'x.jpg', { type: 'image/jpeg' });
        const a = await P.openPhoto(file);
        const b = await P.openPhoto(file);
        const x = b.canvas.getContext('2d');
        for (const box of boxes) {
          const al = C.alignBox(box, b.width, b.height);
          for (let i = 0; i < 400; i++) {
            x.fillStyle = `rgb(${(i * 97) % 256},${(i * 31) % 256},${(i * 59) % 256})`;
            x.fillRect(al.x + ((i * 13) % (al.w - 3)), al.y + ((i * 7) % (al.h - 3)), 3, 3);
          }
        }
        const fa = new Uint8Array(await (await P.makeFile(a, boxes, [strip])).arrayBuffer());
        const fb = new Uint8Array(await (await P.makeFile(b, boxes, [strip])).arrayBuffer());
        const da = a.canvas.getContext('2d').getImageData(0, 0, a.width, a.height).data;
        const db = x.getImageData(0, 0, b.width, b.height).data;
        const changed = da.some((v: number, i: number) => v !== db[i]);
        return { changed, equal: fa.length === fb.length && fa.every((v, i) => v === fb[i]) };
      },
      { bytes: [...CREW], boxes: now },
    );
    expect(same).toEqual({ changed: true, equal: true });
    expect(requests.filter(([m]) => m !== 'GET')).toEqual([]);
    expect(requests.every(([, u]) => u.startsWith(g.url))).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('with no share sheet, Share and Save give a download, with the GPS position and the sign covered', async () => {
    const { ctx, page, errors } = await phone({ sheet: false });
    await pick(page, 'sign.jpg', SIGN);
    const rows = await changes(page);
    expect(rows).toContainEqual(['Where it was taken', 'removed']);
    expect(rows).toContainEqual(['Which phone or camera took it', 'removed']);
    expect(rows).toContainEqual(['When it was taken', 'removed']);
    expect(rows).toContainEqual(['Faces', 'none']);
    const writing = (await blocks(page)).filter((b) => b.kind === 'writing');
    expect(writing.length).toBeGreaterThan(0);
    // The road sign's "138A" (around x 243, y 220 in the 536 x 402 photo) is under a block.
    expect(writing.some((b) => inside({ x: 243, y: 220 }, b))).toBe(true);

    for (const id of ['#photoShare', '#photoSave']) {
      const [download] = await Promise.all([page.waitForEvent('download'), page.click(id)]);
      expect(download.suggestedFilename()).toBe('photo.jpg');
      const out = new Uint8Array(readFileSync((await download.path())!));
      expect(META.readDetails(out).found).toEqual([]);
      expect(META.leftDetails(out)).toEqual([]);
      // The phone model is not in the file in any form.
      expect(Buffer.from(out).includes(Buffer.from('SM-S906U1'))).toBe(false);
      // Nor are the GPS latitude and longitude values the original carries.
      expect(SIGN_GPS).toHaveLength(2);
      for (const v of SIGN_GPS) expect(Buffer.from(out).includes(v)).toBe(false);
      const px = await solid(page, [...out], await blocks(page));
      expect(px.flat.every(Boolean)).toBe(true);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('Ask about it adds the protected photo to the next question', async () => {
    const { ctx, page } = await phone();
    const token = await mintToken(MINT_A, 'usd', 200);
    const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
    const key = ((await r.json()) as any).key;
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    await page.click('[data-model="mock-see"]');
    // The list closes on the choice.
    await page.waitForSelector('[data-screen=home]');
    // The choice is saved before the page is opened again.
    await expect.poll(() => page.evaluate(async (src) => (await new Function('s', 'return import(s)')(src)).kv.get('settings').then((x: any) => x?.model), '/v2/core/db.js')).toBe('mock-see');
    await pick(page, 'sign.jpg', SIGN);
    await page.click('#photoAsk');
    await page.waitForSelector('[data-screen=type]');
    const stored = () => page.evaluate(async (src) => (await new Function('s', 'return import(s)')(src)).kv.get('pending'), '/v2/core/db.js');
    await expect.poll(stored).toHaveLength(1);
    const pending: any[] = await stored();
    expect(pending[0]).toMatchObject({ kind: 'image', status: 'ready' });
    // What waits is the new file (a JPEG drawn again on the phone), not the original.
    const bytes = Buffer.from(pending[0].url.split(',')[1], 'base64');
    expect(META.readDetails(bytes).found).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('when a check did not run, the first tap on Share only warns and the second one shares', async () => {
    // No worker, so the route below sees the page's own request for the detector.
    const { ctx, page, errors } = await phone({ workers: 'block' });
    // The face detector cannot load (not cached and the phone offline, say).
    await page.route('**/vendor/face-api/face-api.js', (r) => r.abort());
    await pick(page, 'IMG_2041.jpg', CREW);
    expect(await changes(page)).toContainEqual(['Faces', 'failed']);
    expect(await page.isVisible('#photoFailed')).toBe(true);
    await page.click('#photoShare');
    await page.waitForSelector('#photoStatus.err');
    expect(await page.textContent('#photoStatus')).toBe('A check did not run. Tap again to share anyway.');
    expect(await page.evaluate(() => (window as any).__shared.length)).toBe(0);
    await page.click('#photoShare');
    // The photo is drawn again before it is shared: over a second on a slow machine.
    await expect.poll(() => page.evaluate(() => (window as any).__shared.length), { timeout: 15_000 }).toBe(1);
    const out = new Uint8Array((await page.evaluate(() => (window as any).__shared[0])).bytes);
    expect(META.readDetails(out).found).toEqual([]);
    // A new photo is checked afresh and warns again.
    await page.click('#photoAnother');
    await page.setInputFiles('#photoFile', { name: 'IMG_2042.jpg', mimeType: 'image/jpeg', buffer: CREW });
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    expect(await page.textContent('#photoStatus')).toBe('');
    await page.click('#photoShare');
    await page.waitForSelector('#photoStatus.err');
    expect(await page.evaluate(() => (window as any).__shared.length)).toBe(1);
    // The aborted detector load (the only request aborted) is the only error on the page.
    expect(errors.filter((e) => e !== 'Failed to load resource: net::ERR_FAILED')).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('takes a photo shared in from another app through the service worker, and keeps no copy', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.reload();
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // The address each page opens on, kept before the app runs.
    await page.addInitScript(() => ((window as any).__openedOn = location.hash));
    // What the phone does for a share: a POST of the photo to the manifest's share target.
    await page.evaluate((bytes) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/v2/share';
      form.enctype = 'multipart/form-data';
      const input = document.createElement('input');
      input.type = 'file';
      input.name = 'photo';
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'IMG_7.jpg', { type: 'image/jpeg' }));
      input.files = dt.files;
      form.append(input);
      document.body.append(form);
      form.submit();
    }, [...SIGN]);
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    expect(await page.evaluate(() => (window as any).__openedOn)).toBe('#/photo/shared');
    expect(await changes(page)).toContainEqual(['Where it was taken', 'removed']);
    // Once taken, the address no longer says a shared photo waits: a tab the phone reopens later does not
    // claim the photo did not arrive.
    expect(await page.evaluate(() => location.hash)).toBe('#/photo');
    await page.reload();
    await page.waitForSelector('#photoPick');
    expect(await page.locator('#photoAlert').count()).toBe(0);
    // The copy the worker kept for the page is gone once the page has it.
    expect(await page.evaluate(() => caches.keys())).not.toContain('forge2-share');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('without its worker, a shared photo is dropped by the gateway and the page says it was sent there', async () => {
    const { ctx, page } = await phone({ workers: 'block' });
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.evaluate(() => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/v2/share';
      form.enctype = 'multipart/form-data';
      document.body.append(form);
      form.submit();
    });
    await page.waitForURL(/#\/photo\/sent$/);
    await page.waitForSelector('#photoAlert');
    expect(await page.textContent('#photoAlert')).toBe('Photo not kept. The app was not ready, so the phone sent this photo to the Forge server. The server dropped it without reading or keeping it. Share it again, or pick it here.');
    // The photo did leave the phone, so "it does not leave this phone" is not said here.
    expect(await page.locator('#photoFree').count()).toBe(0);
    expect(await page.isVisible('#photoPick')).toBe(true);
    expect(await page.textContent('[data-screen=photo]')).not.toMatch(/null|undefined/);
    // "Did not reach Forge" stays for the worker's own failure, where it is true.
    await page.goto(`${g.url}/v2/#/photo/missed`);
    await page.waitForSelector('#photoAlert');
    expect(await page.textContent('#photoAlert')).toBe('Photo did not arrive. The shared photo did not reach Forge. Share it again, or pick it here.');
    expect(await page.locator('#photoFree').count()).toBe(1);
    await ctx.close();
  }, 60_000);
});

/**
 * What on the screen could scroll or stick out sideways: the page, every part that scrolls (and the
 * screen's scrolling part, whatever its overflow), and any element past the screen's edges. Empty when
 * nothing can. The photo's blocks and their larger touch areas are inside the photo, which cuts them off.
 */
const sideways = (page: Page) =>
  page.evaluate(() => {
    const W = innerWidth;
    const name = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className ? `.${e.className.trim().replace(/\s+/g, '.')}` : ''}`;
    const bad: string[] = [];
    const doc = document.scrollingElement!;
    if (doc.scrollWidth > W || scrollX !== 0) bad.push(`page ${doc.scrollWidth} wide, at ${scrollX}`);
    for (const e of document.querySelectorAll('main, main *')) {
      const o = getComputedStyle(e).overflowX;
      if (o === 'auto' || o === 'scroll' || e.matches('.scroll')) {
        if (e.scrollWidth > e.clientWidth) bad.push(`${name(e)} scrolls: ${e.scrollWidth} in ${e.clientWidth}`);
        if (e.scrollLeft !== 0) bad.push(`${name(e)} scrolled to ${e.scrollLeft}`);
      }
      if (e.closest('.photo-stage, .sr-only')) continue;
      const r = e.getBoundingClientRect();
      if (r.width && (r.left < -0.5 || r.right > W + 0.5)) bad.push(`${name(e)} at ${Math.round(r.left)} to ${Math.round(r.right)}`);
    }
    return bad;
  });

/** crew.jpg drawn into a new JPEG in the page: turned on its side (portrait), or in a phone screenshot's tall frame. */
const reframed = async (page: Page, how: 'portrait' | 'tall') =>
  Buffer.from(
    await page.evaluate(
      async ({ bytes, how }) => {
        const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
        const c = how === 'portrait' ? new OffscreenCanvas(bmp.height, bmp.width) : new OffscreenCanvas(1170, 2532);
        const x = c.getContext('2d')!;
        if (how === 'portrait') {
          x.translate(bmp.height, 0);
          x.rotate(Math.PI / 2);
          x.drawImage(bmp, 0, 0);
        } else {
          x.fillStyle = '#ddd';
          x.fillRect(0, 0, c.width, c.height);
          x.drawImage(bmp, 0, 900, 1170, (1170 / bmp.width) * bmp.height);
        }
        return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.9 })).arrayBuffer())];
      },
      { bytes: [...CREW], how },
    ),
  );

/** A point on the photo (page pixels) clear of every block and its touch area (48 px at least), the leftmost first. */
const clearSpot = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('#photoCanvas')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('#coverLayer .cover-box')].map((b) => b.getBoundingClientRect());
    for (let x = c.left + 8; x < c.right - 8; x += 8)
      for (let y = c.top + 8; y < c.bottom - 8; y += 8) if (boxes.every((b) => x < b.left - 32 || x > b.right + 32 || y < b.top - 32 || y > b.bottom + 32)) return { x, y };
    return null;
  });

describe('Share unseen never scrolls sideways', () => {
  // iPhone rehearsal: the result screen sat about 10 px to the left after a drag, with the heading cut
  // at the screen's edge. The phone widths: small Android, iPhone 13 to 17, the Pro Max and Plus sizes.
  for (const width of [360, 390, 428, 430]) {
    it(`at ${width} px, with landscape and portrait photos, before and after blocks added by tap and by drag`, async () => {
      const { ctx, page, errors } = await phone({ viewport: { width, height: 844 } });
      const cdp = await ctx.newCDPSession(page);
      const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
      await pick(page, 'IMG_2041.jpg', CREW);
      const photos: [string, Buffer][] = [
        ['landscape', CREW],
        ['portrait', await reframed(page, 'portrait')],
        ['tall', await reframed(page, 'tall')],
      ];
      for (const [kind, buffer] of photos) {
        if (kind !== 'landscape') {
          await page.click('#photoAnother');
          await page.setInputFiles('#photoFile', { name: `${kind}.jpg`, mimeType: 'image/jpeg', buffer });
          await page.waitForSelector('#photoChanges', { timeout: 60_000 });
        }
        expect(await sideways(page), `${kind}: as it opens`).toEqual([]);
        const mine = () => page.locator('#coverLayer .cover-box[data-kind=mine]').count();
        // A tap on the photo, as near its left edge as is clear of blocks, adds a block there.
        await page.locator('#photoCanvas').scrollIntoViewIfNeeded();
        const box = (await page.locator('#photoCanvas').boundingBox())!;
        const tap = (await clearSpot(page))!;
        await page.touchscreen.tap(tap.x, tap.y);
        await expect.poll(mine, { message: `${kind}: tap` }).toBe(1);
        expect(await sideways(page), `${kind}: after a tap`).toEqual([]);
        // A finger drag from a clear place to past the photo's right edge adds a block and moves nothing else.
        const from = (await clearSpot(page))!;
        const to = { x: box.x + box.width + 30, y: from.y + 40 };
        await touch('touchStart', from.x, from.y);
        for (let i = 1; i <= 8; i++) await touch('touchMove', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
        await touch('touchEnd');
        await expect.poll(mine, { message: `${kind}: drag` }).toBe(2);
        expect(await sideways(page), `${kind}: after a drag on the photo`).toEqual([]);
        // A swipe that is not quite straight, over the list of changes, scrolls down and never sideways.
        const list = (await page.locator('#photoChanges').boundingBox())!;
        await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(list.x + list.width / 2), y: Math.round(Math.min(list.y + 20, 800)), xDistance: -120, yDistance: -60, gestureSourceType: 'touch', speed: 1200 });
        expect(await sideways(page), `${kind}: after a sideways swipe`).toEqual([]);
        await page.evaluate(() => document.querySelector('main .scroll')!.scrollTo(0, 0));
      }
      expect(errors).toEqual([]);
      await ctx.close();
    }, 120_000);
  }
});
