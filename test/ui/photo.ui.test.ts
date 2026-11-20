import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Share unseen in a phone-sized Chrome: a real photo with faces and a real phone photo with GPS, through
// the photo picker, the filters on the page, the before and after view, blocks added and taken away by
// hand, and out through a stand-in for the share sheet or as a download. The checks read the file that
// would be shared: no hidden details left, and every cover one flat colour in its pixels.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHOTOS = resolve(import.meta.dirname, '../unit/fixtures/photos');
const CREW = readFileSync(resolve(PHOTOS, 'crew.jpg'));
const SIGN = readFileSync(resolve(PHOTOS, 'sign.jpg'));
const META: any = await import('../../public/v2/core/photometa.js' as string);
const COVER_MATH: any = await import('../../public/v2/core/covers.js' as string);

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
    // A standard model that reads photos, for Ask about it, and a private one.
    editCatalog: (c) => c.models.push({ ...c.models.find((m: any) => m.id === 'mock-echo'), id: 'mock-see', upstream: 'mock-echo', vision: true }, { ...c.models.find((m: any) => m.id === 'tinfoil/enc-model'), id: 'tinfoil/enc-see', vision: true }),
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

interface Cover {
  kind: string;
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  shape?: 'ellipse';
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  found?: { x: number; y: number; w: number; h: number };
}

/** The covers on the photo, as the screen holds them: kind, bounds, an ellipse's shape, what was found. */
const blocks = (page: Page): Promise<Cover[]> =>
  page.locator('#coverLayer .cover-box').evaluateAll((n) =>
    n.map((x) => {
      const num = (a: string) => x.getAttribute(a)?.split(',').map(Number);
      const [bx, by, bw, bh] = num('data-box')!;
      const e = num('data-ellipse');
      const f = num('data-found');
      return {
        kind: x.getAttribute('data-kind')!,
        id: x.getAttribute('data-cover')!,
        x: bx!,
        y: by!,
        w: bw!,
        h: bh!,
        ...(e ? { shape: 'ellipse' as const, cx: e[0], cy: e[1], rx: e[2], ry: e[3] } : {}),
        ...(f ? { found: { x: f[0]!, y: f[1]!, w: f[2]!, h: f[3]! } } : {}),
      };
    }),
  );

/**
 * Checks a file against what the page paints for these covers on the original photo. `flat`: each cover is
 * one colour as painted. `inner` and `edge`: the file's mean difference from that painting over the covered
 * pixels, and over the pixels on either side of each cover's edge (JPEG changes them a little; an outline
 * drawn into the file would change the edge a lot). `found`: whether all of each cover's found region is
 * under a cover. `share`: the part of the photo covered.
 */
async function painted(page: Page, out: number[], original: Buffer, covers: Cover[]) {
  return page.evaluate(
    async ({ out, original, covers }) => {
      const imp = new Function('s', 'return import(s)');
      const P = await imp('/v2/core/photo.js');
      const C = await imp('/v2/core/covers.js');
      const photo = await P.openPhoto(new File([new Uint8Array(original)], 'x.jpg', { type: 'image/jpeg' }));
      const W = photo.width;
      const H = photo.height;
      const want = P.drawCovered(photo, covers, document.createElement('canvas')).getContext('2d').getImageData(0, 0, W, H).data;
      const bmp = await createImageBitmap(new Blob([new Uint8Array(out)], { type: 'image/jpeg' }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext('2d')!;
      x.drawImage(bmp, 0, 0);
      const got = x.getImageData(0, 0, bmp.width, bmp.height).data;
      const mask = C.coverMask(covers, W, H);
      const flat = covers.map((cv: any, k: number) => {
        const later = C.coverMask(covers.slice(k + 1), W, H);
        const colours = new Set<number>();
        for (const [y, x0, x1] of C.coverSpans(cv, W, H)) for (let i = y * W + x0; i < y * W + x1; i++) if (!later[i]) colours.add((want[i * 4]! << 16) | (want[i * 4 + 1]! << 8) | want[i * 4 + 2]!);
        return colours.size === 1;
      });
      const diff = (i: number) => (Math.abs(got[i * 4]! - want[i * 4]!) + Math.abs(got[i * 4 + 1]! - want[i * 4 + 1]!) + Math.abs(got[i * 4 + 2]! - want[i * 4 + 2]!)) / 3;
      let inner = 0;
      let ni = 0;
      let edge = 0;
      let ne = 0;
      for (let i = 0; i < W * H; i++) {
        const px = i % W;
        const near = [px > 0 ? i - 1 : i, px < W - 1 ? i + 1 : i, i >= W ? i - W : i, i < W * (H - 1) ? i + W : i];
        if (near.some((j) => mask[j] !== mask[i])) {
          edge += diff(i);
          ne++;
        } else if (mask[i]) {
          inner += diff(i);
          ni++;
        }
      }
      const found = covers.map((cv: any) => {
        if (!cv.found) return true;
        const b = C.clampBox(cv.found, W, H);
        for (let y = b.y; y < b.y + b.h; y++) for (let i = y * W + b.x; i < y * W + b.x + b.w; i++) if (!mask[i]) return false;
        return true;
      });
      const covered = mask.reduce((a: number, v: number) => a + v, 0);
      return { width: bmp.width, height: bmp.height, flat, found, inner: inner / Math.max(1, ni), edge: edge / Math.max(1, ne), share: covered / (W * H) };
    },
    { out, original: [...original], covers },
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

/**
 * The part of each photo covered when every cover was a black rectangle widened to a 16 pixel grid (the
 * app before 2026-11-17), measured in this Chrome: the three faces and eight places with writing on
 * crew.jpg, the four places with writing on sign.jpg.
 */
const RECT_SHARE = { crew: 0.22, sign: 0.0579 };

/** A JPEG Exif block holding only an orientation, inserted after the start of `jpeg`. */
function withOrientation(jpeg: Buffer, o: number): Buffer {
  const tiff = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, o, 0, 0, 0, 0, 0, 0];
  const body = [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
  return Buffer.concat([jpeg.subarray(0, 2), Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body]), jpeg.subarray(2)]);
}

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

    // The shared file is the photo at its own size with every cover on the screen painted one flat colour,
    // and nothing else drawn: no outline. Every face is under one.
    const now = await blocks(page);
    const px = await painted(page, shared.bytes, CREW, now);
    expect([px.width, px.height]).toEqual([960, 754]);
    expect(px.flat.every(Boolean)).toBe(true);
    expect(px.inner).toBeLessThan(3);
    expect(px.edge).toBeLessThan(12);
    for (const f of FACES) expect(now.some((x) => inside(f, x))).toBe(true);
    // The original differs from it under the covers: the check can tell.
    expect((await painted(page, [...CREW], CREW, now)).inner).toBeGreaterThan(20);

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
        // Every pixel under a cover in b is changed, each to its own colour.
        const x = b.canvas.getContext('2d');
        const img = x.getImageData(0, 0, b.width, b.height);
        const mask = C.coverMask(boxes, b.width, b.height);
        for (let i = 0; i < mask.length; i++) if (mask[i]) img.data.set([(i * 97) % 256, (i * 31) % 256, (i * 59) % 256], i * 4);
        x.putImageData(img, 0, 0);
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
      // A page is never told where a download went: it says only that it started.
      await expect.poll(() => page.textContent('#toast')).toBe('Download started. Look in your downloads.');
      await page.evaluate(() => document.getElementById('toast')!.textContent = '');
      const out = new Uint8Array(readFileSync((await download.path())!));
      expect(META.readDetails(out).found).toEqual([]);
      expect(META.leftDetails(out)).toEqual([]);
      // The phone model is not in the file in any form.
      expect(Buffer.from(out).includes(Buffer.from('SM-S906U1'))).toBe(false);
      // Nor are the GPS latitude and longitude values the original carries.
      expect(SIGN_GPS).toHaveLength(2);
      for (const v of SIGN_GPS) expect(Buffer.from(out).includes(v)).toBe(false);
      const px = await painted(page, [...out], SIGN, await blocks(page));
      expect(px.flat.every(Boolean)).toBe(true);
      expect(px.inner).toBeLessThan(3);
      expect(px.edge).toBeLessThan(12);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('covers less of each photo than rectangles did, with every face and line the checks found under a cover', async () => {
    const { ctx, page, errors } = await phone();
    for (const [name, buffer] of [
      ['crew', CREW],
      ['sign', SIGN],
    ] as const) {
      if (name === 'crew') await pick(page, 'crew.jpg', buffer);
      else {
        await page.click('#photoAnother');
        await page.setInputFiles('#photoFile', { name: 'sign.jpg', mimeType: 'image/jpeg', buffer });
        await page.waitForSelector('#photoChanges', { timeout: 60_000 });
      }
      const now = await blocks(page);
      // Faces are ellipses round what the detector found; writing is a box round each line.
      expect(now.filter((c) => c.kind === 'face').every((c) => c.shape === 'ellipse' && c.found)).toBe(true);
      expect(now.filter((c) => c.kind === 'writing').every((c) => !c.shape && c.found)).toBe(true);
      // The three faces of the crew, and none on the road sign. Looking at the crew photo enlarged, the
      // detector can take a hand on a suit for a face: a block too many, at most two.
      const faces = now.filter((c) => c.kind === 'face');
      if (name === 'crew') for (const f of FACES) expect(faces.some((b) => inside(f, b)), JSON.stringify(f)).toBe(true);
      expect(faces.length).toBeGreaterThanOrEqual(name === 'crew' ? 3 : 0);
      expect(faces.length).toBeLessThanOrEqual(name === 'crew' ? 5 : 0);
      expect(now.filter((c) => c.kind === 'writing').length).toBeGreaterThanOrEqual(2);
      const px = await painted(page, [...buffer], buffer, now);
      expect(px.found.every(Boolean), name).toBe(true);
      // The part of the photo the three faces' and the writing's covers take (a block on a hand is left out).
      const size = (await page.getAttribute('#photoStage', 'data-size'))!.split('x').map(Number) as [number, number];
      const kept = now.filter((c) => c.kind !== 'face' || FACES.some((f) => inside(f, c)));
      const share = COVER_MATH.coverMask(kept, ...size).reduce((a: number, v: number) => a + v, 0) / (size[0] * size[1]);
      expect(share, name).toBeLessThan(0.8 * RECT_SHARE[name]);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('covers the faces of a photo the camera stored turned or mirrored, where they show', async () => {
    const { ctx, page, errors } = await phone();
    await pick(page, 'crew.jpg', CREW);
    // crew.jpg stored turned a quarter to the left with orientation 6 (turn it right to show it), and stored
    // mirrored with orientation 2 (mirror it to show it): both show as crew.jpg does.
    const stored = async (how: 'left' | 'mirror') =>
      Buffer.from(
        await page.evaluate(
          async ({ bytes, how }) => {
            const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
            const c = how === 'left' ? new OffscreenCanvas(bmp.height, bmp.width) : new OffscreenCanvas(bmp.width, bmp.height);
            const x = c.getContext('2d')!;
            if (how === 'left') {
              x.translate(0, bmp.width);
              x.rotate(-Math.PI / 2);
            } else {
              x.translate(bmp.width, 0);
              x.scale(-1, 1);
            }
            x.drawImage(bmp, 0, 0);
            return [...new Uint8Array(await (await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 })).arrayBuffer())];
          },
          { bytes: [...CREW], how },
        ),
      );
    for (const [how, o] of [
      ['left', 6],
      ['mirror', 2],
    ] as const) {
      const file = withOrientation(await stored(how), o);
      await page.click('#photoAnother');
      await page.setInputFiles('#photoFile', { name: `${how}.jpg`, mimeType: 'image/jpeg', buffer: file });
      await page.waitForSelector('#photoChanges', { timeout: 60_000 });
      expect(await page.getAttribute('#photoStage', 'data-size'), how).toBe('960x754');
      const now = await blocks(page);
      for (const f of FACES) expect(now.some((c) => c.kind === 'face' && inside(f, c)), `${how} ${JSON.stringify(f)}`).toBe(true);
      await page.click('#photoShare');
      await expect.poll(() => page.evaluate(() => (window as any).__shared.length)).toBe(o === 6 ? 1 : 2);
      const out: number[] = await page.evaluate(() => (window as any).__shared.at(-1).bytes);
      const px = await painted(page, out, file, now);
      // The file is upright, its covers where the faces show, and it says nothing about turning.
      expect([px.width, px.height], how).toEqual([960, 754]);
      expect(px.inner, how).toBeLessThan(3);
      expect(META.readDetails(new Uint8Array(out)).found).toEqual([]);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('each cover has a cross to take it away by touch, and taps and drags add covers by touch', async () => {
    const { ctx, page, errors } = await phone();
    const cdp = await ctx.newCDPSession(page);
    const touch = async (type: 'touchStart' | 'touchMove' | 'touchEnd', x = 0, y = 0) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await pick(page, 'IMG_2041.jpg', CREW);
    // The hint says it in few words, after a cross like the ones on the covers.
    expect(await page.textContent('#photoHint .say-head')).toBe('Tap the cross to take a block away.');
    expect(await page.locator('#photoHint > svg').count()).toBe(1);
    // The covers keep their names for a screen reader; the crosses are only for the eye and the finger.
    expect(await page.getAttribute('#coverLayer .cover-box[data-kind=face]', 'aria-label')).toBe('Take this block away. It covers a face.');
    expect(await page.getAttribute('#coverLayer .cover-box[data-kind=writing]', 'aria-label')).toBe('Take this block away. It covers writing.');
    const crosses = () =>
      page.locator('#coverLayer .cover-x').evaluateAll((n) => {
        const stage = document.querySelector('#photoStage')!.getBoundingClientRect();
        return n.map((x) => {
          const r = x.getBoundingClientRect();
          const d = x.querySelector('.cover-x-dot')!.getBoundingClientRect();
          // top: nothing lies over the cross's middle, so a finger there touches this cross.
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.cover-x') === x;
          return { id: x.getAttribute('data-cover')!, hidden: x.getAttribute('aria-hidden'), top, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height, dot: Math.max(d.width, d.height), inStage: r.left >= stage.left - 0.5 && r.right <= stage.right + 0.5 && r.top >= stage.top - 0.5 && r.bottom <= stage.bottom + 0.5 };
        });
      });
    const ids = async () => (await blocks(page)).map((c) => c.id).sort();
    let all = await crosses();
    expect(all.map((c) => c.id).sort()).toEqual(await ids());
    // Each is a touch area of at least 48 px inside the photo, round a mark no wider than 28 px, even on
    // the smallest cover.
    for (const c of all) {
      expect(c.w >= 48 && c.h >= 48 && c.inStage, JSON.stringify(c)).toBe(true);
      expect(c.dot).toBeLessThanOrEqual(28);
      expect(c.hidden).toBe('true');
    }
    // A touch on a writing cover's cross takes that cover away, and only it.
    const crossOf = async (kind: string) => {
      const on = await crosses();
      const c = (await blocks(page)).filter((b) => b.kind === kind).find((b) => on.find((x) => x.id === b.id)?.top)!;
      return { cover: c, cross: on.find((x) => x.id === c.id)! };
    };
    const { cover: writing, cross: wx } = await crossOf('writing');
    const before = await ids();
    let cross = wx;
    await page.touchscreen.tap(cross.x, cross.y);
    await expect.poll(ids).toEqual(before.filter((id) => id !== writing.id));
    // A touch on a face's cross takes the face cover away, and the list says so.
    const { cover: face, cross: fx } = await crossOf('face');
    cross = fx;
    await page.touchscreen.tap(cross.x, cross.y);
    await expect.poll(async () => (await ids()).includes(face.id)).toBe(false);
    expect(await changes(page)).toContainEqual(['1 face block you took away', 'uncovered']);
    // A tap adds a cover there, and a drag adds one over the area, both by touch.
    const mine = () => page.locator('#coverLayer .cover-box[data-kind=mine]').count();
    await page.locator('#photoCanvas').scrollIntoViewIfNeeded();
    const tap = (await clearSpot(page))!;
    await page.touchscreen.tap(tap.x, tap.y);
    await expect.poll(mine).toBe(1);
    const from = (await clearSpot(page))!;
    const to = { x: from.x + 70, y: from.y + 50 };
    await touch('touchStart', from.x, from.y);
    for (let i = 1; i <= 8; i++) await touch('touchMove', from.x + ((to.x - from.x) * i) / 8, from.y + ((to.y - from.y) * i) / 8);
    await touch('touchEnd');
    await expect.poll(mine).toBe(2);
    expect(await changes(page)).toContainEqual(['2 blocks you added', 'covered']);
    // The cross of an added cover takes it away too.
    const { cover: added, cross: ax } = await crossOf('mine');
    await page.touchscreen.tap(ax.x, ax.y);
    await expect.poll(mine).toBe(1);
    expect((await ids()).includes(added.id)).toBe(false);
    // Covers taken away stay away: after Before and After, and in the file.
    await page.click('#photo-before');
    await page.click('#photo-after');
    const now = await blocks(page);
    expect(now.map((c) => c.id)).not.toContain(face.id);
    expect(now.map((c) => c.id)).not.toContain(writing.id);
    await page.click('#photoShare');
    await expect.poll(() => page.evaluate(() => (window as any).__shared.length)).toBe(1);
    const out: number[] = await page.evaluate(() => (window as any).__shared[0].bytes);
    // The file is what is painted for the covers left, the added one in its own flat colour, with no outline.
    const px = await painted(page, out, CREW, now);
    expect(px.flat.every(Boolean)).toBe(true);
    expect(px.inner).toBeLessThan(3);
    expect(px.edge).toBeLessThan(12);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the iPhone app, Save puts the clean file in Photos and says Saved only once it is there', async () => {
    // The iPhone app's bridge: ForgeShare's save as SharePlugin.swift answers it, by __photos.mode.
    const ctx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
    await pastFirstRun(ctx);
    await ctx.addInitScript(() => {
      const w = window as any;
      w.__photos = { mode: 'ok', saved: [] as number[][], calls: 0 };
      w.Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: { ForgeBars: {}, ForgeShare: {} },
        nativePromise: async (plugin: string, method: string, opts: any) => {
          if (plugin !== 'ForgeShare' || method !== 'save') return undefined;
          w.__photos.calls += 1;
          if (w.__photos.mode === 'denied') throw Object.assign(new Error('Forge may not add to Photos.'), { code: 'denied' });
          if (w.__photos.mode === 'failed') throw Object.assign(new Error('The photo could not be saved.'), { code: 'save_failed' });
          w.__photos.saved.push(Array.from(atob(opts.data), (c) => c.charCodeAt(0)));
          return { saved: true };
        },
        addListener: () => ({ remove: async () => {} }),
      };
      // The web view's own share sheet, as in Safari on an iPhone.
      Object.defineProperty(navigator, 'canShare', { configurable: true, value: (d: any) => Array.isArray(d?.files) && d.files.length > 0 });
      Object.defineProperty(navigator, 'share', { configurable: true, value: async () => {} });
    });
    // Nothing reaches Forge's own engine (the app's default): the local one is set in More, Engine.
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort('blockedbyclient'));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(m.text()) && errors.push(m.text()));
    await page.goto(`${g.url}/v2/#/more/engine`);
    await page.waitForSelector('[data-screen=engine]');
    await page.fill('#engineAddress', `${g.url}/`);
    await Promise.all([page.waitForEvent('load'), page.click('#engineUse')]);
    await page.waitForSelector('[data-screen=home]');
    await pick(page, 'IMG_2041.jpg', CREW);
    const photos = () => page.evaluate(() => (window as any).__photos);
    const toastText = () => page.evaluate(() => document.getElementById('toast')?.textContent ?? '');

    // Refused: nothing is said to be saved, and the line says what to do.
    await page.evaluate(() => ((window as any).__photos.mode = 'denied'));
    await page.click('#photoSave');
    await page.waitForSelector('#photoStatus.err');
    expect(await page.textContent('#photoStatus')).toBe('Not saved. Forge may not add to Photos. Allow it in Settings, or tap Share.');
    expect(await toastText()).not.toMatch(/Saved/);

    // Failed: the same, with its own words.
    await page.evaluate(() => ((window as any).__photos.mode = 'failed'));
    await page.click('#photoSave');
    await expect.poll(() => page.evaluate(() => (window as any).__photos.calls)).toBe(2);
    await expect.poll(() => page.textContent('#photoStatus')).toBe('Not saved. Try again, or tap Share.');
    expect(await toastText()).not.toMatch(/Saved/);

    // Allowed: Photos has the file, then the toast says so, and the line is clear.
    await page.evaluate(() => ((window as any).__photos.mode = 'ok'));
    await page.click('#photoSave');
    await expect.poll(() => page.textContent('#toast')).toBe('Saved to Photos');
    expect(await page.textContent('#photoStatus')).toBe('');
    const { saved } = await photos();
    expect(saved).toHaveLength(1);
    // What went to Photos is the clean file, with no hidden details: never a download.
    const out = new Uint8Array(saved[0]);
    expect(META.readDetails(out).found).toEqual([]);
    expect(META.leftDetails(out)).toEqual([]);
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

  it('Ask about it with a model that cannot see photos lists the ones that can, then asks with the photo', async () => {
    const { ctx, page, errors } = await phone();
    const kv = (name: string) => page.evaluate(async ([src, n]) => (await new Function('s', 'return import(s)')(src)).kv.get(n), ['/v2/core/db.js', name]);
    // Private only is on, and the private model in use cannot see photos.
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-model="tinfoil/enc-model"]');
    await page.click('[data-model="tinfoil/enc-model"]');
    // No money on this phone: a marked model opens Add money once chosen.
    await page.waitForSelector('[data-screen=addFunds]');
    await pick(page, 'sign.jpg', SIGN);
    await page.click('#photoAsk');
    await page.waitForSelector('#modelPhotoLead');
    expect(await page.textContent('#modelPhotoLead')).toBe('Pick a model that can see photos.');
    expect(await page.locator('#modelPhotoLead svg').count()).toBe(1);
    // Only the private one that can see photos: Private only still applies.
    expect(await page.locator('[data-model]').evaluateAll((n) => n.map((x) => x.getAttribute('data-model')))).toEqual(['tinfoil/enc-see']);
    expect(await page.isVisible('#modelPhotoNone')).toBe(false);
    // No money on this phone: the Add money mark, as in the full list.
    expect(await page.getAttribute('[data-model="tinfoil/enc-see"] .model-poor', 'aria-label')).toBe('Add money first');
    // Every model here sees photos, and carries the photo badge as in the full list.
    expect(await page.getAttribute('[data-model="tinfoil/enc-see"] .tag.photo', 'aria-label')).toBe('Sees photos');
    // While the list is open the photo is in memory only: nothing waits in storage.
    expect(await kv('pending')).toBeFalsy();
    const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
    expect(stored).not.toMatch(/image\/jpeg|\/9j\//);
    await page.click('[data-model="tinfoil/enc-see"]');
    // Straight to the question, with the photo attached: where Ask about it lands with a model that sees.
    await page.waitForSelector('[data-screen=type]');
    await expect.poll(async () => ((await kv('pending')) ?? []).length).toBe(1);
    expect((await kv('settings')).model).toBe('tinfoil/enc-see');
    expect(await page.locator('#attached .chip').count()).toBe(1);
    // No money: the Type screen says so at once, with Add money.
    expect(await page.isVisible('#noticeBtn')).toBe(true);
    // The list is not under the question: Back goes to Share unseen.
    await page.goBack();
    await page.waitForSelector('[data-screen=photo]');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('with no private model that can see photos, it says so and asks the Standard question first', async () => {
    const g2 = await startGateway({ env: { FORGE_INVITE_ONLY: 'true' }, editCatalog: (c) => c.models.push({ ...c.models.find((m: any) => m.id === 'mock-echo'), id: 'mock-see', upstream: 'mock-echo', vision: true }) });
    const ctx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${g2.url}/v2/`);
      await page.waitForSelector('[data-screen=home]');
      await page.click('#btn-add');
      await page.click('#addPhoto');
      await page.setInputFiles('#photoFile', { name: 'sign.jpg', mimeType: 'image/jpeg', buffer: SIGN });
      await page.waitForSelector('#photoChanges', { timeout: 60_000 });
      await page.click('#photoAsk');
      await page.waitForSelector('#modelPhotoNone:not([hidden])');
      expect(await page.textContent('#modelPhotoNoneText')).toBe('No private model can see photos.');
      expect(await page.locator('[data-model]').count()).toBe(0);
      // The generic note about hidden Standard models does not say it twice.
      expect(await page.isVisible('#hiddenNote')).toBe(false);
      // Use Standard asks the Private chip's question; Keep Private changes nothing.
      await page.click('#modelPhotoStandard');
      await page.waitForSelector('#kindAsk[open]');
      expect(await page.textContent('#kindAskText')).toBe('Standard models: the company running them can read what you type. Use them?');
      await page.click('#kindKeep');
      await page.waitForSelector('#kindAsk', { state: 'detached' });
      expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('true');
      expect(await page.locator('[data-model]').count()).toBe(0);
      await page.click('#modelPhotoStandard');
      await page.waitForSelector('#kindAsk[open]');
      await page.click('#kindUse');
      await page.waitForSelector('#kindAsk', { state: 'detached' });
      // Private only is off: the Standard models that can see photos, and only those.
      await page.waitForSelector('[data-model="mock-see"]');
      expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('false');
      expect(await page.locator('[data-model]').evaluateAll((n) => n.map((x) => x.getAttribute('data-model')))).toEqual(['mock-see']);
      expect(await page.isVisible('#modelPhotoNone')).toBe(false);
      expect(await page.evaluate(() => document.activeElement?.getAttribute('data-model'))).toBe('mock-see');
      await page.click('[data-model="mock-see"]');
      await page.waitForSelector('[data-screen=type]');
      const pending = await page.evaluate(async (src) => (await new Function('s', 'return import(s)')(src)).kv.get('pending'), '/v2/core/db.js');
      expect(pending).toHaveLength(1);
      expect(pending[0]).toMatchObject({ kind: 'image', status: 'ready' });
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
      await g2.close();
    }
  }, 120_000);

  it('with no model at all that can see photos, Ask about it says so and stays', async () => {
    const g3 = await startGateway({ env: { FORGE_INVITE_ONLY: 'true' } });
    const ctx = await browser.newContext({ ...PHONE, serviceWorkers: 'block' });
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    try {
      await page.goto(`${g3.url}/v2/`);
      await page.waitForSelector('[data-screen=home]');
      await page.click('#btn-add');
      await page.click('#addPhoto');
      await page.setInputFiles('#photoFile', { name: 'sign.jpg', mimeType: 'image/jpeg', buffer: SIGN });
      await page.waitForSelector('#photoChanges', { timeout: 60_000 });
      await page.click('#photoAsk');
      await expect.poll(() => page.evaluate(() => document.getElementById('toast')?.textContent ?? '')).toBe('No model can see photos now.');
      expect(await page.isVisible('[data-screen=photo]')).toBe(true);
    } finally {
      await ctx.close();
      await g3.close();
    }
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

/**
 * A point on the photo (page pixels) clear of every block, its cross and their touch areas (48 px at
 * least), the leftmost first. A finger near one is taken as a touch on it.
 */
const clearSpot = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector('#photoCanvas')!.getBoundingClientRect();
    const boxes = [...document.querySelectorAll('#coverLayer .cover-box, #coverLayer .cover-x')].map((b) => b.getBoundingClientRect());
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
