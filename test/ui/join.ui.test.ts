import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';

// The event link (docs/ANDROID.md, Event links): one QR code, /j#<pass>, for a room full of people. On
// an iPhone or a computer /j sends the web app /v2/#join=<pass>, which opens a free balance with the pass,
// drops it from the address, ends the first run and asks the Private only question once; then the home,
// ready to talk on a free model. On Android /j shows two steps: get the app, open the app on the pass.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const SHOTS = join(import.meta.dirname, '../../.tmp/join');
const DAY = 24 * 3600 * 1000;

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  const dir = mkdtempSync(join(tmpdir(), 'forge-join-apk-'));
  const apk = join(dir, 'forge.apk');
  const pv = join(dir, 'forge-private-voice.apk');
  writeFileSync(apk, Buffer.from('PK\u0003\u0004'.padEnd(3_300_000, 'x')));
  writeFileSync(pv, Buffer.from('PK\u0003\u0004'.padEnd(71_000_000 / 10, 'y')));
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true', FORGE_APK_PATH: apk, FORGE_APK_PRIVATE_VOICE_PATH: pv },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'glm-5.3-flash', name: 'GLM Flash', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

const pass = (uses = 5) => g.deps.passes.create({ maxUses: uses, expiresAt: Date.now() + DAY, label: 'ui' });
const uses = (id: string) => (g.deps.db.prepare('SELECT uses FROM passes WHERE id = ?').get(id) as { uses: number }).uses;

/** A phone on a clean profile (the first run not seen), with its page errors kept. */
async function phone(userAgent?: string) {
  const ctx = await browser.newContext({ ...PHONE, ...(userAgent ? { userAgent } : {}) });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 401: the free model asked about with no key yet; 403: a refused pass, on purpose.
  page.on('console', (m) => m.type() === 'error' && !/40[13]/.test(m.text()) && errors.push(m.text()));
  page.on('response', (r) => r.status() === 404 && errors.push(`404 ${r.url()}`));
  return { ctx, page, errors };
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(SHOTS, name) });
}

const balanceKey = (page: Page) => page.evaluate(() => localStorage.getItem('forge.balanceKey'));

describe('the web app opened on an event pass (/v2/#join=<pass>)', () => {
  it('opens a free balance, drops the pass from the address, asks once, and lands on the home ready to talk', async () => {
    const p = pass();
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#join=${p.code}`);
    // Not the first run: the balance is opened and Start free's question is asked over its screen.
    await page.waitForSelector('[data-screen=startFree] #startFreeAsk:not([hidden])');
    expect(await page.isVisible('#startFreeOpened')).toBe(true);
    expect(page.url()).not.toContain(p.code);
    expect(page.url()).not.toContain('join');
    expect(await balanceKey(page)).toMatch(/^sk-forge-/);
    expect(uses(p.id)).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem('forge2.firstRun'))).toBe('done');
    await shot(page, '1-joined-ask.png');

    await page.click('#startFreeUse');
    await page.waitForSelector('[data-screen=home]');
    expect(page.url()).not.toContain(p.code);
    await expect.poll(() => page.textContent('#toast')).toContain('GLM Flash, a free model');
    await shot(page, '2-home.png');

    // Ready to talk: a typed question goes to the free model and is answered at $0.
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'Hello from the hackathon');
    await expect.poll(() => page.textContent('#priceLine')).toBe('PriceFree');
    await page.click('#sendBtn');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(await page.textContent('#answerNote')).toBe('That was free.');
    const key = (await balanceKey(page))!;
    const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(w).toMatchObject({ balance_msub: 0 });

    // Opened again, it is the home: the first run is over and nothing was kept in the address.
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    expect(uses(p.id)).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('keeps Private only on when the person says Keep, and still lands on the home', async () => {
    const p = pass();
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#join=${p.code}`);
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    await page.click('#startFreeKeep');
    await page.waitForSelector('[data-screen=home]');
    expect(await balanceKey(page)).toMatch(/^sk-forge-/);
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('true');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('spends nothing on a phone that already has a balance key', async () => {
    const p = pass();
    const { ctx, page, errors } = await phone();
    const first = pass();
    await page.goto(`${g.url}/v2/#join=${first.code}`);
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    await page.click('#startFreeUse');
    await page.waitForSelector('[data-screen=home]');
    const key = await balanceKey(page);
    await page.goto(`${g.url}/v2/#join=${p.code}`);
    await page.waitForSelector('[data-screen=home]');
    await page.waitForFunction(() => document.documentElement.dataset.ready === '1');
    // Give a stray open the time it would need, then check it did not happen.
    await page.waitForTimeout(800);
    expect(page.url()).not.toContain(p.code);
    expect(await balanceKey(page)).toBe(key);
    expect(uses(p.id)).toBe(0);
    expect(await page.isVisible('#startFreeAsk')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('says a used-up pass in a toast and goes on to the first run, with no balance', async () => {
    const p = pass(1);
    await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: p.code }) });
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#join=${p.code}`);
    await expect.poll(() => page.textContent('#toast').catch(() => '')).toContain('Code used up.');
    await page.waitForSelector('[data-screen=intro]');
    expect(page.url()).not.toContain(p.code);
    expect(await balanceKey(page)).toBeNull();
    expect(uses(p.id)).toBe(1);
    await shot(page, '3-used-up.png');
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

describe('the event link /j#<pass>', () => {
  it('sends an iPhone straight into the web app on the pass', async () => {
    const p = pass();
    const { ctx, page, errors } = await phone(IPHONE_UA);
    await page.goto(`${g.url}/j#${p.code}`);
    await page.waitForSelector('[data-screen=startFree] #startFreeAsk:not([hidden])');
    expect(new URL(page.url()).pathname).toBe('/v2/');
    expect(page.url()).not.toContain(p.code);
    expect(uses(p.id)).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('sends a computer there too, and a link with no pass to /download', async () => {
    const p = pass();
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${g.url}/j#${p.code}`);
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    expect(new URL(page.url()).pathname).toBe('/v2/');
    await page.goto(`${g.url}/j`);
    await page.waitForURL(/\/download$/);
    await page.waitForSelector('[data-screen=download]');
    await ctx.close();
  });

  it('shows Android the two steps: get the app, open it on the pass, and a small Use in browser', async () => {
    const p = pass();
    const { ctx, page, errors } = await phone(ANDROID_UA);
    await page.goto(`${g.url}/j#${p.code}`);
    await page.waitForSelector('[data-screen=join]');
    expect(new URL(page.url()).pathname).toBe('/j');
    expect(await page.textContent('h1')).toBe('Join Forge');
    expect(await page.textContent('#joinStep1 h2')).toBe('1Get the app');
    expect(await page.textContent('#joinStep2 h2')).toBe('2Open the app');
    // Step 1: the /download page's APKs, Android first.
    expect(await page.getAttribute('#joinGet', 'href')).toBe('/download/forge.apk');
    expect(await page.textContent('#joinGet')).toBe('Download the app, 3.1 MB');
    expect(await page.getAttribute('#apk-android', 'aria-checked')).toBe('true');
    // Step 2: the intent link to Forge, on the pass, back here when the app is not there.
    const host = new URL(g.url).host;
    const fallback = encodeURIComponent(`${g.url}/j?app=none#${p.code}`);
    expect(await page.getAttribute('#joinOpen', 'href')).toBe(`intent://${host}/j#${p.code}#Intent;scheme=https;package=com.forgereserve.ai;S.browser_fallback_url=${fallback};end`);
    expect(await page.getAttribute('#joinWeb', 'href')).toBe(`/v2/#join=${p.code}`);
    expect(await page.isVisible('#joinNoApp')).toBe(false);
    await shot(page, '4-android.png');

    // Forge Private Voice picked: its APK, and Open opens it; the pick is kept for the next visit.
    await page.click('#apk-graphene');
    expect(await page.getAttribute('#joinGet', 'href')).toBe('/download/forge-private-voice.apk');
    expect(await page.getAttribute('#joinOpen', 'href')).toContain(';package=com.forgereserve.ai.privatevoice;');
    await page.goto(`${g.url}/j?app=none#${p.code}`);
    await page.waitForSelector('[data-screen=join]');
    expect(await page.getAttribute('#apk-graphene', 'aria-checked')).toBe('true');
    expect(await page.getAttribute('#joinOpen', 'href')).toContain(';package=com.forgereserve.ai.privatevoice;');
    // Came back from Open with no app: step 1 says to get it first.
    expect(await page.isVisible('#joinNoApp')).toBe(true);
    expect(await page.textContent('#joinNoApp')).toContain('Get the app first.');
    await shot(page, '5-android-no-app.png');

    // Nothing was spent by the page itself; Use in browser opens the balance.
    expect(uses(p.id)).toBe(0);
    await page.click('#joinWeb');
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    expect(uses(p.id)).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
