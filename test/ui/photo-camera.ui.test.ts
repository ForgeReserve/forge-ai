import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { cameraArgs, pictureFile } from './camera.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Take a photo inside the app (screens/camera.js) in a phone-sized Chrome. The fake camera shows the
// crew photo (three faces), so Share unseen's checks have something to find in the photo the in-app
// camera takes. Also: the camera turned off once the photo is taken and when the camera screen is left,
// the phone's own picker when the camera cannot be used, and Share unseen opened again after the phone
// stopped the app while a picker was up.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHOTOS = resolve(import.meta.dirname, '../unit/fixtures/photos');
const CREW = readFileSync(resolve(PHOTOS, 'crew.jpg'));
const SHOTS = join(import.meta.dirname, '../../.tmp/photo-camera');

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway();
  // The crew photo's pixels, for the fake camera to show.
  const plain = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await plain.newPage();
  const { w, h, data } = await page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext('2d')!;
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode(...px.subarray(i, i + 0x8000));
    return { w: bmp.width, h: bmp.height, data: btoa(s) };
  }, CREW.toString('base64'));
  await plain.close();
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: cameraArgs(pictureFile(new Uint8Array(Buffer.from(data, 'base64')), w, h)) });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  requests: [string, string][];
}

/**
 * A phone with the fake camera allowed. Every camera stream the page opens is kept in window.__streams,
 * and every ImageCapture.takePhoto call counted in window.__stills (with how many gave a photo), so the
 * test can see the camera is off and which way the photo was taken. `camera`: 'ok', or the error
 * getUserMedia gives ('NotAllowedError' for a refusal, 'NotFoundError' for no camera), or 'none' for a
 * browser without getUserMedia. `stills: false`: a browser with no ImageCapture (Safari, Firefox).
 */
async function phone({ camera = 'ok' as string, stills = true, on = browser } = {}): Promise<Phone> {
  const ctx = await on.newContext({ ...PHONE });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['camera'], { origin: g.url });
  await ctx.addInitScript(({ camera, stills }) => {
    const w = window as any;
    w.__streams = [];
    w.__stills = { asked: 0, given: 0 };
    if (!stills) delete w.ImageCapture;
    const md = navigator.mediaDevices;
    if (camera === 'none') {
      Object.defineProperty(md, 'getUserMedia', { configurable: true, value: undefined });
      return;
    }
    const real = md.getUserMedia.bind(md);
    Object.defineProperty(md, 'getUserMedia', {
      configurable: true,
      value: async (c: MediaStreamConstraints) => {
        if (camera !== 'ok' && c.video) throw new DOMException('no', camera);
        const s = await real(c);
        w.__streams.push(s);
        return s;
      },
    });
    const take = w.ImageCapture?.prototype.takePhoto;
    if (take)
      w.ImageCapture.prototype.takePhoto = async function (this: unknown, ...a: unknown[]) {
        w.__stills.asked++;
        const b = await take.apply(this, a);
        w.__stills.given++;
        return b;
      };
  }, { camera, stills });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const requests: [string, string][] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => requests.push([r.method(), r.url()]));
  return { ctx, page, errors, requests };
}

/** Opens Share unseen from Add. */
async function openPhoto(page: Page) {
  await page.goto(`${g.url}/v2/`);
  await page.waitForSelector('[data-screen=home]');
  await page.click('#btn-add');
  await page.click('#addPhoto');
  await page.waitForSelector('[data-screen=photo] #photoTake');
}

/** How many camera tracks the page opened, and how many are still live. */
const tracks = (page: Page) =>
  page.evaluate(() => {
    const all = (window as any).__streams.flatMap((s: MediaStream) => s.getTracks());
    return { opened: all.length, live: all.filter((t: MediaStreamTrack) => t.readyState === 'live').length };
  });

/** The list of changes as [text, state] pairs. */
const changes = (page: Page) => page.locator('#photoChanges .change-row').evaluateAll((n) => n.map((x) => [x.querySelector('span')!.textContent, x.getAttribute('data-state')]));

/** Every button on the screen that is shown: its id, size and whether it has a picture and a name. */
const buttons = (page: Page) =>
  page.locator('button:visible').evaluateAll((n) => n.map((b) => ({ id: b.id, w: (b as HTMLElement).offsetWidth, h: (b as HTMLElement).offsetHeight, icon: !!b.querySelector('svg'), name: b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '' })));

describe('Take a photo inside the app', () => {
  it('takes the photo in the page, turns the camera off, and Share unseen checks it as a picked photo', async () => {
    const { ctx, page, errors, requests } = await phone();
    await openPhoto(page);
    await page.click('#photoTake');
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    expect(page.url()).toMatch(/#\/photo\/camera$/);
    // The camera plays on the screen, the whole picture it gives (never cropped).
    const video = await page.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>('#camVideo')!;
      return { w: v.videoWidth, h: v.videoHeight, fit: getComputedStyle(v).objectFit, playing: !v.paused };
    });
    expect(video).toEqual({ w: 960, h: 754, fit: 'contain', playing: true });
    expect(await tracks(page)).toEqual({ opened: 1, live: 1 });
    // The big round button, Back, and the other camera only where there is one; each a picture with a
    // name, at least 48 px.
    for (const b of await buttons(page)) {
      expect(b.icon, b.id).toBe(true);
      expect(b.name, b.id).not.toBe('');
      expect(Math.min(b.w, b.h), b.id).toBeGreaterThanOrEqual(48);
    }
    expect((await page.locator('#camShutter').boundingBox())!.width).toBeGreaterThanOrEqual(80);
    expect(await page.isHidden('#camFlip')).toBe(true);
    mkdirSync(SHOTS, { recursive: true });
    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, 'camera.png') });

    const before = requests.length;
    await page.click('#camShutter');
    // Back on Share unseen: the camera was off before the checks began.
    await page.waitForSelector('#photoSteps, #photoChanges');
    expect(await tracks(page)).toEqual({ opened: 1, live: 0 });
    expect(page.url()).toMatch(/#\/photo$/);
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });

    // The checks ran on the photo the camera took, at the camera's full size: the three faces found.
    expect(await page.getAttribute('#photoStage', 'data-size')).toBe('960x754');
    const rows = await changes(page);
    const faces = rows.find(([k]) => /faces?$/.test(k!));
    expect(faces?.[1]).toBe('covered');
    expect(Number(faces?.[0]?.split(' ')[0])).toBeGreaterThanOrEqual(3);
    // A photo taken in the page has no hidden details in its file, and the list says so: nothing removed.
    expect(rows).toContainEqual(['Hidden details in the file', 'none']);
    for (const k of ['Where it was taken', 'Which phone or camera took it', 'When it was taken', 'A small hidden copy of the picture', 'Other hidden notes in the file']) expect(rows.map(([x]) => x)).not.toContain(k);
    // Nothing went out: the only requests are the app's own files (the face model).
    const after = requests.slice(before);
    expect(after.filter(([m, u]) => m !== 'GET' || !u.startsWith(g.url))).toEqual([]);
    expect(after.filter(([, u]) => /\/v1\//.test(u))).toEqual([]);
    // Which way the photo was taken, for the record: a still (ImageCapture) where Chrome gave one.
    const stills = await page.evaluate(() => (window as any).__stills);
    console.log(`in-app camera: takePhoto asked ${stills.asked}, gave ${stills.given}`);
    await page.screenshot({ path: join(SHOTS, 'checked.png') });

    // Another photo: the camera again.
    await page.click('#photoAnother');
    await page.click('#photoTake');
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    expect(await tracks(page)).toEqual({ opened: 2, live: 1 });
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('where the browser takes no stills (Safari), the photo is a frame of the stream at its largest picture', async () => {
    const { ctx, page, errors } = await phone({ stills: false });
    await openPhoto(page);
    await page.click('#photoTake');
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    expect(await page.evaluate(() => typeof (window as any).ImageCapture)).toBe('undefined');
    await page.click('#camShutter');
    await page.waitForSelector('#photoSteps, #photoChanges');
    expect(await tracks(page)).toEqual({ opened: 1, live: 0 });
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    expect(await page.getAttribute('#photoStage', 'data-size')).toBe('960x754');
    const rows = await changes(page);
    expect(rows).toContainEqual(['Hidden details in the file', 'none']);
    expect(rows.find(([k]) => /faces?$/.test(k!))?.[1]).toBe('covered');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('with two cameras, the other camera button turns to the other one, with one camera on at a time', async () => {
    // Chrome's two plain fake cameras, which do not say which way they face (as on most computers).
    const two = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream=device-count=2', '--use-fake-ui-for-media-stream'] });
    try {
      const { page, errors } = await phone({ on: two });
      await openPhoto(page);
      await page.click('#photoTake');
      await page.waitForSelector('[data-screen=camera][data-state=ready]');
      const id = () => page.evaluate(() => ((document.querySelector('#camVideo') as HTMLVideoElement).srcObject as MediaStream)?.getVideoTracks()[0]?.getSettings().deviceId);
      const first = await id();
      expect(await page.isVisible('#camFlip')).toBe(true);
      await page.click('#camFlip');
      await expect.poll(id).not.toBe(first);
      await page.waitForSelector('[data-screen=camera][data-state=ready]');
      expect(await tracks(page)).toEqual({ opened: 2, live: 1 });
      await page.click('#camFlip');
      await expect.poll(id).toBe(first);
      await page.waitForSelector('[data-screen=camera][data-state=ready]');
      expect(await tracks(page)).toEqual({ opened: 3, live: 1 });
      expect(await page.isVisible('#camFlip')).toBe(true);
      await page.screenshot({ path: join(SHOTS, 'camera-two.png') });
      await page.click('#camShutter');
      await page.waitForSelector('#photoChanges', { timeout: 60_000 });
      expect(await tracks(page)).toEqual({ opened: 3, live: 0 });
      expect(errors).toEqual([]);
    } finally {
      await two.close();
    }
  });

  it('Back, the arrow or the phone’s, leaves the camera with nothing taken and the camera off', async () => {
    const { ctx, page, errors } = await phone();
    await openPhoto(page);
    await page.click('#photoTake');
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    await page.click('#camBack');
    await page.waitForSelector('[data-screen=photo] #photoTake');
    expect(await page.locator('#photoAlert, #photoNote, #photoSteps').count()).toBe(0);
    expect(await tracks(page)).toEqual({ opened: 1, live: 0 });

    await page.click('#photoTake');
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    await page.goBack();
    await page.waitForSelector('[data-screen=photo] #photoTake');
    expect(await tracks(page)).toEqual({ opened: 2, live: 0 });
    // And Back again leaves Share unseen.
    await page.goBack();
    await page.waitForSelector('[data-screen=home]');

    // Opened by its address, Back goes to Share unseen.
    await page.goto(`${g.url}/v2/#/photo/camera`);
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    await page.click('#camBack');
    await page.waitForSelector('[data-screen=photo] #photoTake');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('turns the camera off while the app is in the background, and on again when it is back', async () => {
    const { ctx, page, errors } = await phone();
    await openPhoto(page);
    await page.click('#photoTake');
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    const hide = (state: 'hidden' | 'visible') =>
      page.evaluate((state) => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
        document.dispatchEvent(new Event('visibilitychange'));
      }, state);
    await hide('hidden');
    await expect.poll(() => tracks(page)).toEqual({ opened: 1, live: 0 });
    await hide('visible');
    await page.waitForSelector('[data-screen=camera][data-state=ready]');
    expect(await tracks(page)).toEqual({ opened: 2, live: 1 });
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

describe('Take a photo where the camera cannot be used', () => {
  it('refused: back on Share unseen with nothing alarming, and Take a photo opens the phone’s camera', async () => {
    const { ctx, page, errors } = await phone({ camera: 'NotAllowedError' });
    await openPhoto(page);
    let chooser = false;
    page.on('filechooser', () => (chooser = true));
    await page.click('#photoTake');
    await page.waitForSelector('[data-screen=photo] #photoTake');
    expect(page.url()).toMatch(/#\/photo$/);
    // No second question right after the refusal, and no red box.
    await page.waitForTimeout(300);
    expect(chooser).toBe(false);
    expect(await page.locator('#photoAlert, [role=alert]').count()).toBe(0);
    // The next tap opens the phone's camera through the file input, as before the in-app camera.
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#photoTake')]);
    expect(await fc.element().getAttribute('capture')).toBe('environment');
    await fc.setFiles({ name: 'IMG_1.jpg', mimeType: 'image/jpeg', buffer: CREW });
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    expect(await changes(page)).toContainEqual(['Which phone or camera took it', 'removed']);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('no camera: the phone’s own picker opens in the same tap', async () => {
    const { ctx, page, errors } = await phone({ camera: 'NotFoundError' });
    await openPhoto(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#photoTake')]);
    expect(await fc.element().getAttribute('capture')).toBe('environment');
    expect(await page.locator('#photoAlert, [role=alert]').count()).toBe(0);
    await fc.setFiles({ name: 'IMG_2.jpg', mimeType: 'image/jpeg', buffer: CREW });
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('a browser with no camera for pages: Take a photo opens the phone’s camera at once', async () => {
    const { ctx, page, errors } = await phone({ camera: 'none' });
    await openPhoto(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#photoTake')]);
    expect(await fc.element().getAttribute('capture')).toBe('environment');
    expect(page.url()).toMatch(/#\/photo$/);
    await fc.setFiles([]);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

describe('Share unseen after the phone stopped the app', () => {
  it('opens Share unseen again when the app restarts while a picker was up, once', async () => {
    const { ctx, page, errors } = await phone();
    await openPhoto(page);
    // Pick a photo: the picker is up when the phone stops the app (a second page opens it afresh, as
    // Android does; the first page never closes, as a stopped one never does).
    await Promise.all([page.waitForEvent('filechooser'), page.click('#photoPick')]);
    expect(await page.evaluate(() => localStorage.getItem('forge2.picking'))).toMatch(/^\d+$/);
    const fresh = await ctx.newPage();
    fresh.on('pageerror', (e) => errors.push(e.message));
    await fresh.goto(`${g.url}/v2/`);
    await fresh.waitForSelector('[data-screen=photo] #photoNote');
    expect(await fresh.textContent('#photoNote')).toContain('Forge restarted, so the photo did not arrive.');
    expect(await fresh.locator('#photoAlert').count()).toBe(0);
    expect(fresh.url()).toMatch(/#\/photo$/);
    expect(await fresh.evaluate(() => localStorage.getItem('forge2.picking'))).toBeNull();
    await fresh.screenshot({ path: join(SHOTS, 'restarted.png') });
    // The person picks again, and the photo is checked.
    await fresh.setInputFiles('#photoFile', { name: 'IMG_3.jpg', mimeType: 'image/jpeg', buffer: CREW });
    await fresh.waitForSelector('#photoChanges', { timeout: 60_000 });
    // The next open is the home again.
    await fresh.goto(`${g.url}/v2/`);
    await fresh.waitForSelector('[data-screen=home]');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('a picker that closed with the app running leaves no mark: the next open is the home', async () => {
    const { ctx, page, errors } = await phone();
    await openPhoto(page);
    const [fc] = await Promise.all([page.waitForEvent('filechooser'), page.click('#photoPick')]);
    await fc.setFiles({ name: 'IMG_4.jpg', mimeType: 'image/jpeg', buffer: CREW });
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    expect(await page.evaluate(() => localStorage.getItem('forge2.picking'))).toBeNull();
    const fresh = await ctx.newPage();
    await fresh.goto(`${g.url}/v2/`);
    await fresh.waitForSelector('[data-screen=home]');
    // An old mark (the phone stopped the app long ago) opens the home too, and is taken away.
    await fresh.evaluate(() => localStorage.setItem('forge2.picking', String(Date.now() - 11 * 60_000)));
    const third = await ctx.newPage();
    await third.goto(`${g.url}/v2/`);
    await third.waitForSelector('[data-screen=home]');
    expect(await third.evaluate(() => localStorage.getItem('forge2.picking'))).toBeNull();
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
