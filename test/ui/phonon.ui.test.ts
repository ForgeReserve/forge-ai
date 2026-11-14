import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { MOCK_TRANSCRIPT } from '../../src/suppliers/mock.ts';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The natural voice made on the phone (Phonon 31m through the vendored phonon-tts), in a phone-sized
// Chrome against a local gateway that serves the model from its own origin. The page is cross-origin
// isolated, so the model runs on several threads. The speaker is the app's real one (Web Audio); the
// test counts the pieces of sound it is handed.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const INDEX = join(import.meta.dirname, '../../public/v2/voice/phonon/index.json');

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!existsSync(INDEX)) throw new Error('The natural voice files are not in place. Run node scripts/phonon-model.ts.');
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ audio: true, env: { FORGE_INVITE_ONLY: 'true' } });
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

interface Phone {
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

/** A phone with a funded balance and the microphone allowed; Private only off, the mock-echo model. */
async function phone(): Promise<Phone> {
  const ctx = await browser.newContext({ ...PHONE });
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

async function hold(page: Page, sel: string, ms: number) {
  const box = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}

const played = (page: Page) => page.evaluate(() => (window as any).__played as number);

/**
 * Web Audio as iPhone Safari allows it: a context made, or resumed, outside a tap stays suspended, and
 * sound queued on it is never heard. Chrome lets a page start sound for seconds after any tap, so this
 * holds it to the stricter rule: only inside the handling of the tap itself (a pointerup, click, key or
 * touchend, and the microtasks it queues). Counts the pieces queued on a running context (heard).
 */
async function strictAudio(ctx: BrowserContext) {
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

const heard = (page: Page) => page.evaluate(() => (window as any).__audio.heard as number);

describe('the natural voice', () => {
  it('runs on a cross-origin isolated page, and is the voice answers are read with by default', async () => {
    const { ctx, page, errors } = await phone();
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    await page.waitForSelector('#voiceOut-phonon');
    expect(await page.getAttribute('#voiceOut-phonon', 'aria-checked')).toBe('true');
    expect(await page.textContent('#voiceOut-phonon')).toBe('Natural voiceFree. Made on this phone, so the answer is not sent anywhere. Downloads once, the first time.');
    // The other ways are still there.
    expect(await page.isVisible('#voiceOut-engine')).toBe(true);
    expect(await page.isVisible('#voiceOut-off')).toBe(true);
    expect(await page.isVisible('#voiceOut-auto')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('reads a PDF on the isolated page with pdf.js in its own worker, as before', async () => {
    const { ctx, page, errors } = await phone();
    const warnings: string[] = [];
    page.on('console', (m) => warnings.push(m.text()));
    // A one-page PDF with one line of text (pdf.js rebuilds the cross-reference table it lacks).
    const pdf = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 40 Td (Isolated PDF) Tj ET\nendstream endobj\n5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';
    // A string, so the test runner leaves the page's own import() alone.
    await page.evaluate(`import('/js/extract.js').then((m) => (window.__extract = m.extract))`);
    const text = await page.evaluate(async (body) => (await (window as any).__extract(new File([body], 'note.pdf', { type: 'application/pdf' }))).text, pdf);
    expect(text).toContain('Isolated PDF');
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((e) => e.name.endsWith('/vendor/pdfjs/pdf.worker.min.mjs')))).toBe(true);
    expect(warnings.filter((w) => /fake worker/i.test(w))).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('asks once with the size, reads the answer on the phone with nothing sent out, and then works offline', async () => {
    const { ctx, page, errors, requests } = await phone();
    // The service worker controls the page before the voice is first used, as it does on a phone that
    // opened the app before.
    await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15_000 });
    // Once more online with the worker in charge, so it keeps the app's files too (as firstrun.ui.test.ts).
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    // The answer arrives; before anything is downloaded, the phone asks, with the size.
    await page.waitForSelector('#voiceDownload', { timeout: 20_000 });
    expect(await page.textContent('#voiceDownload')).toMatch(/It downloads once: 6\d MB\./);
    expect(await played(page)).toBe(0);
    await page.click('#voiceDlYes');
    await expect.poll(() => played(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForSelector('#speakBtn', { timeout: 60_000 });
    // Nothing went to the engine's voice, and nothing to another site.
    expect(requests.some((u) => u.endsWith('/v1/audio/speech'))).toBe(false);
    expect(requests.filter((u) => !u.startsWith(g.url) && !u.startsWith('blob:') && !u.startsWith('data:'))).toEqual([]);
    // It ran on several threads, and the model is kept in the voice package's own cache.
    expect(await page.evaluate(async () => !!(await (await caches.open('phonon-tts-v1')).match(new URL('/v2/voice/phonon/31m-en-92741c5/model.q8.gguf', location.href).href)))).toBe(true);

    // Listen again: no question this time.
    const before = await played(page);
    await page.click('#speakBtn');
    await expect.poll(() => played(page), { timeout: 30_000 }).toBeGreaterThan(before);
    expect(await page.isVisible('#voiceDownload')).toBe(false);

    // Offline, after a reload: the app, the voice package and the model all come from the phone.
    await page.waitForSelector('#speakBtn', { timeout: 60_000 });
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('[data-screen]');
    await page.goto(`${g.url}/v2/#/answer`);
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    const offlineBefore = await played(page);
    await page.click('#speakBtn');
    await expect.poll(() => played(page), { timeout: 60_000 }).toBeGreaterThan(offlineBefore);
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    await ctx.setOffline(false);
    expect(errors.filter((e) => !/Failed to fetch|ERR_INTERNET_DISCONNECTED|net::/.test(e))).toEqual([]);
    await ctx.close();
  }, 180_000);

  it('Not now reads nothing and is not asked again for the next spoken answer', async () => {
    const { ctx, page, errors } = await phone();
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('#voiceDownload', { timeout: 20_000 });
    await page.click('#voiceDlNo');
    await page.waitForTimeout(500);
    expect(await played(page)).toBe(0);
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    // A second question by voice: answered, not read, not asked.
    await page.waitForSelector('#replyBtn');
    await hold(page, '#replyBtn', 900);
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    await page.waitForTimeout(800);
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    expect(await played(page)).toBe(0);
    // Listen asks again.
    await page.click('#speakBtn');
    await page.waitForSelector('#voiceDownload');
    await page.click('#voiceDlNo');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('the voice lab measures the voices this phone runs and saves the results as JSON', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    expect(await page.inputValue('#labVoice')).toBeTruthy();
    // A short run: the threaded processor only, without playing the sound.
    for (const id of ['phonon-cpu-single', 'phonon-webgpu', 'phone-voice']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '3');
    await page.click('#labRun');
    await page.waitForSelector('#labSave:not([hidden])', { timeout: 120_000 });
    expect(await page.textContent('#labStatus')).toMatch(/^Done\./);
    const dl = page.waitForEvent('download');
    await page.click('#labSave');
    const file = await (await dl).path();
    const json = JSON.parse(readFileSync(file, 'utf8'));
    expect(json.kind).toBe('forge-voice-lab');
    expect(json.env.crossOriginIsolated).toBe(true);
    const c = json.candidates[0];
    expect(c.id).toBe('phonon-cpu-threads');
    expect(c.got.threads).toBeGreaterThan(1);
    expect(c.rows).toHaveLength(3); // the quick run; the corpus itself has 60 lines (core/voicelab.js)
    expect(c.summary.failed + c.summary.nanRuns + c.summary.silentRuns).toBe(0);
    expect(c.summary.rtf.median).toBeLessThan(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);
});

describe('sound that may only start inside a tap, as on iPhone Safari', () => {
  it('the voice lab plays what it measures: the sound is unlocked inside the Run tap', async () => {
    const { ctx, page, errors } = await phone();
    await strictAudio(ctx);
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await page.reload();
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    for (const id of ['phonon-cpu-single', 'phonon-webgpu', 'phone-voice']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '3');
    await page.check('#labPlay');
    await page.click('#labRun');
    await page.waitForSelector('#labSave:not([hidden])', { timeout: 90_000 });
    expect(await page.textContent('#labStatus')).toMatch(/^Done\./);
    // The one sound context was made or resumed inside the tap, and every line was heard.
    const audio = await page.evaluate(() => (window as any).__audio);
    expect(audio.made.length + audio.resumed.length).toBeGreaterThan(0);
    expect([...audio.made, ...audio.resumed][0]).toBe(true);
    expect(audio.heard).toBeGreaterThan(10);
    expect(await page.textContent('#labResults')).not.toMatch(/blocked/i);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 150_000);

  it('an answer to a spoken question is read aloud after Download, and Listen reads it again', async () => {
    const { ctx, page, errors } = await phone();
    await strictAudio(ctx);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('#voiceDownload', { timeout: 20_000 });
    await page.click('#voiceDlYes');
    await expect.poll(() => heard(page), { timeout: 60_000 }).toBeGreaterThan(5);
    await page.waitForSelector('#speakBtn', { timeout: 60_000 });
    const before = await heard(page);
    await page.click('#speakBtn');
    await expect.poll(() => heard(page), { timeout: 30_000 }).toBeGreaterThan(before);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 150_000);
});
