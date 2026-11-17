import { describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { MOCK_TRANSCRIPT } from '../../src/suppliers/mock.ts';
import { g, heard, hold, meterSeen, phone, played, strictAudio, voiceSuite, watchMeter } from './phonon-setup.ts';

// The natural voice in the app (Phonon 31m on the phone, test/ui/phonon-setup.ts): the question before the
// download, reading answers aloud, offline, the phone's own voice first, where the model runs, sound only
// inside a tap, the download bar and a slow phone. The voice lab's tests are in phonon-lab.ui.test.ts.
voiceSuite();

/** The settings stored on the phone (IndexedDB forge2, kv "settings"). */
const storedSettings = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<any>((resolve) => {
        const open = indexedDB.open('forge2');
        open.onsuccess = () => {
          const db = open.result;
          if (![...db.objectStoreNames].includes('kv')) return resolve(null);
          const r = db.transaction('kv').objectStore('kv').get('settings');
          r.onsuccess = () => resolve(r.result ?? null);
        };
      }),
  );

describe('the natural voice', () => {
  it('runs on a cross-origin isolated page, and is the voice answers are read with by default', async () => {
    const { ctx, page, errors } = await phone();
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    await page.waitForSelector('#voiceOut-phonon');
    expect(await page.getAttribute('#voiceOut-phonon', 'aria-checked')).toBe('true');
    expect(await page.textContent('#voiceOut-phonon')).toBe('Natural voiceFreeOn phone');
    expect(await page.getAttribute('#voiceOut-phonon', 'aria-description')).toBe('Free. Made on this phone, so the answer is not sent anywhere. Downloads once, the first time.');
    // The other ways are still there.
    expect(await page.isVisible('#voiceOut-engine')).toBe(true);
    expect(await page.isVisible('#voiceOut-off')).toBe(true);
    expect(await page.isVisible('#voiceOut-auto')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('offers Maeve (the default) and Freya, and reads with the one picked', async () => {
    const { ctx, page, errors, requests } = await phone();
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#naturalVoices:not([hidden])');
    const speakers = await page.$$eval('#naturalVoices [role=radio]', (xs) => xs.map((x) => [x.querySelector('b')?.textContent, x.getAttribute('aria-checked')]));
    expect(speakers).toEqual([
      ['Maeve', 'true'],
      ['Freya', 'false'],
    ]);
    expect(await page.textContent('[data-screen=voice]')).not.toMatch(/Pippa|Elodie|Imogen|Lottie|Bryony|Regina/);
    await page.click('#naturalVoice-Freya');
    expect(await page.getAttribute('#naturalVoice-Freya', 'aria-checked')).toBe('true');
    expect(await page.getAttribute('#naturalVoice-Maeve', 'aria-checked')).toBe('false');
    // Kept: still Freya after a reload (the settings are written to IndexedDB without waiting: give the
    // write a moment before the page goes).
    await page.waitForTimeout(500);
    await page.reload();
    await page.waitForSelector('#naturalVoices:not([hidden])');
    await expect.poll(() => page.getAttribute('#naturalVoice-Freya', 'aria-checked')).toBe('true');
    // With the engine's voice chosen, there is no speaker to pick.
    await page.click('#voiceOut-engine');
    expect(await page.isHidden('#naturalVoices')).toBe(true);
    await page.click('#voiceOut-phonon');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('#voiceDownload', { timeout: 20_000 });
    await page.click('#voiceDlYes');
    await expect.poll(() => played(page), { timeout: 60_000 }).toBeGreaterThan(5);
    expect(requests.some((u) => u.endsWith('/voices-0ee1720/GgfEkEJtxZR7gnpy.safetensors'))).toBe(true); // Freya
    expect(requests.some((u) => u.endsWith('/voices-0ee1720/6PWnV0Nq4wu7RVBT.safetensors'))).toBe(false); // Maeve
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

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

  // Listen speaks at once (owner, 2026-11-15): on a phone with a voice of its own, the answer is read by it
  // straight away, nothing is asked first, and the natural voice is offered after it, with its size.
  it("reads with the phone's own voice at once, then offers the natural voice; Not now is kept, Get downloads it", async () => {
    const { ctx, page, errors } = await phone({ phoneVoice: true });
    await page.click('#btn-type');
    await page.fill('#question', 'Read this to me');
    await page.click('#sendBtn');
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    await page.click('#speakBtn');
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length), { timeout: 5000 }).toBeGreaterThan(0);
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    expect(await played(page)).toBe(0); // not the natural voice: nothing downloaded or made
    await page.waitForSelector('#voiceOffer:not([hidden])');
    expect(await page.textContent('#voiceOffer')).toMatch(/^Better voice6\d MB, onceGet$/);
    expect(await page.locator('#voiceOffer svg').count()).toBeGreaterThanOrEqual(3);
    // Get: the natural voice downloads now (its progress shows), then reads the answer.
    const spokenBefore = await page.evaluate(() => (window as any).__spoken.length);
    await page.click('#voiceOfferGet');
    await page.waitForSelector('#voiceProgress', { timeout: 20_000 });
    expect(await page.isVisible('#voiceOffer')).toBe(false);
    // Once downloaded, the natural voice reads the answer, unless this machine makes it slower than the
    // fallback allows (core/voicepace.js): then this phone has a voice of its own, which reads it and says
    // why. The CI runner is that slow and this Mac is not, so either way is right; which one is logged.
    const slow = () => page.getByText('The natural voice is slow on this phone').count();
    await expect.poll(async () => (await played(page)) > 5 || (await slow()) > 0, { timeout: 60_000 }).toBe(true);
    if ((await played(page)) > 5) console.log('natural voice read the answer');
    else {
      console.log('the natural voice was too slow here: the phone voice read the answer');
      await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBeGreaterThan(spokenBefore);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);

  // No sound before the natural voice was downloaded (owner, 2026-11-17). The phone's voices are listed a
  // moment after the page first asks for them: a spoken answer that asked in that moment found no voice
  // and asked about the download instead of reading. The app waits for the list.
  it("reads a spoken answer with the phone's own voice when its voices are listed late", async () => {
    const { ctx, page, errors } = await phone({ phoneVoice: { late: true } });
    await page.evaluate(() => (window as any).__voicesLate());
    await hold(page, '#talkBtn', 900);
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    expect(await played(page)).toBe(0);
    await page.waitForSelector('#voiceOffer:not([hidden])');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  // iPhone Safari drops an utterance started outside a tap, silently, until the page spoke inside one. The
  // answer to a spoken question is read seconds after the finger lifts: letting go unlocks the voice.
  it("reads a spoken answer with the phone's own voice where only a tap lets a page speak (iPhone Safari)", async () => {
    const { ctx, page, errors } = await phone({ phoneVoice: { tapOnly: true } });
    await hold(page, '#talkBtn', 900);
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length), { timeout: 20_000 }).toBeGreaterThan(0);
    expect(await page.evaluate(() => (window as any).__dropped)).toBe(0);
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('Not now on the offer is kept: the next Listen reads at once with no offer', async () => {
    const { ctx, page, errors } = await phone({ phoneVoice: true });
    await page.click('#btn-type');
    await page.fill('#question', 'And this one');
    await page.click('#sendBtn');
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    await page.click('#speakBtn');
    await page.waitForSelector('#voiceOffer:not([hidden])');
    await page.click('#voiceOfferNo');
    expect(await page.isVisible('#voiceOffer')).toBe(false);
    await page.waitForSelector('#speakBtn', { timeout: 10_000 });
    const before = await page.evaluate(() => (window as any).__spoken.length);
    await page.click('#speakBtn');
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBeGreaterThan(before);
    // The offer would be set before the reading starts: once the reading is over, it would be drawn.
    await page.waitForSelector('#speakBtn', { timeout: 10_000 });
    expect(await page.isVisible('#voiceOffer')).toBe(false);
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    // Kept on the phone: once Not now is stored, after a reload, still no offer.
    await expect.poll(() => storedSettings(page).then((x) => x?.naturalNotNow)).toBe(true);
    await page.reload();
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    await page.click('#speakBtn');
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length)).toBeGreaterThan(0);
    await page.waitForSelector('#speakBtn', { timeout: 10_000 });
    expect(await page.isVisible('#voiceOffer')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

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
});

/**
 * An iPhone's WebGPU as the page sees it: an Apple adapter (the worker inside, where the model runs,
 * keeps Chrome's own). Records the device each model load asks phonon-tts for (its worker's init).
 */
async function appleGpu(ctx: BrowserContext) {
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__inits = [];
    const adapter = { info: { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false }, features: new Set(), limits: {}, requestDevice: async () => Promise.reject(new Error('fake adapter')) };
    Object.defineProperty(Navigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: async () => adapter, getPreferredCanvasFormat: () => 'bgra8unorm' }) });
    const post = Worker.prototype.postMessage;
    Worker.prototype.postMessage = function (m: any, ...rest: any[]) {
      if (m?.type === 'init') w.__inits.push({ device: m.options.device, threads: m.options.threads });
      return (post as any).call(this, m, ...rest);
    };
  });
  // The package's WebGPU engine fails to start, whatever GPU this machine has.
  await ctx.route('**/v2/vendor/phonon-tts/gpu/engine.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: "export class GpuEngine { static async create() { throw new Error('fake: WebGPU rejected the engine'); } }" }),
  );
}
const inits = (page: Page) => page.evaluate(() => (window as any).__inits as { device: string; threads: string | number }[]);

describe('where the natural voice runs', () => {
  it("tries WebGPU on Apple's chip; when it fails, reads on the processor and remembers it for the next start", async () => {
    // No service worker, so the routed engine is what the worker loads.
    const { ctx, page, errors } = await phone({ context: { serviceWorkers: 'block' }, before: appleGpu });
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await expect.poll(() => page.textContent('#labEnv')).toContain('The app reads with: the graphics chip');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('#voiceDownload', { timeout: 20_000 });
    await page.click('#voiceDlYes');
    // Read aloud all the same, on the processor phonon-tts fell back to.
    await expect.poll(() => played(page), { timeout: 60_000 }).toBeGreaterThan(5);
    expect(await inits(page)).toEqual([{ device: 'auto', threads: 'auto' }]);
    await page.waitForSelector('#speakBtn', { timeout: 60_000 });

    // The next start goes straight to the processor, with threads.
    await page.reload();
    await page.waitForSelector('[data-screen]');
    await page.goto(`${g.url}/v2/#/answer`);
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    const before = await played(page);
    await page.click('#speakBtn');
    await expect.poll(() => played(page), { timeout: 60_000 }).toBeGreaterThan(before);
    expect(await inits(page)).toEqual([{ device: 'cpu', threads: 'auto' }]);
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await expect.poll(() => page.textContent('#labEnv')).toContain('The app reads with: the processor, several threads');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);
});

describe('sound that may only start inside a tap, as on iPhone Safari', () => {
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

describe('the natural voice download, shown as it goes', () => {
  it('after Download, the app shows the download with a bar; a failure offers Try again, which reads the answer', async () => {
    const { ctx, page, errors } = await phone();
    await strictAudio(ctx);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await ctx.route('**/model.q8.gguf', (r) => r.abort('internetdisconnected'));
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('#voiceDownload', { timeout: 20_000 });
    await page.click('#voiceDlYes');
    await page.waitForSelector('#voiceProgress');
    expect(await page.getAttribute('#voiceMeter [role=progressbar]', 'aria-label')).toBe('Natural voice download');
    await page.waitForSelector('#voiceDlRetry:not([hidden])', { timeout: 60_000 });
    expect(await page.textContent('#voiceDlError')).toMatch(/^The download stopped\./);
    expect(await heard(page)).toBe(0);
    await ctx.unroute('**/model.q8.gguf');

    await watchMeter(page, 'voiceMeter');
    await page.click('#voiceDlRetry');
    // No second question: the download shows at once, and the answer is read when it is in.
    expect(await page.isVisible('#voiceDownload')).toBe(false);
    await page.waitForSelector('#voiceProgress');
    await expect.poll(() => heard(page), { timeout: 60_000 }).toBeGreaterThan(5);
    // The window closes once the voice starts reading.
    await page.waitForSelector('#voiceProgress', { state: 'detached', timeout: 10_000 });
    const m = await meterSeen(page);
    expect(m.values.some((v) => v > 0 && v < 100)).toBe(true);
    expect(Math.max(...m.values)).toBe(100);
    expect(m.phases).toEqual(expect.arrayContaining(['Downloading', 'Getting ready']));
    expect(m.amounts.at(-1)).toMatch(/^6\d\.\d of 6\d\.\d MB, 100%$/);
    expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([]);
    await ctx.close();
  }, 200_000);
});

/**
 * A slow phone: phonon-tts replaced by an engine that makes the voice at 1.3 times real time (each
 * 80 ms piece of sound takes 104 ms), about 0.065 s of sound per character, as Maeve speaks.
 */
async function slowEngine(ctx: BrowserContext, rtf = 1.3) {
  const body = `
    export class PhononTTS {
      static async load(opts) {
        opts.onProgress?.({ file: 'weights', loaded: 1, total: 1, cached: true });
        return new PhononTTS();
      }
      constructor() { this.sampleRate = 24000; this.device = 'cpu'; this.threads = 1; }
      stream(text, { signal } = {}) {
        const rtf = ${rtf};
        return (async function* () {
          const n = Math.max(1, Math.round((text.length * 0.065) / 0.08));
          const t0 = performance.now();
          for (let i = 0; i < n; i++) {
            const due = t0 + (i + 1) * 80 * rtf;
            await new Promise((r) => setTimeout(r, Math.max(0, due - performance.now())));
            if (signal?.aborted) return;
            const pcm = new Float32Array(1920);
            for (let k = 0; k < pcm.length; k++) pcm[k] = 0.2 * Math.sin(((i * 1920 + k) / 24000) * 2 * Math.PI * 220);
            yield pcm;
          }
        })();
      }
      dispose() {}
    }`;
  await ctx.route('**/v2/vendor/phonon-tts/index.js', (r) => r.fulfill({ contentType: 'text/javascript', body }));
  // Every piece queued on Web Audio: when it starts and how long it lasts, to find the gaps.
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__queued = [];
    const start = AudioBufferSourceNode.prototype.start;
    AudioBufferSourceNode.prototype.start = function (when?: number, ...rest: any[]) {
      if ((this.buffer?.length ?? 0) > 1) w.__queued.push([when ?? this.context.currentTime, this.buffer!.duration]);
      return start.call(this, when as any, ...rest);
    };
  });
}

/** Gaps a listener hears: a piece queued to start after the one before has ended. */
const gapsHeard = (page: Page) =>
  page.evaluate(() => {
    const q = (window as any).__queued as [number, number][];
    let gaps = 0;
    for (let i = 1; i < q.length; i++) if (q[i]![0] > q[i - 1]![0] + q[i - 1]![1] + 0.005) gaps++;
    return { pieces: q.length, gaps };
  });

describe('the natural voice on a slow phone', () => {
  it('at 1.3 times real time it says "Getting the voice ready" with a bar, then reads the answer with no gaps', async () => {
    const { ctx, page, errors } = await phone({ context: { serviceWorkers: 'block' }, before: (c) => slowEngine(c) });
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('[data-screen=answer]');
    await page.waitForSelector('#voiceDownload', { timeout: 20_000 });
    await page.click('#voiceDlYes');
    // It waits for sound in hand: the words and the bar, and nothing played yet.
    await page.waitForSelector('#speakReady:not([hidden])', { timeout: 20_000 });
    expect(await page.textContent('#speakState')).toBe('Getting the voice ready');
    expect(await played(page)).toBe(0);
    await expect.poll(async () => Number(await page.getAttribute('#speakReady', 'aria-valuenow')), { timeout: 10_000 }).toBeGreaterThan(30);
    // Then it reads, all the way through, with no gap.
    await expect.poll(() => page.textContent('#speakState'), { timeout: 20_000 }).toBe('Speaking');
    await page.waitForSelector('#speakBtn', { timeout: 30_000 });
    const heard = await gapsHeard(page);
    expect(heard.pieces).toBeGreaterThan(30);
    expect(heard.gaps).toBe(0);
    // How fast this phone makes the voice is kept, so the next answer starts by it.
    const pace = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('forge2');
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      return new Promise<any>((res) => {
        const g = db.transaction('kv', 'readonly').objectStore('kv').get('settings');
        g.onsuccess = () => res(g.result?.voicePace ?? null);
        g.onerror = () => res(null);
      });
    });
    expect(Object.values(pace as Record<string, any>)[0].rtf).toBeGreaterThan(1.2);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
