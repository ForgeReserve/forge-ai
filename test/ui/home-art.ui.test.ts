import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay } from './ways.ts';

// The home's rings and talk button drawn to the first run's art standard (owner, 2026-11-15): the rings
// in a sunk groove with a lit fill, its glow and a bright tip where it ends, the talk button as a
// polished object with a lit microphone. The meaning stays: gold is funds, the inner ring is memory
// (orange when low), they fill with the real values, and the button holds to talk. Also the note's
// coin with its dollar sign. Screenshots for the owner are kept under .tmp/home-art/.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = join(import.meta.dirname, '../../.tmp/home-art');

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
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function phone(scale = PHONE.deviceScaleFactor) {
  const ctx = await browser.newContext({ ...PHONE, deviceScaleFactor: scale });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 401: a free model with no key; 402: a paid one at $0.
  page.on('console', (m) => m.type() === 'error' && !/40[12]/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

async function shot(page: Page, name: string, clip?: { x: number; y: number; width: number; height: number }) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  // A toast (Answer ready, a model chosen) goes first, so it does not cover the picture.
  await page.waitForFunction(() => !document.querySelector('#toast.show'), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, name), ...(clip ? { clip } : {}) });
}

async function fundedKey(cents = 300): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', cents);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
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

/** Opens the app with this balance key, on this model, at home. */
async function withKey(page: Page, key: string, model = 'mock-echo') {
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await useModel(page, model);
  await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toMatch(/^\$/);
}

/** Sets the balance's peak (the gold ring's full mark) to `times` the balance, as after spending. */
async function spendDown(page: Page, times: number) {
  await page.evaluate(async (times) => {
    const db: IDBDatabase = await new Promise((res, rej) => {
      const r = indexedDB.open('forge2', 1);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const store = () => db.transaction('kv', 'readwrite').objectStore('kv');
    const keys: IDBValidKey[] = await new Promise((res) => {
      const q = store().getAllKeys();
      q.onsuccess = () => res(q.result);
    });
    for (const k of keys.filter((k) => String(k).startsWith('peak:'))) {
      const v: number = await new Promise((res) => {
        const q = store().get(k);
        q.onsuccess = () => res(q.result);
      });
      await new Promise((res) => {
        const q = store().put(Math.round(v * times), k);
        q.onsuccess = res;
      });
    }
    db.close();
  }, times);
  await page.reload();
  await page.waitForSelector('[data-screen=home]');
}

const rings = (page: Page) =>
  page.locator('.home-rings .rings-svg').evaluate((s) => {
    const tip = (k: string) => {
      const t = s.querySelector(`.ring-band-${k} .ring-tip`) as SVGGElement;
      return { turn: Number(/rotate\(([\d.]+)deg\)/.exec(t.style.transform)?.[1] ?? NaN), shown: t.style.opacity !== '0' };
    };
    const ds = (s as SVGSVGElement).dataset;
    return { funds: Number(ds.funds), free: Number(ds.free), memory: Number(ds.memory), low: ds.low === 'true', gold: tip('gold'), memoryTip: tip('memory'), inner: getComputedStyle(s.querySelector('.ring-memory')!).stroke };
  });

const box = (page: Page, sel: string) => page.locator(sel).boundingBox().then((b) => b!);

describe('the home drawn to the art standard', () => {
  it('with money: the rings fill with the real values, each lit tip at its end, the button at the design size', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await withKey(page, await fundedKey());
    await spendDown(page, 5 / 3);
    // $3 of a $5 peak: 60 percent of the gold ring (942 long); memory all free.
    await expect.poll(async () => (await rings(page)).funds).toBe(565);
    const r = await rings(page);
    expect(r.gold).toEqual({ turn: 216, shown: true });
    expect(r.memory).toBe(760);
    expect(r.memoryTip).toEqual({ turn: 360, shown: true });
    expect(r.low).toBe(false);
    // The button keeps its size and place: 204 px in the 336 px rings, centred.
    const ringsBox = await box(page, '.home-rings');
    const talk = await box(page, '#talkBtn');
    expect(ringsBox.width).toBe(336);
    expect(Math.abs(talk.width - 204)).toBeLessThan(1);
    expect(Math.abs(talk.x + talk.width / 2 - (ringsBox.x + ringsBox.width / 2))).toBeLessThan(1);
    expect(Math.abs(talk.y + talk.height / 2 - (ringsBox.y + ringsBox.height / 2))).toBeLessThan(1);
    // The microphone is drawn, not a font glyph, and the button still reads Hold to talk.
    expect(await page.locator('#talkBtn svg.talk-mic').count()).toBe(1);
    expect((await page.textContent('#talkBtn'))!.trim()).toBe('Hold to talk');
    // Reduced motion: the rings jump to their values.
    expect(await page.locator('.home-rings .ring-paid').evaluate((n) => getComputedStyle(n).transitionDuration.split(',')[0])).toBe('0.001s');
    await shot(page, 'home-1-money.png');

    // Held: the button records (level bars, Let go to send) and nothing below it moves.
    const row = await box(page, '.bottom-row');
    const t = await box(page, '#talkBtn');
    await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
    await page.mouse.down();
    await page.waitForSelector('#talkBtn.recording');
    await expect.poll(() => page.textContent('#talkBtn')).toContain('Let go to send');
    expect(await page.isVisible('#talkBtn .talk-mic')).toBe(false);
    expect(await page.isVisible('#talkBtn .level-bars')).toBe(true);
    await page.waitForTimeout(700);
    await shot(page, 'home-4-held.png');
    expect(await box(page, '.bottom-row')).toEqual(row);
    // Slid off and let go: cancelled, nothing sent.
    await page.mouse.move(t.x + t.width / 2, t.y - 140, { steps: 4 });
    await page.mouse.up();
    await page.waitForSelector('#talkBtn:not(.recording)');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('at $0 on a free model: the gold ring empty and its tip hidden, the FREE chip under the rings', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/`);
    await useModel(page, 'glm-5.3-flash');
    await page.waitForSelector('#freeModelChip:not([hidden])');
    const r = await rings(page);
    expect(r.funds).toBe(0);
    expect(r.free).toBe(0);
    expect(r.gold.shown).toBe(false);
    expect(r.memoryTip.shown).toBe(true);
    await shot(page, 'home-2-free-model.png');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('with memory low: the inner ring turns orange, its tip at its end, and the chip shows', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await withKey(page, await fundedKey(), 'mock-small');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', `Please read this. ${'The street notice covers the market and the side roads. '.repeat(112)}`);
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    // The answer screen's smaller rings are drawn the same way.
    expect(await page.locator('.answer-rings .rings-svg .ring-tip').count()).toBe(2);
    await page.locator('.answer-rings').scrollIntoViewIfNeeded();
    const ar = await box(page, '.answer-rings');
    await shot(page, 'answer-small-rings.png', { x: ar.x - 24, y: ar.y - 24, width: ar.width + 48, height: ar.height + 48 });
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('#memoryLow:not([hidden])');
    const r = await rings(page);
    expect(r.low).toBe(true);
    expect(r.memory).toBeGreaterThan(0);
    expect(r.memory).toBeLessThan(0.2 * 760);
    expect(r.inner).toBe('rgb(194, 96, 10)');
    expect(r.memoryTip.shown).toBe(true);
    expect(Math.abs(r.memoryTip.turn - (r.memory / 760) * 360)).toBeLessThan(1.5);
    await shot(page, 'home-3-memory-low.png');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('the note card: its coin carries a drawn dollar sign; a close-up of the coin', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-note');
    await page.click('#tab-note');
    await expect.poll(() => page.getAttribute('#tab-note', 'aria-selected')).toBe('true');
    await shot(page, 'note-card.png');
    // The fanned stack on Funds shows the note's picture too, with the same coin.
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('.stack-card[data-way="note"] circle[r="26"]');
    await shot(page, 'funds-stack.png');
    await ctx.close();
    // The coin, close up (6x).
    const big = await phone(6);
    await big.page.emulateMedia({ reducedMotion: 'reduce' });
    await big.page.goto(`${g.url}/v2/#/funds/add`);
    await big.page.waitForSelector('#tab-note');
    await big.page.click('#tab-note');
    await expect.poll(() => big.page.getAttribute('#tab-note', 'aria-selected')).toBe('true');
    const coin = big.page.locator('#way-note circle[r="26"]');
    expect(await coin.count()).toBe(1);
    const c = (await coin.boundingBox())!;
    await shot(big.page, 'note-coin-zoom.png', { x: c.x - 10, y: c.y - 10, width: c.width + 20, height: c.height + 20 });
    expect([...errors, ...big.errors]).toEqual([]);
    await big.ctx.close();
  }, 90_000);
});
