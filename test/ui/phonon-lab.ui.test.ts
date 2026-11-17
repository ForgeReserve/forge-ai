import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BrowserContext, Page } from 'playwright-core';
import { g, heard, meterSeen, phone, strictAudio, voiceSuite, watchMeter } from './phonon-setup.ts';

// The voice lab (#/voice-lab) with the natural voice (test/ui/phonon-setup.ts): measuring the voices this
// phone runs, the phone's own voice in the lab, failures, lines whose end never comes, the accent test,
// sound inside the Run tap and the download as it goes. The app's own tests are in phonon.ui.test.ts.
voiceSuite();

describe('the voice lab', () => {
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
    await page.waitForSelector('#labRun:not([hidden])', { timeout: 120_000 });
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

/**
 * The phone's own voice as iOS Safari gives it: getVoices() empty at first, the list (local en-GB and
 * en-US voices) only after a while and a voiceschanged event; or, as on GrapheneOS, never any voice.
 * Speaking takes a few ms and ends.
 */
async function iosSpeech(ctx: BrowserContext, { voices = true, ends = true } = {}) {
  await ctx.addInitScript(({ voices, ends }: { voices: boolean; ends: boolean }) => {
    const w = window as any;
    const target = new EventTarget();
    let list: any[] = [];
    w.__spoken = [];
    if (voices) {
      setTimeout(() => {
        list = [
          { name: 'Samantha', lang: 'en-US', localService: true, default: true, voiceURI: 'samantha' },
          { name: 'Daniel', lang: 'en-GB', localService: true, default: false, voiceURI: 'daniel' },
          { name: 'Thomas', lang: 'fr-FR', localService: true, default: false, voiceURI: 'thomas' },
        ];
        target.dispatchEvent(new Event('voiceschanged'));
      }, 1500);
    }
    const synth = Object.assign(target, {
      getVoices: () => list,
      speak(u: any) {
        w.__spoken.push(u.text);
        setTimeout(() => u.onstart?.(), 5);
        // As iOS often does for a long utterance: it plays, and its end never comes.
        if (ends) setTimeout(() => u.onend?.(), 30);
      },
      cancel() {
        w.__cancels = (w.__cancels ?? 0) + 1;
      },
      speaking: false,
      pending: false,
    });
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, get: () => synth });
    w.SpeechSynthesisUtterance = class {
      text: string;
      voice: any = null;
      lang = '';
      volume = 1;
      constructor(text: string) {
        this.text = text;
      }
    };
  }, { voices, ends });
}

describe("the voice lab's phone voice", () => {
  for (const [what, voices] of [
    ['waits for a voice list that starts empty and fills later (iOS Safari), and reads with its British voice', true],
    ['says there is no voice when none ever comes (GrapheneOS)', false],
  ] as const) {
    it(what, async () => {
      const { ctx, page, errors } = await phone({ before: (c) => iosSpeech(c, { voices }) });
      await page.goto(`${g.url}/v2/#/voice-lab`);
      await page.waitForSelector('[data-screen=voiceLab]');
      await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
      for (const id of ['phonon-cpu-threads', 'phonon-cpu-single', 'phonon-webgpu']) await page.uncheck(`#lab-${id}`);
      await page.selectOption('#labLines', '3');
      await page.click('#labRun');
      await page.waitForSelector('#labRun:not([hidden])', { timeout: 30_000 });
      const dl = page.waitForEvent('download');
      await page.click('#labSave');
      const json = JSON.parse(readFileSync(await (await dl).path(), 'utf8'));
      const c = json.candidates.find((x: any) => x.id === 'phone-voice');
      if (voices) {
        expect(c.error).toBeUndefined();
        expect(c.voice).toBe('Daniel (en-GB)');
        expect(c.rows).toHaveLength(3);
        expect(c.rows.every((r: any) => r.firstMs != null && !r.error)).toBe(true);
        expect(c.listed.map((v: any) => v.name)).toEqual(['Samantha', 'Daniel', 'Thomas']);
      } else {
        expect(c.error).toBe('no voice of the phone runs on the phone');
        expect(c.rows).toEqual([]);
      }
      expect(errors).toEqual([]);
      await ctx.close();
    }, 60_000);
  }
});

/**
 * A WebGPU that loads and then reads nothing, as the voice lab saw on desktop Safari: the worker is
 * handed an adapter and a device that accept everything, and an engine whose every chunk ends with no
 * sound and no error.
 */
async function silentGpu(ctx: BrowserContext) {
  const shim = `
    const __device = { lost: new Promise(() => {}), limits: { maxStorageBufferBindingSize: 2 ** 31 }, pushErrorScope() {}, popErrorScope: async () => null, destroy() {} };
    const __adapter = { info: { vendor: 'apple', architecture: 'metal-3', isFallbackAdapter: false }, features: new Set(), limits: {}, requestDevice: async () => __device };
    Object.defineProperty(WorkerNavigator.prototype, 'gpu', { configurable: true, get: () => ({ requestAdapter: async () => __adapter }) });
  `;
  await ctx.route('**/v2/vendor/phonon-tts/worker.js', async (r) => {
    const real = await r.fetch();
    r.fulfill({ response: real, contentType: 'text/javascript', body: shim + (await real.text()) });
  });
  await ctx.route('**/v2/vendor/phonon-tts/gpu/engine.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: 'export class GpuEngine { static async create() { return { addVoice: async () => 0, speakChunk: async () => ({ frames: 0, cancelled: false }) }; } }' }),
  );
}

describe("the voice lab's results when a way of reading fails", () => {
  it('a WebGPU that loads and reads nothing shows as a failure with its reason, not as a run with no lines', async () => {
    const { ctx, page, errors } = await phone({ context: { serviceWorkers: 'block' }, before: silentGpu });
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    for (const id of ['phonon-cpu-threads', 'phonon-cpu-single', 'phone-voice']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '3');
    await page.click('#labRun');
    await page.waitForSelector('#labRun:not([hidden])', { timeout: 120_000 });
    expect(await page.textContent('[data-candidate=phonon-webgpu]')).toBe('Natural voice, graphics chipFailed: every line failed: the model ended the line with no sound and no error');
    const dl = page.waitForEvent('download');
    await page.click('#labSave');
    const json = JSON.parse(readFileSync(await (await dl).path(), 'utf8'));
    const c = json.candidates[0];
    expect(c.id).toBe('phonon-webgpu');
    expect(c.got.device).toBe('webgpu');
    expect(c.rows).toHaveLength(3);
    expect(c.rows.map((r: any) => r.code)).toEqual(['no-sound', 'no-sound', 'no-sound']);
    expect(c.error).toMatch(/^every line failed/);
    expect(c.summary.failed).toBe(3);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);
});

async function saveJson(page: Page) {
  const dl = page.waitForEvent('download');
  await page.click('#labSave');
  return JSON.parse(readFileSync(await (await dl).path(), 'utf8'));
}

describe("the voice lab's phone voice when its end never comes (iOS)", () => {
  it('cancels each line at its deadline, marks it timed out, and the run ends with Save', async () => {
    const { ctx, page, errors } = await phone({ before: (c) => iosSpeech(c, { ends: false }) });
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    for (const id of ['phonon-cpu-threads', 'phonon-cpu-single', 'phonon-webgpu']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '3');
    await page.click('#labRun');
    // The three short lines' deadlines: 2.5 times their spoken length plus 5 s each, about 23 s in all.
    await expect.poll(() => page.textContent('#labStatus'), { timeout: 45_000 }).toMatch(/^Done\./);
    expect(await page.textContent('#labSave')).toBe('Save results');
    const json = await saveJson(page);
    const c = json.candidates.find((x: any) => x.id === 'phone-voice');
    expect(c.rows).toHaveLength(3);
    expect(c.rows.map((r: any) => [r.timedOut, r.audioS, r.error])).toEqual([
      [true, null, undefined],
      [true, null, undefined],
      [true, null, undefined],
    ]);
    expect(c.rows.every((r: any) => r.firstMs != null)).toBe(true);
    expect(c.summary.timedOutRuns).toBe(3);
    expect(await page.evaluate(() => (window as any).__cancels)).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('saves the results so far while it runs, and Stop ends the run at once with the rows done kept', async () => {
    const { ctx, page, errors } = await phone({ before: (c) => iosSpeech(c, { ends: false }) });
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    for (const id of ['phonon-cpu-threads', 'phonon-cpu-single', 'phonon-webgpu']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '10');
    await page.click('#labRun');
    await expect.poll(() => page.textContent('#labStatus'), { timeout: 20_000 }).toMatch(/^1 of 10/);
    // While it runs: Save results so far.
    expect(await page.textContent('#labSave')).toBe('Save results so far');
    const sofar = await saveJson(page);
    expect(sofar.partial).toBe(true);
    expect(sofar.candidates[0].rows.length).toBeGreaterThanOrEqual(1);
    // Stop, in the middle of a line whose end never comes: the run ends at once.
    const t0 = Date.now();
    await page.click('#labStop');
    await expect.poll(() => page.textContent('#labStatus'), { timeout: 3000 }).toMatch(/^Stopped\./);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await page.isVisible('#labRun')).toBe(true);
    expect(await page.textContent('#labSave')).toBe('Save results');
    const json = await saveJson(page);
    expect(json.partial).toBeUndefined();
    const c = json.candidates[0];
    expect(c.id).toBe('phone-voice');
    expect(c.stopped).toBe(true);
    expect(c.rows.length).toBeGreaterThanOrEqual(1);
    expect(c.rows.length).toBeLessThan(10);
    expect(c.rows.every((r: any) => r.timedOut)).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});

describe('the accent test in the voice lab', () => {
  it('lists other locales\' speakers under their own group, reads English with one, and the app never offers them', async () => {
    const { ctx, page, errors, requests } = await phone();
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    const groups = await page.$$eval('#labVoice optgroup', (gs) => gs.map((x) => ({ label: (x as HTMLOptGroupElement).label, options: [...x.querySelectorAll('option')].map((o) => o.textContent) })));
    expect(groups.map((x) => x.label)).toEqual(['Voices in the app', 'Other voices, lab only', 'Accent test (English model)']);
    expect(groups[0]!.options).toEqual(['Maeve', 'Freya']);
    expect(groups[1]!.options).toEqual(['Pippa', 'Elodie-Rose', 'Imogen', 'Lottie', 'Bryony']);
    expect(groups[2]!.options).toEqual(['Regina, Mexican Spanish speaker', 'Ximena, Mexican Spanish speaker', 'Alba, Spanish from Spain speaker', 'Isadora, Brazilian Portuguese speaker', 'Maëlys, French speaker']);
    expect(await page.isVisible('#labVoiceNote')).toBe(false);
    await page.selectOption('#labVoice', 'Regina');
    expect(await page.textContent('#labVoiceNote')).toBe('Accent test, lab only: the English model reading English with a Mexican Spanish speaker. Catalog: A confident, upbeat Mexican Spanish adult voice with the natural assurance of a closer. Ideal for proactive assistants and sales-led customer interactions.');
    for (const id of ['phonon-cpu-single', 'phonon-webgpu', 'phone-voice']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '3');
    await page.click('#labRun');
    await page.waitForSelector('#labRun:not([hidden])', { timeout: 120_000 });
    expect(await page.textContent('#labStatus')).toMatch(/^Done\./);
    const dl = page.waitForEvent('download');
    await page.click('#labSave');
    const json = JSON.parse(readFileSync(await (await dl).path(), 'utf8'));
    expect(json).toMatchObject({ voice: 'Regina', voiceLocale: 'es-mx', accentTest: true });
    const c = json.candidates[0];
    expect(c.rows).toHaveLength(3);
    expect(c.summary.failed + c.summary.nanRuns + c.summary.silentRuns).toBe(0);
    expect(requests.some((u) => u.endsWith('/voices-0ee1720/s58clrg2fe0MO7Y-.safetensors'))).toBe(true);

    // The app's own voice settings know nothing of them.
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    expect(await page.textContent('[data-screen=voice]')).not.toMatch(/Regina|Accent|Bryony|Pippa/);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 200_000);
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
    await page.waitForSelector('#labRun:not([hidden])', { timeout: 90_000 });
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
});

describe('the natural voice download, shown as it goes', () => {
  it('the voice lab shows MB and percent up to 100%, then the phases; a failed download says so with Try again', async () => {
    const { ctx, page, errors } = await phone();
    await strictAudio(ctx);
    await page.goto(`${g.url}/v2/#/voice-lab`);
    await page.reload();
    await page.waitForSelector('[data-screen=voiceLab]');
    await expect.poll(() => page.textContent('#labEnv')).toContain('Threads allowed: yes');
    for (const id of ['phonon-cpu-single', 'phonon-webgpu', 'phone-voice']) await page.uncheck(`#lab-${id}`);
    await page.selectOption('#labLines', '3');
    await page.check('#labPlay');

    // The weights fail to arrive: the lab says the download stopped, with Try again.
    await ctx.route('**/model.q8.gguf', (r) => r.abort('internetdisconnected'));
    await page.click('#labRun');
    await page.waitForSelector('#labRetry:not([hidden])', { timeout: 60_000 });
    expect(await page.textContent('#labError')).toMatch(/^The download stopped\. Check the connection and try again\./);
    expect(await page.isVisible('#labMeter')).toBe(true);
    await ctx.unroute('**/model.q8.gguf');

    // Try again, with the connection back: the bar runs to 100%, then Getting ready and the lines.
    await watchMeter(page, 'labMeter');
    await page.click('#labRetry');
    await page.waitForSelector('#labRun:not([hidden])', { timeout: 120_000 });
    expect(await page.textContent('#labStatus')).toMatch(/^Done\./);
    expect(await page.isVisible('#labRetry')).toBe(false);
    const m = await meterSeen(page);
    expect(m.values.some((v) => v > 0 && v < 100)).toBe(true);
    expect(Math.max(...m.values)).toBe(100);
    expect(m.amounts.at(-1)).toMatch(/^6\d\.\d of 6\d\.\d MB, 100%$/);
    expect(m.amounts.some((a) => /^\d+\.\d of 6\d\.\d MB, ([1-9]|[1-9]\d)%$/.test(a))).toBe(true);
    expect(m.phases).toEqual(expect.arrayContaining(['Downloading', 'Getting ready', 'Reading line 1 of 3', 'Reading line 3 of 3']));
    expect(m.phases.indexOf('Downloading')).toBeLessThan(m.phases.indexOf('Getting ready'));
    expect(await heard(page)).toBeGreaterThan(10);
    expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::/.test(e))).toEqual([]);
    await ctx.close();
  }, 200_000);
});
