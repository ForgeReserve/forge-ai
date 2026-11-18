import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The talk button never moves under the finger (owner, 2026-11-18, on a Galaxy A16 and an iPhone 13 Pro
// Max): from the press to the release its box stays where it was, on the home and on the answer, in
// Default and in Playful, at the phone's usual text size and its largest. What shows while it records (the
// time, where the sound goes, the price and the words as the phone hears them) must not push it. The phone
// here is the Android app's bridge played by a stand-in (as in voice.ui.test.ts), so the live words show
// as they do on the phones; a look changes colours only, so one look is enough.

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ audio: true, env: { FORGE_INVITE_ONLY: 'true' } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

/** The words the stand-in's recogniser hears while the button is held: long enough to take a few lines. */
const HEARD = 'What should I bring to the beach on Saturday if it rains in the morning and the children come with us';

/** A phone of this size, its text at `pct` % (as a phone set to larger text), with a funded balance on mock-echo. */
async function phone(viewport: { width: number; height: number }, pct: number) {
  const ctx = await browser.newContext({ viewport, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pastFirstRun(ctx);
  await ctx.addInitScript(
    ([heard, scale]) => {
      // Larger text: the phone scales the words, not the boxes (as game.ui.test.ts measures it).
      if (scale !== 100)
        document.addEventListener('DOMContentLoaded', () => {
          const s = document.createElement('style');
          s.textContent = `html { -webkit-text-size-adjust: ${scale}%; text-size-adjust: ${scale}%; }`;
          document.head.append(s);
        });
      const listeners: Array<{ event: string; fn: (ev: any) => void }> = [];
      const emit = (id: string, ev: any) => listeners.filter((l) => l.event === 'speech').forEach((l) => l.fn({ id, ...ev }));
      (window as any).Capacitor = {
        isNativePlatform: () => true,
        nativePromise: async (plugin: string, method: string, opts: any) => {
          if (plugin !== 'ForgeSpeech') return plugin === 'ForgeAsr' && method === 'available' ? { available: false, reason: 'none', language: 'en' } : undefined;
          if (method === 'available') return { onDevice: true, reason: null, locale: 'en-US' };
          if (method === 'start') {
            setTimeout(() => emit(opts.id, { type: 'started' }), 30);
            setTimeout(() => emit(opts.id, { type: 'level', level: 0.5 }), 60);
            setTimeout(() => emit(opts.id, { type: 'partial', text: heard }), 90);
          }
          if (method === 'cancel' || method === 'stop') setTimeout(() => emit(opts.id, { type: 'end' }), 30);
          return {};
        },
        addListener: (_plugin: string, event: string, fn: (ev: any) => void) => {
          listeners.push({ event, fn });
          return { remove: async () => {} };
        },
      };
    },
    [HEARD, pct] as [string, number],
  );
  // Nothing leaves this computer.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort('blockedbyclient'));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // The local engine, set in More as a person would; then a balance on it and the echo model.
  await page.goto(`${g.url}/v2/#/more/engine`);
  await page.waitForSelector('[data-screen=engine]');
  await page.fill('#engineAddress', `${g.url}/`);
  await Promise.all([page.waitForEvent('load'), page.click('#engineUse')]);
  await page.waitForSelector('[data-screen=home]');
  const token = await mintToken(MINT_A, 'usd', 300);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), b.key);
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  await page.click('#privateOnly');
  await page.click('[data-model="mock-echo"]');
  await page.goto(`${g.url}/v2/#/more/voice`);
  await page.waitForSelector('#voiceOut-off');
  await page.click('#voiceOut-off');
  return { ctx, page, errors };
}

/**
 * The button's centre in the window, once it has held still for 10 frames running (a row brought into
 * view glides there first).
 */
const settled = (page: Page, sel: string) =>
  page.evaluate(
    (s) =>
      new Promise<{ x: number; y: number }>((done) => {
        let last = '';
        let same = 0;
        const tick = () => {
          const b = document.querySelector(s)!.getBoundingClientRect();
          const c = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
          const k = `${c.x.toFixed(2)},${c.y.toFixed(2)}`;
          same = k === last ? same + 1 : 0;
          last = k;
          if (same >= 10) done(c);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    sel,
  );

/** The button's centre in each of the next `n` frames. */
const frames = (page: Page, sel: string, n = 20) =>
  page.evaluate(
    ([s, count]) =>
      new Promise<Array<{ x: number; y: number }>>((done) => {
        const out: Array<{ x: number; y: number }> = [];
        const tick = () => {
          const b = document.querySelector(s as string)!.getBoundingClientRect();
          out.push({ x: b.left + b.width / 2, y: b.top + b.height / 2 });
          if (out.length >= (count as number)) done(out);
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    [sel, n] as [string, number],
  );

/** Holds the button down until it records and shows the words heard, checks it never moved, then slides off and lets go. */
async function holdStill(page: Page, sel: string, where: string) {
  // With larger text a long answer pushes the reply button below the dock: scrolled to the end, as a
  // person would, it is in view above it.
  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  const before = await settled(page, sel);
  await page.mouse.move(before.x, before.y);
  await page.mouse.down();
  await expect.poll(() => page.getAttribute(sel, 'data-phase')).toBe('recording');
  await expect.poll(() => page.locator('.listen-text').first().textContent(), { timeout: 4000 }).toBe(HEARD);
  await expect.poll(() => page.locator('.listen-time').first().textContent()).toMatch(/^0:0\d/);
  for (const c of await frames(page, sel)) {
    expect(Math.abs(c.y - before.y), `${where}: moved up or down`).toBeLessThanOrEqual(0.5);
    expect(Math.abs(c.x - before.x), `${where}: moved sideways`).toBeLessThanOrEqual(0.5);
  }
  // Slide off and let go: nothing is asked.
  await page.mouse.move(before.x, before.y - 400, { steps: 4 });
  await page.mouse.up();
  await expect.poll(() => page.getAttribute(sel, 'data-phase')).toBe('idle');
}

/** Asks a typed question and waits for its answer to be in. */
async function askTyped(page: Page, done: string) {
  await page.click('#btn-type');
  await page.fill('#question', 'Is it going to rain?');
  await page.click('#sendBtn');
  await page.waitForSelector('[data-screen=answer]');
  await page.waitForSelector(done, { timeout: 20_000 });
}

describe('the talk button holds still while it is pressed', () => {
  it.each([
    [412, 892, 100],
    [412, 892, 200],
    [428, 926, 100],
    [428, 926, 200],
  ])('at %ix%i with text at %i percent: the home and the answer, in Default and in Playful', async (width, height, pct) => {
    const { ctx, page, errors } = await phone({ width, height }, pct);
    const tag = `${width}x${height} ${pct} %`;
    // Default: the home, then the answer once it is shown as text.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home] #talkBtn');
    await page.evaluate(() => document.fonts.ready);
    await holdStill(page, '#talkBtn', `${tag} Default home`);
    await askTyped(page, '#copyBtn');
    await holdStill(page, '#replyBtn', `${tag} Default answer`);

    // Playful, with the helper's home (not the cover game it opens on by default).
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.waitForSelector('#mode-playful');
    await page.click('#mode-playful');
    await expect.poll(() => page.textContent('#mode-playful')).toContain('On now.');
    await page.click('#gameFirst');
    await expect.poll(() => page.getAttribute('#gameFirst', 'aria-checked')).toBe('false');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home][data-mode=playful] #talkBtn');
    await page.evaluate(() => document.fonts.ready);
    await holdStill(page, '#talkBtn', `${tag} Playful home`);
    await askTyped(page, '#shareBtn');
    await holdStill(page, '#replyBtn', `${tag} Playful answer`);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
