import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Midnight is the default look (owner, 2026-11-15: "let's make the home screen midnight by default").
// A phone where nobody picked a look opens on Midnight, from the very first paint; a Light picked in
// More, Mode and look stays Light. Every screen is checked for text and parts that read too faintly on
// the black ground. Screenshots for the owner are kept under .tmp/midnight/.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = join(import.meta.dirname, '../../.tmp/midnight');
const NIGHT = 'rgb(11, 13, 16)';
const LIGHT = 'rgb(246, 245, 241)';

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    audio: true,
    env: { FORGE_INVITE_ONLY: 'true' },
    editCatalog: (c) => {
      // A model with a small memory, so one long question fills most of it.
      const echo = c.models.find((m: any) => m.id === 'mock-echo');
      c.models.push({ ...echo, id: 'mock-small', name: 'Small memory', upstream: 'mock-echo', context_length: 1900, max_output_tokens: 64 });
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'glm-5.3-flash', name: 'GLM Flash', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function phone({ seen = true } = {}) {
  const ctx = await browser.newContext(PHONE);
  if (seen) await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 401: a free model with no key; 402: a paid one at $0; 403: a wrong invite code, on purpose.
  page.on('console', (m) => m.type() === 'error' && !/40[123]/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  // A toast (a model chosen) goes first, so it does not cover the picture.
  await page.waitForFunction(() => !document.querySelector('#toast.show'), null, { timeout: 8000 });
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, name) });
}

async function fundedKey(cents = 300): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', cents);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

async function zeroKey(): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`open failed: ${JSON.stringify(b)}`);
  return b.key;
}

async function useModel(page: Page, id: string) {
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click(`[data-model="${id}"]`);
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
}

async function withKey(page: Page, key: string, model = 'mock-echo') {
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await useModel(page, model);
  await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toMatch(/^\$/);
}

const bodyBg = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
const themeColor = (page: Page) => page.getAttribute('meta[name="theme-color"]', 'content');

/**
 * Text on the screen that reads below WCAG AA against what is behind it: 4.5 to 1, or 3 to 1 for large
 * text (24 px, or 18.66 px bold). The ground is the nearest solid background up the tree; text over a
 * picture or a gradient is left out (the wallet cards' art), as is text in a disabled control. The
 * amount on the Funds coin sits on a picture too: coinInk checks it against the coin. Icons are
 * graphics: 3 to 1.
 */
const lowContrast = (page: Page, root = 'body') =>
  page.evaluate((root) => {
    const rgba = (s: string) => (s.match(/[\d.]+/g) ?? []).map(Number);
    const lum = ([r, g, b]: number[]) => {
      const c = [r!, g!, b!].map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    };
    const mix = (fg: number[], bg: number[]) => {
      const a = fg[3] ?? 1;
      return [0, 1, 2].map((i) => fg[i]! * a + bg[i]! * (1 - a));
    };
    const ground = (n: Element): number[] | null => {
      const layers: number[][] = [];
      for (let e: Element | null = n; e; e = e.parentElement) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== 'none') return null;
        const c = rgba(cs.backgroundColor);
        if ((c[3] ?? 1) > 0) {
          layers.push(c);
          if ((c[3] ?? 1) >= 1) break;
        }
      }
      if (!layers.length) return null;
      let bg = layers.pop()!.slice(0, 3);
      while (layers.length) bg = mix(layers.pop()!, bg);
      return bg;
    };
    const out: string[] = [];
    const walker = document.createTreeWalker(document.querySelector(root)!, NodeFilter.SHOW_TEXT);
    for (let t = walker.nextNode(); t; t = walker.nextNode()) {
      if (!t.textContent?.trim()) continue;
      const e = t.parentElement!;
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const cs = getComputedStyle(e);
      if (cs.visibility === 'hidden' || e.closest('[hidden], [aria-hidden=true], :disabled, .sr-only, .funds-ring-mid')) continue;
      let op = 1;
      for (let x: Element | null = e; x; x = x.parentElement) op *= Number(getComputedStyle(x).opacity);
      if (op < 0.99) continue;
      const bg = ground(e);
      if (!bg) continue;
      const fg = mix(rgba(cs.color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi! + 0.05) / (lo! + 0.05);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
      if (ratio < (large ? 3 : 4.5)) out.push(`${(e.id || e.className || e.tagName).toString().slice(0, 40)} "${t.textContent.trim().slice(0, 30)}" ${ratio.toFixed(2)}`);
    }
    for (const svg of document.querySelector(root)!.querySelectorAll('svg.ico')) {
      const r = svg.getBoundingClientRect();
      if (!r.width || !r.height || r.bottom < 0 || r.top > innerHeight) continue;
      const host = svg.parentElement!;
      if (getComputedStyle(svg).visibility === 'hidden' || host.closest('[hidden], :disabled, .sr-only, .way-card, .stack-card')) continue;
      let op = 1;
      for (let x: Element | null = svg as Element; x; x = x.parentElement) op *= Number(getComputedStyle(x).opacity);
      if (op < 0.99) continue;
      const bg = ground(host);
      if (!bg) continue;
      const fg = mix(rgba(getComputedStyle(svg).color), bg);
      const [hi, lo] = [lum(fg), lum(bg)].sort((a, b) => b - a);
      const ratio = (hi! + 0.05) / (lo! + 0.05);
      if (ratio < 3) out.push(`icon in ${(host.id || host.className || host.tagName).toString().slice(0, 40)} ${ratio.toFixed(2)}`);
    }
    return out;
  }, root);

/** The contrast of the Funds coin's amount and FREE against the coin's face (#F6F5F1, or #E3F4F0 when free). */
const coinInk = (page: Page) =>
  page.evaluate(() => {
    const lum = (c: number[]) => {
      const v = c.map((x) => x / 255).map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
      return 0.2126 * v[0]! + 0.7152 * v[1]! + 0.0722 * v[2]!;
    };
    const ratio = (sel: string, face: number[]) => {
      const n = document.querySelector(sel) as HTMLElement;
      if (!n || n.hidden) return null;
      const [a, b] = [lum((getComputedStyle(n).color.match(/[\d.]+/g) ?? []).map(Number).slice(0, 3)), lum(face)].sort((x, y) => y - x);
      return Math.round(((a! + 0.05) / (b! + 0.05)) * 100) / 100;
    };
    return { amount: ratio('#fundsAmount', [0xf6, 0xf5, 0xf1]), free: ratio('#fundsFreeTag', [0xe3, 0xf4, 0xf0]) };
  });

describe('Midnight, the default look', () => {
  it('a fresh profile opens on Midnight, and More, Mode and look shows it chosen', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    expect(await bodyBg(page)).toBe(NIGHT);
    expect(await themeColor(page)).toBe('#0B0D10');
    expect(await page.evaluate(() => document.documentElement.dataset.scheme)).toBe('dark');
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.waitForSelector('[data-screen=look]');
    expect(await page.getAttribute('#look-midnight', 'aria-checked')).toBe('true');
    expect(await page.getAttribute('#look-light', 'aria-checked')).toBe('false');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('paints the first frame dark for a default user, before the app has loaded', async () => {
    const { ctx, page } = await phone();
    // The app's script never arrives: what shows is index.html's own first paint.
    await page.route('**/v2/app.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    const first = async () => {
      await page.goto(`${g.url}/v2/`, { waitUntil: 'domcontentloaded' });
      return page.evaluate(() => ({
        bg: getComputedStyle(document.body).backgroundColor,
        bar: document.querySelector('meta[name="theme-color"]')!.getAttribute('content'),
        tracks: [...document.querySelectorAll('.boot circle')].map((c) => getComputedStyle(c).stroke),
      }));
    };
    expect(await first()).toEqual({ bg: NIGHT, bar: '#0B0D10', tracks: ['rgb(58, 51, 32)', 'rgb(22, 48, 44)'] });
    // A light look kept from before Midnight was the default, never picked: still Midnight.
    const light = { bg: '#F6F5F1', 'gold-track': '#F3E3BC', 'memory-track': '#D5F2EA' };
    await page.evaluate((tokens) => localStorage.setItem('forge2.look', JSON.stringify({ tokens, scheme: 'light' })), light);
    expect((await first()).bg).toBe(NIGHT);
    // A look the app kept since (Light, picked): that look.
    await page.evaluate((tokens) => localStorage.setItem('forge2.look', JSON.stringify({ look: 'light', tokens, scheme: 'light' })), light);
    expect(await first()).toEqual({ bg: LIGHT, bar: '#F6F5F1', tracks: ['rgb(243, 227, 188)', 'rgb(213, 242, 234)'] });
    await ctx.close();
  }, 60_000);

  it('keeps Light once the person picks it, across a reload', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.waitForSelector('[data-screen=look]');
    await page.click('#look-light');
    expect(await bodyBg(page)).toBe(LIGHT);
    await page.waitForTimeout(300); // the choice is written to IndexedDB
    await page.reload();
    await page.waitForSelector('[data-screen=look]');
    expect(await page.getAttribute('#look-light', 'aria-checked')).toBe('true');
    expect(await bodyBg(page)).toBe(LIGHT);
    expect(await themeColor(page)).toBe('#F6F5F1');
    // And from the first paint of the next start.
    await page.route('**/v2/app.js', (r) => r.fulfill({ contentType: 'text/javascript', body: '' }));
    await page.goto(`${g.url}/v2/`, { waitUntil: 'domcontentloaded' });
    expect(await bodyBg(page)).toBe(LIGHT);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('every screen reads well in Midnight', () => {
  it('home with money, Funds, Type, the answer and the home with memory low', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await withKey(page, await fundedKey(), 'mock-small');
    await page.waitForSelector('#talkBtn');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'home-1-money.png');

    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toMatch(/^\$/);
    expect(await lowContrast(page)).toEqual([]);
    expect((await coinInk(page)).amount).toBeGreaterThanOrEqual(4.5);
    await shot(page, 'funds.png');

    // A short question: the answer screen with its small rings.
    const ask = async (q: string) => {
      await page.goto(`${g.url}/v2/#/type`);
      await page.waitForSelector('[data-screen=type]');
      await page.fill('#question', q);
      expect(await lowContrast(page)).toEqual([]);
      await page.click('#sendBtn');
      await page.waitForSelector('[data-screen=answer]');
      await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    };
    await ask('Which roads does the market notice cover?');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'answer.png');
    // A long one fills the small memory.
    await ask(`Please read this. ${'The street notice covers the market and the side roads. '.repeat(112)}`);

    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('#memoryLow:not([hidden])');
    expect(await page.locator('.home-rings .ring-memory').evaluate((n) => getComputedStyle(n).stroke)).toBe('rgb(240, 144, 74)');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'home-3-memory-low.png');

    await page.goto(`${g.url}/v2/#/more/history`);
    await page.waitForSelector('[data-screen=history]');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'history.png');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('the $0 home on a free model, Add money, Start free, and Type with the funds notice', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/`);
    await useModel(page, 'glm-5.3-flash');
    await page.waitForSelector('#freeModelChip:not([hidden])');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'home-2-free.png');

    // Funds at $0 on the free model: FREE on the coin, and Ask now.
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('#fundsFreeTag:not([hidden])');
    expect(await lowContrast(page)).toEqual([]);
    const coin = await coinInk(page);
    expect(coin.amount).toBeGreaterThanOrEqual(4.5);
    expect(coin.free).toBeGreaterThanOrEqual(4.5);
    await shot(page, 'funds-free.png');

    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-note');
    await page.click('#tab-note');
    await page.click('#wayInfoBtn-note');
    await page.waitForSelector('#wayInfo-note:not([hidden])');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'add-money-note.png');

    await page.goto(`${g.url}/v2/#/funds/start-free`);
    await page.waitForSelector('[data-screen=startFree]');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'start-free.png');

    // A $0 balance on a private (paid) model: Type says to add funds, with the free model next to it.
    await useModel(page, 'mock-echo');
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), await zeroKey());
    await page.goto(`${g.url}/v2/#/type`);
    await page.reload();
    await page.waitForSelector('#typeNotice:not([hidden])');
    await page.waitForSelector('#noticeFreeBtn');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'type-funds-notice.png');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('Start free: a wrong code, the one question, then Funds at $0 with Ask now', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/#/funds/start-free`);
    await page.waitForSelector('[data-screen=startFree]');
    await page.fill('#startFreeCode', 'not-a-code');
    await page.click('#startFreeGo');
    await expect.poll(() => page.textContent('#startFreeMsg')).toBe('This invite code does not work. Check it and try again.');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'start-free-wrong-code.png');
    await page.fill('#startFreeCode', createInvite(g));
    await page.click('#startFreeGo');
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'start-free-question.png');
    await page.click('#startFreeUse');
    await page.waitForSelector('#fundsAsk:not([hidden])');
    expect(await lowContrast(page)).toEqual([]);
    const coin = await coinInk(page);
    expect(coin.amount).toBeGreaterThanOrEqual(4.5);
    expect(coin.free).toBeGreaterThanOrEqual(4.5);
    await shot(page, 'funds-start-free.png');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('More, the model picker, the look, voice, and the sheets', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/#/more`);
    await page.waitForSelector('#moreSheet');
    expect(await lowContrast(page, '#moreSheet')).toEqual([]);
    await shot(page, 'more.png');

    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-model]');
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'model-picker.png');

    for (const [route, screen] of [
      ['more/look', 'look'],
      ['more/voice', 'voice'],
      ['more/erase', 'erase'],
      ['more/engine', 'engine'],
      ['add', null],
      ['funds/out', 'takeOut'],
      ['voice-lab', 'voiceLab'],
    ] as const) {
      await page.goto(`${g.url}/v2/#/${route}`);
      await page.waitForSelector(screen ? `[data-screen=${screen}]` : route === 'add' ? '#addSheet' : 'main');
      await page.waitForTimeout(300);
      expect(await lowContrast(page, route === 'add' ? '#addSheet' : 'body'), route).toEqual([]);
      await shot(page, `x-${route.replace(/\//g, '-')}.png`);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('the download page on a phone that keeps Midnight', async () => {
    const { ctx, page } = await phone();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.goto(`${g.url}/v2/download/`);
    await page.waitForSelector('[data-screen=download]');
    expect(await bodyBg(page)).toBe(NIGHT);
    expect(await lowContrast(page)).toEqual([]);
    await shot(page, 'x-download.png');
    await ctx.close();
  }, 60_000);
});

describe('Light and Dark still read well', () => {
  for (const look of ['light', 'dark'])
    it(`${look}: home, Funds, Add money, Start free, Type and the model picker`, async () => {
      const { ctx, page, errors } = await phone();
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${g.url}/v2/#/more/look`);
      await page.waitForSelector('[data-screen=look]');
      await page.click(`#look-${look}`);
      await page.waitForTimeout(300);
      await withKey(page, await fundedKey());
      expect(await bodyBg(page)).toBe(look === 'light' ? LIGHT : 'rgb(22, 27, 36)');
      const bad: Record<string, string[]> = {};
      for (const route of ['', 'funds', 'funds/add', 'funds/start-free', 'type', 'more/model', 'more/look', 'more/voice', 'more/history']) {
        await page.goto(`${g.url}/v2/#/${route}`);
        await page.waitForSelector('main[data-screen]');
        await page.waitForTimeout(250);
        const b = await lowContrast(page);
        if (b.length) bad[route] = b;
      }
      await page.goto(`${g.url}/v2/#/funds`);
      await expect.poll(() => page.textContent('#fundsAmount')).toMatch(/^\$/);
      expect((await coinInk(page)).amount).toBeGreaterThanOrEqual(4.5);
      expect(bad).toEqual({});
      expect(errors).toEqual([]);
      await ctx.close();
    }, 90_000);
});
