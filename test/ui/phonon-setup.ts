import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { fakePhoneVoice } from './phonevoice.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { micArgs } from './mic.ts';

// What the natural voice's two UI test files share: phonon.ui.test.ts (the app reading answers aloud)
// and phonon-lab.ui.test.ts (the voice lab). They are two files so CI can run them in parallel parts
// (docs/CI.md); each starts its own gateway and Chrome with voiceSuite().
//
// The natural voice made on the phone (Phonon 31m through the vendored phonon-tts), in a phone-sized
// Chrome against a local gateway that serves the model from its own origin. The page is cross-origin
// isolated, so the model runs on several threads. The speaker is the app's real one (Web Audio); the
// test counts the pieces of sound it is handed.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const INDEX = join(import.meta.dirname, '../../public/v2/voice/phonon/index.json');

export let g: Gateway;
export let browser: Browser;

/** The gateway and Chrome for one test file, started before its tests and closed after them. */
export function voiceSuite() {
  beforeAll(async () => {
    if (!existsSync(INDEX)) throw new Error('The natural voice files are not in place. Run node scripts/phonon-model.ts.');
    if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
    g = await startGateway({ audio: true, env: { FORGE_INVITE_ONLY: 'true' } });
    browser = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args: micArgs(),
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await g?.close();
  });
}

export interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  requests: string[];
}

async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 300);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

/**
 * A phone with a funded balance and the microphone allowed; Private only off, the mock-echo model.
 * context: more context options; before: runs on the context before its first page opens.
 */
export async function phone({ context = {}, before, phoneVoice = false }: { context?: object; before?: (ctx: BrowserContext) => Promise<void>; phoneVoice?: boolean | { late?: boolean; tapOnly?: boolean } } = {}): Promise<Phone> {
  const ctx = await browser.newContext({ ...PHONE, ...context });
  // Whether the phone has a voice of its own (it reads at once while the natural voice is not here yet):
  // none by default, so the one-time question before the download is what these tests see.
  await fakePhoneVoice(ctx, !!phoneVoice, typeof phoneVoice === 'object' ? phoneVoice : {});
  await before?.(ctx);
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone'], { origin: g.url });
  // Counts the pieces of sound handed to Web Audio, the way the app's speaker plays them.
  await ctx.addInitScript(() => {
    (window as any).__played = 0;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a: any[]) {
      // Not the one-sample silence a tap plays to unlock the sound (adapters.js speaker.unlock).
      if ((this.buffer?.length ?? 0) > 1) (window as any).__played++;
      return start.apply(this, a as any);
    };
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 50\d/.test(m.text()) && errors.push(m.text()));
  const requests: string[] = [];
  ctx.on('request', (r) => requests.push(r.url()));
  const key = await fundedKey();
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  await page.click('#privateOnly');
  await page.click('[data-model="mock-echo"]');
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
  await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toBe('$3.00');
  return { ctx, page, errors, requests };
}

export async function hold(page: Page, sel: string, ms: number) {
  const box = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // The hold counts from the moment the app is recording: on a slow machine the microphone can take
  // longer to open than the hold itself, and a release before then is a cancel.
  await page.waitForSelector(`${sel}[data-phase=recording]`, { timeout: 15_000 });
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

export const played = (page: Page) => page.evaluate(() => (window as any).__played as number);

/**
 * Web Audio as iPhone Safari allows it: a context made, or resumed, outside a tap stays suspended, and
 * sound queued on it is never heard. Chrome lets a page start sound for seconds after any tap, so this
 * holds it to the stricter rule: only inside the handling of the tap itself (a pointerup, click, key or
 * touchend, and the microtasks it queues). Counts the pieces queued on a running context (heard).
 */
export async function strictAudio(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    const w = window as any;
    const Real = window.AudioContext;
    let inTap = false;
    for (const type of ['pointerup', 'click', 'keydown', 'keyup', 'touchend', 'mouseup']) {
      addEventListener(
        type,
        (e) => {
          if (!e.isTrusted) return;
          inTap = true;
          setTimeout(() => (inTap = false), 0);
        },
        true,
      );
    }
    // While the microphone is on, Safari lets a page's sound start (the recorder's own context).
    let capturing = 0;
    const gum = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (c) => {
      const s = await gum(c);
      for (const tr of s.getTracks()) {
        capturing++;
        const stop = tr.stop.bind(tr);
        tr.stop = () => {
          if (tr.readyState === 'live') capturing--;
          stop();
        };
      }
      return s;
    };
    w.__audio = { made: [] as boolean[], resumed: [] as boolean[], heard: 0 };
    class Strict extends Real {
      __ok: boolean;
      constructor(...a: any[]) {
        super(...(a as []));
        this.__ok = inTap || capturing > 0;
        w.__audio.made.push(this.__ok);
        if (!this.__ok) Real.prototype.suspend.call(this);
      }
      override get state() {
        return this.__ok ? super.state : 'suspended';
      }
      override resume() {
        w.__audio.resumed.push(inTap);
        if (inTap) this.__ok = true;
        return this.__ok ? super.resume() : new Promise<void>(() => {});
      }
    }
    w.AudioContext = Strict;
    w.webkitAudioContext = Strict;
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (...a: any[]) {
      if (this.context.state === 'running' && (this.buffer?.length ?? 0) > 1) w.__audio.heard++;
      return start.apply(this, a as any);
    };
  });
}

export const heard = (page: Page) => page.evaluate(() => (window as any).__audio.heard as number);

/** Records every value the bar with this id shows, and every phase line under it, from now on. */
export async function watchMeter(page: Page, id: string) {
  await page.evaluate((id) => {
    const w = window as any;
    w.__meter = { values: [] as number[], phases: [] as string[], amounts: [] as string[] };
    new MutationObserver(() => {
      const m = document.getElementById(id);
      if (!m) return;
      const v = Number(m.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow'));
      if (w.__meter.values.at(-1) !== v) w.__meter.values.push(v);
      const ph = m.querySelector('.meter-phase')?.textContent ?? '';
      if (ph && w.__meter.phases.at(-1) !== ph) w.__meter.phases.push(ph);
      const am = m.querySelector('.meter-amount')?.textContent ?? '';
      if (am && w.__meter.amounts.at(-1) !== am) w.__meter.amounts.push(am);
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
  }, id);
}
export const meterSeen = (page: Page) => page.evaluate(() => (window as any).__meter as { values: number[]; phases: string[]; amounts: string[] });
