import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { readConfig, writeBundle } from '../../scripts/lib/android-web.ts';
import { type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The web app as the Android app carries it: the bundle the Gradle build writes into the APK
// (scripts/android-web.ts), served from its own origin the way Capacitor serves it at https://localhost
// (any address without a file opens index.html). The engine is a local gateway on another origin, so
// every call is cross-origin, as in the app. A stand-in for Capacitor's bridge plays the app's plugins:
// it hands in a shared photo and records what goes to the share sheet. Nothing reaches the real engine:
// the default engine's address is answered here with a refusal.
const ROOT = resolve(import.meta.dirname, '..', '..');
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const CREW = readFileSync(resolve(ROOT, 'test/unit/fixtures/photos/crew.jpg'));
const PROD = 'https://ai.forge-reserve.com';
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json' };

let g: Gateway;
let browser: Browser;
let site: Server;
let app: string;
let bundleDir: string;

/** Serves the bundle like Capacitor's local server: a file if there is one, else index.html. */
function serveBundle(dir: string): Promise<Server> {
  const s = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    // With the isolation headers MainActivity adds to the app's own files (IsolationRules.kt).
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cross-origin-opener-policy': 'same-origin', 'cross-origin-embedder-policy': 'require-corp', 'cross-origin-resource-policy': 'same-origin' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false' } });
  const assets = mkdtempSync(join(tmpdir(), 'forge-apk-assets-'));
  writeBundle(join(ROOT, 'public'), assets, readConfig(join(ROOT, 'capacitor.config.json')));
  bundleDir = join(assets, 'public');
  site = await serveBundle(bundleDir);
  app = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
  await g?.close();
});

interface AppPhone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  /** Requests that tried to leave this computer. */
  outside: string[];
}

async function appPhone(): Promise<AppPhone> {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  // Capacitor's bridge, as the app's web view has it, with the app's two plugins played here.
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__native = { calls: [] as any[], listeners: [] as any[], shared: null as any };
    w.Capacitor = {
      isNativePlatform: () => true,
      nativePromise: async (plugin: string, method: string, opts: any) => {
        w.__native.calls.push({ plugin, method, opts });
        if (plugin === 'ForgeShareIn' && method === 'waiting') return { waiting: !!w.__native.shared };
        if (plugin === 'ForgeShareIn' && method === 'take') {
          const s = w.__native.shared;
          w.__native.shared = null;
          return s ?? {};
        }
        if (plugin === 'ForgeShare' && method === 'share') return { opened: true };
        if (plugin === 'ForgeShare' && method === 'save') return { saved: true };
        return undefined;
      },
      addListener: (plugin: string, event: string, fn: () => void) => {
        w.__native.listeners.push({ plugin, event, fn });
        return { remove: async () => {} };
      },
    };
    // What ForgeShareIn does when another app shares a photo while Forge is open.
    w.__shareIn = (data: string) => {
      w.__native.shared = { mime: 'image/jpeg', data };
      for (const l of w.__native.listeners) if (l.plugin === 'ForgeShareIn' && l.event === 'shared') l.fn();
    };
  });
  const outside: string[] = [];
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    outside.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors, outside };
}

describe('the Android app\'s web bundle, from its own origin', () => {
  it('starts on Forge\'s engine, switches engine in More, funds, asks and streams the answer across origins', async () => {
    const { ctx, page, errors, outside } = await appPhone();
    await page.goto(`${app}/`);
    await page.waitForSelector('[data-screen=home]');
    // The default engine is Forge's: the app asked it for its models (answered here with a refusal).
    await expect.poll(() => outside.some((u) => u.startsWith(`${PROD}/v1/models`))).toBe(true);
    expect(outside.every((u) => u.startsWith(`${PROD}/`))).toBe(true);
    // No service worker in the app: its files are in the APK.
    expect(await page.evaluate(() => navigator.serviceWorker.getRegistrations().then((r) => r.length))).toBe(0);

    // More lists the engine, and Mode and look has no Classic (the app carries only v2).
    await page.click('#btn-more');
    expect(await page.textContent('#moreEngine')).toContain('ai.forge-reserve.com');
    expect(await page.textContent('#moreLook')).toContain('Light, Dark, Midnight');
    await page.click('#moreLook');
    await page.waitForSelector('[data-screen=look]');
    expect(await page.locator('#modeClassic').count()).toBe(0);
    // Back goes to the More sheet.
    await page.goBack();
    await page.waitForSelector('#moreSheet');

    // Engine: refuses plain http to another computer, then switches to the local engine.
    await page.click('#moreEngine');
    await page.waitForSelector('[data-screen=engine]');
    expect(await page.textContent('#engineNow')).toBe('In use: ai.forge-reserve.com');
    expect(await page.isVisible('#engineDefault')).toBe(false);
    await page.fill('#engineAddress', 'http://ai.example.org');
    await page.click('#engineUse');
    expect(await page.textContent('#engineMsg')).toBe('Use an address that starts with https.');
    await page.fill('#engineAddress', 'https://ai.forge-reserve.com/');
    await page.click('#engineUse');
    expect(await page.textContent('#engineMsg')).toBe('Forge already uses this engine.');
    await page.fill('#engineAddress', 'https://ai.example.org');
    await page.click('#engineUse');
    await expect.poll(() => page.textContent('#engineMsg')).toBe('That engine did not answer. Check the address and try again.');
    await page.fill('#engineAddress', `${g.url}/`);
    await Promise.all([page.waitForEvent('load'), page.click('#engineUse')]);
    await page.waitForSelector('[data-screen=home]');
    await page.click('#btn-more');
    expect(await page.textContent('#moreEngine')).toContain(g.url);
    await page.click('#btn-more');

    // Add funds with eCash: the engine on the other origin opens the balance.
    await page.click('#balanceText');
    await page.waitForSelector('[data-screen=funds]');
    await page.click('#addFundsBtn');
    await page.click('#fund-ecash');
    await page.fill('#ecashToken', await mintToken(MINT_A, 'usd', 500));
    await page.click('#ecashAdd');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$5.00');
    // The key is kept under the engine's name, apart from any balance of the app's own origin.
    expect(await page.evaluate((u) => localStorage.getItem(`forge.balanceKey@${u}`), g.url)).toMatch(/^sk-forge-/);

    // A standard model (Private only off), then a typed question, streamed back.
    await page.goto(`${app}/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    await page.click('[data-model="mock-echo"]');
    await page.goto(`${app}/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'What should I bring?');
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(((await page.textContent('#answerText')) ?? '').length).toBeGreaterThan(5);
    expect(await page.textContent('#answerNote')).toMatch(/^That cost /);
    await page.goto(`${app}/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).not.toBe('$5.00');

    // Use the default again: back on Forge's engine, whose balance is a different one.
    await page.goto(`${app}/#/more/engine`);
    await page.waitForSelector('[data-screen=engine]');
    expect(await page.isVisible('#engineDefault')).toBe(true);
    const before = outside.length;
    await page.route(`${PROD}/v1/models`, (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ object: 'list', data: [] }) }));
    await Promise.all([page.waitForEvent('load'), page.click('#engineDefault')]);
    await page.waitForSelector('[data-screen=home]');
    await page.unroute(`${PROD}/v1/models`);
    await expect.poll(() => page.textContent('#balanceText')).toBe('Add funds');
    expect(outside.slice(before).every((u) => u.startsWith(`${PROD}/`))).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('carries the natural voice: isolated, nothing to download, and it reads from the bundle with nothing kept twice', async () => {
    const { ctx, page, errors, outside } = await appPhone();
    await page.goto(`${app}/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.waitForSelector('#voiceOut-phonon');
    expect(await page.getAttribute('#voiceOut-phonon', 'aria-checked')).toBe('true');
    expect(await page.textContent('#voiceOut-phonon')).toBe('Natural voiceFree. Made on this phone, so the answer is not sent anywhere.');
    // The voice lab, one way only: the model loads from the bundle on several threads.
    await page.goto(`${app}/#/voice-lab`);
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    for (const id of ['phonon-cpu-single', 'phonon-webgpu', 'phone-voice']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '3');
    await page.click('#labRun');
    await page.waitForSelector('#labSave:not([hidden])', { timeout: 120_000 });
    expect(await page.textContent('#labResults')).toMatch(/several threads/);
    expect(await page.textContent('#labStatus')).toMatch(/^Done\./);
    // Read straight from the bundle: no copy in Cache Storage, and nothing fetched from elsewhere.
    expect(await page.evaluate(() => caches.has('phonon-tts-v1'))).toBe(false);
    expect(outside.filter((u) => !u.startsWith('https://ai.forge-reserve.com/'))).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);

  it('opens Share unseen with a photo shared in, and shares only the protected copy out', async () => {
    const { ctx, page, errors, outside } = await appPhone();
    await page.goto(`${app}/`);
    await page.waitForSelector('[data-screen=home]');
    await page.evaluate((b64) => (window as any).__shareIn(b64), CREW.toString('base64'));
    await page.waitForSelector('[data-screen=photo]');
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    // The photo was taken from the app once.
    const calls = () => page.evaluate(() => (window as any).__native.calls.map((c: any) => `${c.plugin}.${c.method}`));
    expect((await calls()).filter((c: string) => c === 'ForgeShareIn.take')).toHaveLength(1);
    await page.click('#photoShare');
    await expect.poll(async () => (await calls()).includes('ForgeShare.share')).toBe(true);
    const sent = await page.evaluate(() => (window as any).__native.calls.find((c: any) => c.method === 'share').opts);
    expect(sent.mime).toBe('image/jpeg');
    expect(sent.name).toMatch(/\.jpg$/);
    const out = Buffer.from(sent.data, 'base64');
    expect(out.equals(CREW)).toBe(false);
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    // No "Shared" toast: the app is not told whether the person sent it.
    expect(await page.locator('.toast', { hasText: 'Shared' }).count()).toBe(0);
    // Leaving Share unseen asks the app to remove the photo files it wrote.
    await page.click('.back-head .round');
    await page.waitForSelector('[data-screen=home]');
    expect(await calls()).toContain('ForgeShare.forget');
    expect(outside.every((u) => u.startsWith(`${PROD}/`))).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('opens straight on Share unseen when the app was started by a share', async () => {
    const { ctx, page, errors } = await appPhone();
    await ctx.addInitScript((b64) => ((window as any).__native.shared = { mime: 'image/jpeg', data: b64 }), CREW.toString('base64'));
    await page.goto(`${app}/`);
    await page.waitForSelector('[data-screen=photo]');
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    expect(await page.isVisible('#photoShare')).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('says so when a share held no photo', async () => {
    const { ctx, page } = await appPhone();
    await page.goto(`${app}/`);
    await page.waitForSelector('[data-screen=home]');
    await page.evaluate(() => {
      const w = window as any;
      w.__native.shared = { problem: 'none' };
      for (const l of w.__native.listeners) if (l.event === 'shared') l.fn();
    });
    await page.waitForSelector('#photoAlert');
    expect(await page.textContent('#photoAlert')).toContain('No photo came with that share.');
    await ctx.close();
  }, 60_000);
});

describe('the /download page', () => {
  it('offers the APK with its size and SHA-256, and says the app is coming when there is none', async () => {
    const bytes = Buffer.from('PK\u0003\u0004'.padEnd(300_000, 'x'));
    const file = join(mkdtempSync(join(tmpdir(), 'forge-apk-')), 'forge.apk');
    writeFileSync(file, bytes);
    const withApk = await startGateway({ env: { FORGE_APK_PATH: file } });
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${withApk.url}/download`);
      await page.waitForSelector('#downloadHash');
      expect(await page.textContent('h1')).toBe('Forge for Android');
      expect((await page.textContent('#downloadHash'))!.replaceAll(' ', '')).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(await page.textContent('#downloadApk')).toBe('Download the app, 0.3 MB');
      expect(await page.getAttribute('#downloadApk', 'href')).toBe('/download/forge.apk');
      expect(await page.locator('#downloadSteps li').count()).toBe(4);
      const got = await page.evaluate(async () => {
        const r = await fetch('/download/forge.apk');
        return { type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
      });
      expect(got).toEqual({ type: 'application/vnd.android.package-archive', size: bytes.length });

      // This gateway has no APK set.
      await page.goto(`${g.url}/download`);
      await page.waitForSelector('#downloadComing');
      expect(await page.textContent('#downloadComing')).toBe('The Android app is coming soon. Forge works in this browser now.');
      expect(await page.getAttribute('#openWeb', 'href')).toBe('/v2/');
      expect(await page.locator('#downloadApk').count()).toBe(0);
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
      await withApk.close();
    }
  }, 60_000);
});
