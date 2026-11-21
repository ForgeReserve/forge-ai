import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { MOCK_TRANSCRIPT } from '../../src/suppliers/mock.ts';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { micArgs, micFile } from './mic.ts';
import { strictAudio } from './phonon-setup.ts';

// Hold to talk in a phone-sized Chrome. The microphone is Chrome's fake capture device (a steady beep),
// reached through the app's own microphone adapter; the engine is a local gateway whose mock audio
// models are private (enclave tier), with the local test mints for funds.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
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

async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 300);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  calls: { transcriptions: number[]; speech: string[] };
}

/** A phone with a funded balance, the microphone allowed, Private only off and the mock-echo model. */
async function phone(from: Browser = browser, init?: () => void): Promise<Phone> {
  const ctx = await from.newContext({ ...PHONE });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone'], { origin: g.url });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 50\d/.test(m.text()) && errors.push(m.text()));
  const calls = { transcriptions: [] as number[], speech: [] as string[] };
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/audio/transcriptions')) calls.transcriptions.push(Date.now());
    if (r.url().endsWith('/v1/audio/speech')) calls.speech.push(JSON.parse(r.postData() ?? '{}').input);
  });
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
  return { ctx, page, errors, calls };
}

/** Presses the talk button with a finger-like pointer, holds for `ms`, and lets go (optionally off the button). */
async function hold(page: Page, sel: string, ms: number, { slideOff = false } = {}) {
  const box = (await page.locator(sel).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  if (slideOff) await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 4 });
  await page.mouse.up();
}

const balance = (page: Page) => page.textContent('#balanceText');

/** The last recording's facts as More, Voice shows them: {state, way, chunks, ...} (screens/settings.js micRows). */
async function micFacts(page: Page): Promise<Record<string, string>> {
  await page.goto(`${g.url}/v2/#/more/voice`);
  await page.waitForSelector('#micFacts:not([hidden])');
  const rows = await page.$$eval('#micFacts li', (lis) => lis.map((li) => [li.getAttribute('data-fact'), li.querySelector('span')?.textContent ?? '']));
  return Object.fromEntries(rows);
}

/** The settings as the app saved them in its database (IndexedDB forge2, kv). */
const settings = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<any>((done) => {
        const open = indexedDB.open('forge2');
        open.onsuccess = () => {
          const db = open.result;
          if (![...db.objectStoreNames].includes('kv')) return done(null);
          const r = db.transaction('kv').objectStore('kv').get('settings');
          r.onsuccess = () => done(r.result ?? null);
          r.onerror = () => done(null);
        };
        open.onerror = () => done(null);
      }),
  );
const cents = (s: string | null) => Math.round(Number(String(s).replace(/[^0-9.]/g, '')) * 100);

describe('hold to talk', () => {
  it('records while held, shows the price first, sends on release, shows the question as text and reads the answer aloud', async () => {
    const { ctx, page, errors, calls } = await phone();
    // Read aloud by the engine (a phone voice would be free and silent here).
    await page.click('#btn-more');
    await page.click('#moreVoice');
    await page.waitForSelector('[data-screen=voice]');
    expect(await page.getAttribute('#voiceIn-engine', 'aria-checked')).toBe('true');
    await page.click('#voiceOut-engine');
    expect(await page.getAttribute('#voiceOut-engine', 'aria-checked')).toBe('true');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    expect(await page.textContent('#talkHint')).toBe('Press and hold to record. Let go to send. Slide off the button to cancel.');

    // Hold: the button records and the line under the rings gives time, route and price.
    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    expect(await page.textContent('#talkBtn')).toContain('Let go to send');
    await expect.poll(() => page.textContent('#talkTime'), { timeout: 4000 }).toMatch(/^0:01\. Slide off to cancel\.$/);
    expect(await page.textContent('.listen-route')).toBe('Engine could hear it. It goes through the engine to a private model. The engine could hear it on the way. Not saved.');
    expect(await page.textContent('#talkPrice')).toMatch(/^(Under|Up to) \$\d+\.\d\d$/);
    // The level bars move with the (fake) microphone.
    await expect.poll(() => page.locator('#talkBtn .bar').first().evaluate((b) => Number((b as HTMLElement).style.getPropertyValue('--h')))).toBeGreaterThan(0.12);
    const before = cents(await balance(page));
    await page.waitForTimeout(400);
    await page.mouse.up();

    // Release: straight to the answer, the question shown as text once heard.
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    expect(calls.transcriptions).toHaveLength(1);
    // The engine took a WAV recording as long as the hold, and billed it by its length: the request
    // price (1 cent = 1000 msub) plus 0.1 cent (100 msub) a second.
    const row: any = g.deps.db.prepare("SELECT charged_msub, status FROM requests WHERE model = 'mock-transcribe' ORDER BY created_at DESC LIMIT 1").get();
    expect(row.status).toBe('settled');
    // The microphone starts a moment after the press, so the sound is a little shorter than the hold.
    expect(row.charged_msub).toBeGreaterThan(1000 + 50); // more than half a second
    expect(row.charged_msub).toBeLessThan(1000 + 500); // less than five
    // The answer streams, then is read aloud by the engine.
    await expect.poll(() => calls.speech.length, { timeout: 20_000 }).toBeGreaterThan(0);
    expect(calls.speech[0]).toMatch(/^Forge word word/);
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    expect(await page.textContent('#answerText')).toMatch(/^Forge word/);
    // Replayed from memory: no new request and no price on the tile.
    const n = calls.speech.length;
    expect(await page.textContent('#speakBtn')).toBe('Listen');
    await page.click('#speakBtn');
    await page.waitForSelector('#speakStopBtn');
    expect(await page.textContent('#speakState')).toMatch(/Speaking|Getting the voice/);
    // The engine's voice sees the answer on its way: the line says so.
    expect(await page.textContent('#speakVia')).toBe('Read by the engine. It sees the answer on the way.');
    await page.click('#speakStopBtn');
    await page.waitForSelector('#speakBtn');
    expect(calls.speech.length).toBe(n);
    // Paid for: the voice, the question and the reading.
    await page.goto(`${g.url}/v2/#/`);
    await expect.poll(async () => cents(await balance(page))).toBeLessThan(before);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  // iPhone Safari heard nothing (owner, 2026-11-21): the capture is an AudioWorklet now, with the old
  // ScriptProcessorNode only where the worklet cannot load. More, Voice shows the last recording's facts.
  it('records through the capture worklet, and More, Voice shows the last recording: its way, its pieces and its sound', async () => {
    const { ctx, page, errors, calls } = await phone();
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    // No recording on this page yet: no facts shown.
    expect(await page.isVisible('#micFacts')).toBe(false);
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 1500);
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    expect(calls.transcriptions).toHaveLength(1);
    const f = await micFacts(page);
    expect(f.way).toBe('worklet');
    expect(f.result).toBe('voice (sent)');
    expect(f.state).toMatch(/running$/);
    expect(Number(f.chunks)).toBeGreaterThan(5);
    expect(Number(f.peak)).toBeGreaterThan(0.1);
    expect(Number(f.heard)).toBeGreaterThan(0.1);
    expect(f.muted).toBe('no');
    // A computer (Chrome): echo cancelling asked off and applied off; Chrome says it applied gain and noise.
    expect(f.echo).toBe('asked no, got no');
    expect(f.got).toMatch(/^gain yes, noise yes, \d+ Hz, 1 ch$/);
    // The loud tone is a voice by the loud rule, sent as it came.
    expect(f.rule).toMatch(/^floor \d\.\d{4}, needs \d\.\d{4}, loud part \d\.\d{4}$/);
    expect(f.gain).toBe('x1.0');
    expect(f.rate).toMatch(/^\d+ Hz$/);
    expect(f.length).toMatch(/^1\.\d s of 1\.\d s$/);
    expect(await page.textContent('#micFactsHead')).toBe('Last recording');
    // Which copy of the app made the recording: the build the worker serves, loaded from the network.
    await expect.poll(async () => (await micFacts(page)).build).toMatch(/^[0-9a-f]{8}$/);
    expect((await micFacts(page)).build).toBe((await page.getAttribute('html', 'data-build'))!.slice(0, 8));
    expect(await page.getAttribute('html', 'data-saved')).toBeNull();
    expect(errors).toEqual([]);
    // Once more online with the worker in charge, so it keeps the app's files; then with no network the
    // phone's kept copy opens, and the page knows it (the readout says "saved copy" beside the build).
    await page.reload();
    await page.waitForSelector('[data-screen=voice]');
    await ctx.setOffline(true);
    await page.reload();
    await page.waitForSelector('[data-screen=voice]');
    await expect.poll(() => page.getAttribute('html', 'data-saved')).toBe('yes');
    await ctx.setOffline(false);
    await ctx.close();
  }, 60_000);

  it("under iPhone Safari's sound rules (a press is not a tap; sound may start while recording), the first hold is heard and later ones reuse the context", async () => {
    const { ctx, page, errors, calls } = await phone();
    await strictAudio(ctx);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 1200);
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    let f = await micFacts(page);
    expect(f.state).toMatch(/running, made again$/);
    expect(f.way).toBe('worklet');
    expect(f.result).toBe('voice (sent)');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 1200);
    await expect.poll(() => calls.transcriptions.length).toBe(2);
    f = await micFacts(page);
    expect(f.state).not.toMatch(/made again/);
    expect(f.result).toBe('voice (sent)');
    // The recording contexts made: one refused in the first press, one made while recording, kept since.
    const made = await page.evaluate(() => (window as any).__audio.made.length);
    expect(made).toBeLessThanOrEqual(4);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  // CI, 2026-11-21: "Go online switches it" timed out on More, Voice now and then. The app had opened the
  // answer screen over it: ask() saved the question (IndexedDB) and then opened the answer screen, even
  // when the person had opened another screen meanwhile. Saving is made slow here so it always happens.
  it('a screen opened while a spoken question is being saved stays open; the answer waits on the answer screen', async () => {
    const { ctx, page, errors, calls } = await phone(browser, () => {
      const real = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...a: any[]) {
        const t: any = (real as any).apply(this, a);
        if ((window as any).__slowChats && a[1] === 'readwrite' && String(a[0]) === 'chats') {
          const d = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
          Object.defineProperty(t, 'oncomplete', { set: (f: any) => d.set!.call(t, () => setTimeout(() => f(), 1500)), get: () => d.get!.call(t) });
        }
        return t;
      };
    });
    await page.evaluate(() => ((window as any).__slowChats = true));
    const heard = page.waitForResponse((r) => r.url().endsWith('/v1/audio/transcriptions'));
    await hold(page, '#talkBtn', 1200);
    await heard;
    // While the question is saved, the person opens More, Voice.
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-engine');
    await page.waitForTimeout(2500);
    expect(await page.getAttribute('[data-screen]', 'data-screen')).toBe('voice');
    expect(new URL(page.url()).hash).toBe('#/more/voice');
    expect(await page.getAttribute('#voiceIn-engine', 'aria-checked')).toBe('true');
    // The answer was made all the same.
    await page.goto(`${g.url}/v2/#/answer`);
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(calls.transcriptions).toHaveLength(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('More, Voice opened before the engine lists its models shows Online once they come, with no reload', async () => {
    const ctx = await browser.newContext({ ...PHONE });
    await pastFirstRun(ctx);
    await ctx.grantPermissions(['microphone'], { origin: g.url });
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await ctx.route('**/v1/models', async (route) => {
      await held;
      await route.continue();
    });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    await page.waitForTimeout(500);
    expect(await page.locator('#voiceIn-engine').count()).toBe(0);
    release();
    await page.waitForSelector('#voiceIn-engine', { timeout: 8000 });
    expect(await page.getAttribute('[data-screen]', 'data-screen')).toBe('voice');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('records the old way where the capture worklet does not load, and still sends', async () => {
    const { ctx, page, errors, calls } = await phone(browser, () => {
      AudioWorklet.prototype.addModule = () => Promise.reject(new DOMException('blocked', 'AbortError'));
    });
    await hold(page, '#talkBtn', 1200);
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    expect(calls.transcriptions).toHaveLength(1);
    const f = await micFacts(page);
    expect(f.way).toBe('script (worklet: AbortError)');
    expect(Number(f.chunks)).toBeGreaterThan(5);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a microphone that gives no sound says so, sends nothing, and the next hold opens it again and is heard', async () => {
    // While __deadMic is set, the microphone's source reaches nothing (as on iOS when the capture never fires).
    const { ctx, page, errors, calls } = await phone(browser, () => {
      const real = AudioContext.prototype.createMediaStreamSource;
      (window as any).__deadMic = true;
      AudioContext.prototype.createMediaStreamSource = function (this: AudioContext, s: MediaStream) {
        if ((window as any).__deadMic) return { connect() {}, disconnect() {} } as any;
        return real.call(this, s);
      };
    });
    await hold(page, '#talkBtn', 2000);
    await expect.poll(() => page.textContent('#answerErrorText'), { timeout: 8000 }).toMatch(/^No sound from the microphone\./);
    expect(await page.textContent('#answerError')).toContain('Hold to say it again.');
    expect(calls.transcriptions).toEqual([]);
    const f = await micFacts(page);
    expect(f.chunks).toBe('0');
    expect(f.result).toBe('no pieces (dead)');
    expect(f.way).toBe('worklet');
    await page.evaluate(() => ((window as any).__deadMic = false));
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 1200);
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    expect(calls.transcriptions).toHaveLength(1);
    expect(Number((await micFacts(page)).chunks)).toBeGreaterThan(5);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('prices Ask again with the reading aloud when the question was spoken, and charges no more than that', async () => {
    const { ctx, page, errors, calls } = await phone();
    const readBy = async (id: string) => {
      await page.goto(`${g.url}/v2/#/more/voice`);
      await page.waitForSelector('[data-screen=voice]');
      await page.click(`#voiceOut-${id}`);
      expect(await page.getAttribute(`#voiceOut-${id}`, 'aria-checked')).toBe('true');
    };
    const againCents = async () => {
      await page.goto(`${g.url}/v2/#/answer`);
      await page.waitForSelector('#againBtn', { timeout: 20_000 });
      const text = await page.textContent('#againBtn');
      expect(text).toMatch(/^Ask againUp to \$\d+\.\d\d$/);
      return cents(text);
    };
    await readBy('engine');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => calls.speech.length, { timeout: 20_000 }).toBeGreaterThan(0);
    await page.waitForSelector('#againBtn', { timeout: 20_000 });
    // Let the first reading finish, so every request after this point is the one Ask again makes.
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    await page.waitForTimeout(500);

    // The engine reads the answer to a spoken question aloud, so Ask again costs more than the chat alone.
    const withReading = await againCents();
    await readBy('off');
    const chatOnly = await againCents();
    expect(withReading).toBeGreaterThan(chatOnly);
    await readBy('engine');
    expect(await againCents()).toBe(withReading);

    // Tap it: the chat and the reading are both charged, and together they stay within the price shown.
    const seen = new Set((g.deps.db.prepare('SELECT id FROM requests').all() as any[]).map((r) => r.id));
    const spoken = calls.speech.length;
    await page.click('#againBtn');
    await expect.poll(() => calls.speech.length, { timeout: 20_000 }).toBeGreaterThan(spoken);
    const fresh = () => (g.deps.db.prepare('SELECT id, model, status, charged_msub FROM requests').all() as any[]).filter((r) => !seen.has(r.id));
    await expect.poll(() => fresh().some((r) => r.model === 'mock-speech') && fresh().every((r) => r.status !== 'running'), { timeout: 20_000 }).toBe(true);
    await page.waitForSelector('#speakBtn', { timeout: 20_000 });
    await expect.poll(() => fresh().every((r) => r.status !== 'running')).toBe(true);
    const rows = fresh();
    expect(rows.some((r) => r.model === 'mock-echo')).toBe(true);
    const charged = rows.reduce((n, r) => n + (r.charged_msub ?? 0), 0);
    expect(charged).toBeGreaterThan(0);
    expect(charged).toBeLessThanOrEqual(withReading * 1000);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('the talk button keeps its place while the recording line shows, in Default and in Playful', async () => {
    const { ctx, page, errors } = await phone();
    for (const mode of ['default', 'playful']) {
      if (mode === 'playful') {
        await page.goto(`${g.url}/v2/#/more/look`);
        await page.waitForSelector('#mode-playful');
        await page.click('#mode-playful');
        await expect.poll(() => page.textContent('#mode-playful')).toContain('On now.');
        // The helper's home, not the cover game it opens on by default (docs/PLAYFUL.md).
        await page.click('#gameFirst');
        await expect.poll(() => page.getAttribute('#gameFirst', 'aria-checked')).toBe('false');
        // The settings are written to IndexedDB without waiting: give the write a moment before the page goes.
        await page.waitForTimeout(500);
        await page.goto(`${g.url}/v2/#/`);
        await page.reload();
        await page.waitForSelector('[data-screen=home][data-mode=playful]');
      }
      await page.waitForSelector('#talkBtn');
      await page.evaluate(() => document.fonts.ready);
      // The rings' box is what must stay put; the button inside it only sinks a little when pressed.
      const at = async () => (await page.locator('.rings').first().boundingBox())!;
      const before = await at();
      await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
      await page.mouse.down();
      await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
      // The recording line (time, where the sound goes, the price) is on show: the button has not moved.
      await expect.poll(() => page.isVisible('#talkTime')).toBe(true);
      await page.waitForTimeout(400);
      const held = await at();
      expect(Math.abs(held.y - before.y), `${mode}: moved down or up`).toBeLessThanOrEqual(1);
      expect(Math.abs(held.x - before.x), `${mode}: moved sideways`).toBeLessThanOrEqual(1);
      // Slide off and let go: nothing is asked, and the button is where it was.
      await page.mouse.move(before.x + before.width / 2, before.y - 150, { steps: 4 });
      await page.mouse.up();
      await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('idle');
      await page.waitForTimeout(300);
      const after = await at();
      expect(Math.abs(after.y - before.y), `${mode}: did not come back`).toBeLessThanOrEqual(1);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a hold with nothing said is not sent: no speech request, no question, nothing paid, and the app says so', async () => {
    // A microphone that hears silence (test/ui/mic.ts).
    const quiet = await chromium.launch({ channel: 'chrome', headless: true, args: micArgs(micFile({ voice: false })) });
    try {
      const { ctx, page, errors, calls } = await phone(quiet);
      const chats: string[] = [];
      page.on('request', (r) => r.url().endsWith('/v1/chat/completions') && chats.push(r.url()));
      await hold(page, '#talkBtn', 2500);
      await expect.poll(() => page.textContent('#answerErrorText'), { timeout: 8000 }).toBe('Nothing was heard. Hold the button and speak.');
      await page.waitForTimeout(500);
      expect(calls.transcriptions).toEqual([]);
      expect(chats).toEqual([]);
      // The microphone gave its samples (all silence): that is Nothing was heard, not a microphone problem.
      const f = await micFacts(page);
      expect(parseInt(f.chunks!, 10)).toBeGreaterThan(5);
      expect(Number(f.peak)).toBeLessThan(0.05);
      expect(f.result).toMatch(/^pieces (of exact zeros|below the voice level) \(quiet\)$/);
      expect(f.level).toMatch(/^0\.\d{4} \(loud voice at 0\.0500\)$/);
      expect(f.gain).toBe('x1.0');
      await page.goto(`${g.url}/v2/#/`);
      await page.waitForSelector('[data-screen=home]');
      await expect.poll(() => page.textContent('#balanceText')).toBe('$3.00');
      expect(errors).toEqual([]);
      await ctx.close();
    } finally {
      await quiet.close();
    }
  }, 90_000);

  it('a tap explains the button, sliding off cancels, and neither sends anything', async () => {
    const { ctx, page, errors, calls } = await phone();
    await hold(page, '#talkBtn', 80);
    await expect.poll(() => page.textContent('#toast')).toBe('Hold to talk. Hold the button down while you talk. Let go to send. Slide off the button to cancel.');
    expect(await page.getAttribute('#talkBtn', 'data-phase')).toBe('idle');

    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.move(box.x + box.width / 2, box.y - 150, { steps: 4 });
    await expect.poll(() => page.textContent('#talkBtn')).toContain('Let go to cancel');
    expect(await page.textContent('#talkTime')).toMatch(/Let go to cancel\.$/);
    await page.mouse.up();
    await expect.poll(() => page.textContent('#toast')).toBe('Cancelled. No question was asked.');
    expect(await page.getAttribute('#talkBtn', 'data-phase')).toBe('idle');
    expect(await page.locator('[data-screen=home]').count()).toBe(1);
    await page.waitForTimeout(300);
    expect(calls.transcriptions).toHaveLength(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('works from the keyboard, and with reading aloud off nothing is read', async () => {
    const { ctx, page, errors, calls } = await phone();
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    await page.click('#voiceOut-off');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await page.focus('#talkBtn');
    await page.keyboard.down('Space');
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    await page.waitForTimeout(900);
    await page.keyboard.up('Space');
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    await page.waitForTimeout(500);
    expect(calls.speech).toHaveLength(0);
    expect(await page.isVisible('#speakBtn')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a failed transcription says so plainly, is not charged and asks to hold again', async () => {
    const { ctx, page, errors } = await phone();
    await page.route('**/v1/audio/transcriptions', (route) =>
      route.fulfill({ status: 502, contentType: 'application/json', headers: { 'x-forge-charged-msub': '0' }, body: JSON.stringify({ error: { code: 'upstream_error', message: 'upstream returned HTTP 500. You were not charged.' } }) }),
    );
    const before = await balance(page);
    await hold(page, '#talkBtn', 900);
    await page.waitForSelector('[data-screen=answer]');
    await page.waitForSelector('#answerError:not([hidden])');
    expect(await page.textContent('.asked')).toBe('Your voice question');
    expect(await page.textContent('#answerError')).toBe('No answer, not charged. The model did not answer, so you were not charged. The reason given: upstream returned HTTP 500Hold to say it again.');
    await page.goto(`${g.url}/v2/#/`);
    await expect.poll(() => balance(page)).toBe(before);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('with Private only on and no private voice model, the button opens Type', async () => {
    const ctx = await browser.newContext({ ...PHONE });
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    // An engine whose only speech to text model is a standard one.
    await page.route('**/v1/models', async (route) => {
      const res = await route.fetch();
      const body: any = await res.json();
      body.audio = body.audio.filter((m: any) => m.tier !== 'enclave');
      await route.fulfill({ response: res, json: body });
    });
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.evaluate(() => new Promise((r) => setTimeout(r, 300)));
    expect(await page.textContent('#talkHint')).toBe('Voice comes soon. Type your question for now.');
    await page.click('#talkBtn');
    await page.waitForSelector('[data-screen=type]');
    await ctx.close();
  }, 60_000);
});

// In the Android app, the phone's own on-device recogniser hears Hold to talk (ForgeSpeech). Here a
// stand-in for Capacitor's bridge plays the plugin: it says whether the recogniser has the language,
// sends words while the button is held and the final words after the release. Chrome's microphone is
// not allowed in this context: the sound never goes through the page, only words come back. With asr,
// it plays Forge Private Voice's own speech to text too (ForgeAsr, the same events). With ios, it is the
// iPhone app's bridge (SpeechPlugin.swift): Capacitor says 'ios' and lists the plugins the app has,
// ForgeSpeech only where speech is true (a build before it has none). silent: a hold with nothing said,
// which the plugin ends with no-speech. A test can change how the recogniser behaves between presses
// with window.__speechMode: 'words' (the default), 'silent', or 'deaf' (the level shows sound every
// 100 ms while held, and the press still ends with no-speech, as on the Galaxy A16). mic: Chrome's
// microphone is allowed too, for the engine's way. privateOnly: Private only stays on (no model is picked).
// standardAudio: the engine lists no private speech to text model.
async function appPhone({ onDevice, asr = false, ios = false, speech = true, silent = false, mic = false, privateOnly = false, standardAudio = false }: { onDevice: boolean; asr?: boolean; ios?: boolean; speech?: boolean; silent?: boolean; mic?: boolean; privateOnly?: boolean; standardAudio?: boolean }) {
  const ctx = await browser.newContext({ ...PHONE });
  // An engine whose only speech to text model is a standard one.
  if (standardAudio)
    await ctx.route('**/v1/models', async (route) => {
      const res = await route.fetch();
      const body: any = await res.json();
      body.audio = body.audio.filter((m: any) => m.tier !== 'enclave');
      await route.fulfill({ response: res, json: body });
    });
  await pastFirstRun(ctx);
  if (mic) await ctx.grantPermissions(['microphone'], { origin: g.url });
  await ctx.addInitScript(([ready, bundled, iphone, hasSpeech, quiet]: boolean[]) => {
    const w = window as any;
    const listeners: Array<{ plugin: string; event: string; fn: (ev: any) => void }> = [];
    w.__native = { calls: [] as string[] };
    w.__speechMode ??= quiet ? 'silent' : 'words';
    let loud: ReturnType<typeof setInterval> | undefined;
    const EVENT: Record<string, string> = { ForgeSpeech: 'speech', ForgeAsr: 'asr' };
    w.Capacitor = {
      ...(iphone ? { getPlatform: () => 'ios', Plugins: { ForgeBars: {}, ForgeNfc: {}, ...(hasSpeech ? { ForgeSpeech: {} } : {}) } } : {}),
      isNativePlatform: () => true,
      nativePromise: async (plugin: string, method: string, opts: any) => {
        w.__native.calls.push(`${plugin}.${method}`);
        if (!EVENT[plugin]) return undefined;
        const emit = (id: string, ev: any) => {
          for (const l of listeners) if (l.plugin === plugin && l.event === EVENT[plugin]) l.fn({ id, ...ev });
        };
        if (plugin === 'ForgeAsr' && method === 'available') return { available: bundled, reason: bundled ? null : 'no speech to text in this app', language: 'en' };
        if (method === 'available') return { onDevice: ready, reason: ready ? null : 'no-on-device-recognizer', locale: 'en-US' };
        const mode = plugin === 'ForgeSpeech' ? w.__speechMode : quiet ? 'silent' : 'words';
        if (method === 'start') {
          const at = (ms: number, ev: any) => setTimeout(() => emit(opts.id, ev), ms);
          at(50, { type: 'started' });
          if (mode === 'deaf') loud = setInterval(() => emit(opts.id, { type: 'level', level: 0.45 }), 100);
          else at(250, { type: 'level', level: mode === 'silent' ? 0.02 : 0.5 });
          if (mode === 'words') at(300, { type: 'partial', text: 'What should' });
          if (mode === 'words') at(700, { type: 'partial', text: 'What should I bring' });
          return {};
        }
        if (method === 'stop') {
          clearInterval(loud);
          setTimeout(() => {
            emit(opts.id, mode === 'words' ? { type: 'final', text: 'What should I bring to the beach?' } : { type: 'error', code: 'no-speech' });
            emit(opts.id, { type: 'end' });
          }, 100);
          return {};
        }
        if (method === 'cancel') {
          clearInterval(loud);
          emit(opts.id, { type: 'end' });
        }
        return {};
      },
      addListener: (plugin: string, event: string, fn: (ev: any) => void) => {
        listeners.push({ plugin, event, fn });
        return { remove: async () => {} };
      },
    };
  }, [onDevice, asr, ios, speech, silent]);
  // Nothing reaches Forge's engine (the app's default): only this computer.
  const outside: string[] = [];
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => {
    outside.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const transcriptions: string[] = [];
  page.on('request', (r) => r.url().endsWith('/v1/audio/transcriptions') && transcriptions.push(r.url()));
  // The local engine, set in More as a person would; then a balance on it.
  await page.goto(`${g.url}/v2/#/more/engine`);
  await page.waitForSelector('[data-screen=engine]');
  await page.fill('#engineAddress', `${g.url}/`);
  await Promise.all([page.waitForEvent('load'), page.click('#engineUse')]);
  await page.waitForSelector('[data-screen=home]');
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), await fundedKey());
  if (!privateOnly) {
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    await page.click('[data-model="mock-echo"]');
  }
  const calls = () => page.evaluate(() => (window as any).__native.calls as string[]);
  return { ctx, page, errors, outside, transcriptions, calls };
}

describe('hold to talk on this phone (the Android app)', () => {
  it("is heard by the phone's own recogniser: listed first in More, Voice, free, the live words shown, sent on release", async () => {
    const { ctx, page, errors, outside, transcriptions, calls } = await appPhone({ onDevice: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    // The choice reads at a glance (its tags); the full line is behind its info button and read to screen readers.
    expect(await page.textContent('#voiceIn-phone')).toBe('On this phoneFreeOn phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-description')).toBe('Free and private. This phone turns your voice into words. Your voice does not leave the phone.');
    // The engine is still there to pick.
    expect(await page.getAttribute('#voiceIn-engine', 'aria-checked')).toBe('false');
    expect(await page.locator('#voiceInHead + .model-list .model-card').first().getAttribute('id')).toBe('voiceIn-phone');
    await page.click('#voiceOut-off');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toBe('$3.00');

    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    expect(await page.textContent('.listen-route')).toBe('Stays on this phone. This phone turns it into words. Your voice does not leave the phone.');
    // The words as the phone hears them, and the level bars move with its level.
    await expect.poll(() => page.textContent('.listen-text'), { timeout: 4000 }).toBe('What should I bring');
    await expect.poll(() => page.locator('#talkBtn .bar').first().evaluate((b) => Number((b as HTMLElement).style.getPropertyValue('--h')))).toBeGreaterThan(0.12);
    // Turning the voice into words costs nothing: only the question is priced.
    expect(await page.textContent('#talkPrice')).toMatch(/^(Under|Up to) \$\d+\.\d\d$/);
    await page.mouse.up();

    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe('What should I bring to the beach?');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(transcriptions).toEqual([]);
    const made = await calls();
    expect(made.filter((c) => c.startsWith('ForgeSpeech.'))).toEqual(['ForgeSpeech.available', 'ForgeSpeech.start', 'ForgeSpeech.stop']);
    expect(outside.every((u) => u.startsWith('https://ai.forge-reserve.com/'))).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("Forge Private Voice hears it with its own model first, where the phone has no recogniser (GrapheneOS)", async () => {
    const { ctx, page, errors, outside, transcriptions, calls } = await appPhone({ onDevice: false, asr: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    // One On this phone row, listed first.
    expect(await page.locator('#voiceInHead + .model-list .model-card').first().getAttribute('id')).toBe('voiceIn-phone');
    expect(await page.locator('#voiceIn-phone').count()).toBe(1);
    await page.click('#voiceOut-off');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toBe('$3.00');
    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    expect(await page.textContent('.listen-route')).toBe('Stays on this phone. This phone turns it into words. Your voice does not leave the phone.');
    await expect.poll(() => page.textContent('.listen-text'), { timeout: 4000 }).toBe('What should I bring');
    await page.mouse.up();
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe('What should I bring to the beach?');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(transcriptions).toEqual([]);
    const made = await calls();
    expect(made.filter((c) => c.startsWith('ForgeAsr.'))).toEqual(['ForgeAsr.available', 'ForgeAsr.start', 'ForgeAsr.stop']);
    expect(made.filter((c) => c.startsWith('ForgeSpeech.'))).toEqual(['ForgeSpeech.available']);
    expect(outside.every((u) => u.startsWith('https://ai.forge-reserve.com/'))).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  // Owner, 2026-11-18: a recogniser that opens the microphone, shows sound, and still hears nothing. The
  // app asks before the voice goes online; privacy is the default.
  /** Goes home and holds the talk button for `ms`; the answer screen then says what was heard. */
  const homeAndHold = async (page: Page, ms: number) => {
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toMatch(/^\$\d/);
    await hold(page, '#talkBtn', ms);
    await page.waitForSelector('[data-screen=answer]');
  };
  const nothing = 'Nothing was heard. Hold the button and speak.';
  /** A press the phone hears as nothing, and that the app asked nothing after it. */
  const missNoAsk = async (page: Page) => {
    await homeAndHold(page, 1800);
    await expect.poll(() => page.textContent('#answerErrorText'), { timeout: 8000 }).toBe(nothing);
    // The question opens in the same turn as the line (core/talkctl.js), so it would be here by now.
    expect(await page.locator('#voiceAsk').count()).toBe(0);
  };
  /** Two misses: the first asks nothing, the second opens the question over "Nothing was heard." */
  const twoMisses = async (page: Page) => {
    await missNoAsk(page);
    await expect.poll(() => settings(page).then((x) => x?.phoneMisses)).toBe(1);
    await homeAndHold(page, 1800);
    await page.waitForSelector('#voiceAsk[open]');
    expect(await page.textContent('#answerErrorText')).toBe(nothing);
    expect(await page.textContent('#voiceAskText')).toBe('This phone could not hear you. Your voice can go online to become words.');
    expect(await page.locator('#voiceAskText svg').count()).toBe(1);
    expect(await page.textContent('#voiceGo')).toBe('Go online');
    expect(await page.textContent('#voiceKeep')).toBe('Keep on this phone');
    // The safe answer has the focus; nothing switched yet.
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('voiceKeep');
    expect((await settings(page))?.phoneOff).toBe(false);
  };
  const speechCalls = async (calls: () => Promise<string[]>) => (await calls()).filter((c) => c.startsWith('ForgeSpeech.'));

  it('two presses heard as nothing ask first; Keep on this phone keeps the recogniser and is never asked again', async () => {
    const { ctx, page, errors, transcriptions, calls } = await appPhone({ onDevice: true, mic: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    await page.click('#voiceOut-off');
    await page.evaluate(() => ((window as any).__speechMode = 'deaf'));
    await twoMisses(page);
    // Turning the voice into words online is paid: the price, as the talk line says prices.
    expect(await page.textContent('#voiceAskPrice')).toMatch(/^Price(Under|Up to) \$\d+\.\d\d$/);
    // The engine's speech to text model is a private one here: no Not private tag.
    expect(await page.locator('#voiceAsk .tag').count()).toBe(0);
    await page.locator('#voiceKeep').tap();
    await page.waitForSelector('#voiceAsk', { state: 'detached' });
    await expect.poll(() => settings(page).then((x) => [x?.phoneOff, x?.phoneAsked])).toEqual([false, true]);
    // Later misses ask nothing, and the phone keeps hearing it.
    await missNoAsk(page);
    await missNoAsk(page);
    expect((await settings(page))?.phoneOff).toBe(false);
    expect(transcriptions).toEqual([]);
    expect(await speechCalls(calls)).toEqual(['ForgeSpeech.available', ...Array(4).fill(['ForgeSpeech.start', 'ForgeSpeech.stop']).flat()]);
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    expect(await page.isVisible('#voicePhoneOff')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('Go online switches it: the next hold is heard by the engine; More, Voice shows it and On this phone takes it back without asking again', async () => {
    const { ctx, page, errors, transcriptions, calls } = await appPhone({ onDevice: true, mic: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    await page.click('#voiceOut-off');
    await page.evaluate(() => ((window as any).__speechMode = 'deaf'));
    await twoMisses(page);
    await page.locator('#voiceGo').tap();
    await page.waitForSelector('#voiceAsk', { state: 'detached' });
    await expect.poll(() => settings(page).then((x) => [x?.phoneOff, x?.phoneAsked])).toEqual([true, true]);
    expect(transcriptions).toEqual([]);

    // Remembered: after a reload, the next press records with the microphone and the engine hears it.
    await page.reload();
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toMatch(/^\$\d/);
    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    expect(await page.textContent('.listen-route')).toBe('Engine could hear it. It goes through the engine to a private model. The engine could hear it on the way. Not saved.');
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    expect(transcriptions).toHaveLength(1);
    // The phone's recogniser was not started for it (the calls are counted from the reload).
    expect(await speechCalls(calls)).toEqual(['ForgeSpeech.available']);

    // More, Voice: Online is the way in use, with a line that says the person chose it.
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-engine', 'aria-checked')).toBe('true');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('false');
    expect(await page.isVisible('#voicePhoneOff')).toBe(true);
    expect(await page.textContent('#voicePhoneOff')).toBe('You chose to go online. This phone could not hear you, so your voice goes online to become words. Tap On this phone to use the phone again.');
    expect(await page.locator('#voicePhoneOff svg').count()).toBeGreaterThan(0);
    await page.click('#voiceIn-phone');
    await expect.poll(() => page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    expect(await page.isVisible('#voicePhoneOff')).toBe(false);
    await expect.poll(() => settings(page).then((x) => [x?.phoneOff, x?.phoneMisses, x?.phoneAsked])).toEqual([false, 0, true]);
    // Back on the phone after the switch: misses ask nothing again (the reload set the stand-in back to words).
    await page.evaluate(() => ((window as any).__speechMode = 'deaf'));
    await missNoAsk(page);
    await missNoAsk(page);
    expect(transcriptions).toHaveLength(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('a phone the previous build switched on its own hears on the phone again and is asked; Back keeps it on the phone', async () => {
    const { ctx, page, errors, transcriptions } = await appPhone({ onDevice: true, mic: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    await page.click('#voiceOut-off');
    await expect.poll(() => settings(page).then((x) => x?.voiceOut)).toBe('off');
    // What the previous build saved after its automatic switch: phoneOff, and no record of a question.
    await page.evaluate(async () => {
      const db: IDBDatabase = await new Promise((r) => (indexedDB.open('forge2').onsuccess = (e: any) => r(e.target.result)));
      const read = db.transaction('kv').objectStore('kv').get('settings');
      const saved: any = await new Promise((r) => (read.onsuccess = () => r(read.result)));
      delete saved.phoneAsked;
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put({ ...saved, phoneOff: true, phoneMisses: 0 }, 'settings');
      await new Promise((r) => (tx.oncomplete = r));
      db.close();
    });
    await page.reload();
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    expect(await page.isVisible('#voicePhoneOff')).toBe(false);
    await page.evaluate(() => ((window as any).__speechMode = 'deaf'));
    await twoMisses(page);
    // Back (Escape here) is the safe answer, as a tap beside the sheet is.
    await page.keyboard.press('Escape');
    await page.waitForSelector('#voiceAsk', { state: 'detached' });
    await expect.poll(() => settings(page).then((x) => [x?.phoneOff, x?.phoneAsked])).toEqual([false, true]);
    await missNoAsk(page);
    expect(transcriptions).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('with Private only on and no private speech to text model, two misses ask nothing and the phone keeps listening', async () => {
    const { ctx, page, errors, transcriptions } = await appPhone({ onDevice: true, mic: true, privateOnly: true, standardAudio: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    await page.click('#voiceOut-off');
    await page.evaluate(() => ((window as any).__speechMode = 'deaf'));
    await missNoAsk(page);
    await missNoAsk(page);
    await expect.poll(() => settings(page).then((x) => [x?.phoneMisses, x?.phoneOff, x?.phoneAsked])).toEqual([2, false, false]);
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    expect(transcriptions).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('short presses, silent holds and a press with words between never ask', async () => {
    const { ctx, page, errors, transcriptions } = await appPhone({ onDevice: true, mic: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    await page.click('#voiceOut-off');
    const press = async (mode: string, ms: number, said: string | RegExp) => {
      await page.evaluate((m) => ((window as any).__speechMode = m), mode);
      await page.goto(`${g.url}/v2/#/`);
      await page.waitForSelector('[data-screen=home]');
      await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toMatch(/^\$\d/);
      await hold(page, '#talkBtn', ms);
      await page.waitForSelector('[data-screen=answer]');
      if (typeof said === 'string') await expect.poll(() => page.textContent('#answerErrorText'), { timeout: 8000 }).toBe(said);
      else {
        await expect.poll(() => page.textContent('.asked'), { timeout: 8000 }).toMatch(said);
        await page.waitForSelector('#copyBtn', { timeout: 20_000 });
      }
    };
    const empty = 'Nothing was heard. Hold the button and speak.';
    // Two short presses with sound, two silent holds: nothing counted.
    await press('deaf', 900, empty);
    await press('deaf', 900, empty);
    await press('silent', 1800, empty);
    await press('silent', 1800, empty);
    expect((await settings(page))?.phoneMisses ?? 0).toBe(0);
    // A miss, then words: the count starts again, so the next miss is only the first.
    await press('deaf', 1800, empty);
    await expect.poll(() => settings(page).then((x) => x?.phoneMisses)).toBe(1);
    await press('words', 900, /^What should I bring to the beach\?$/);
    await expect.poll(() => settings(page).then((x) => x?.phoneMisses)).toBe(0);
    await press('deaf', 1800, empty);
    await expect.poll(() => settings(page).then((x) => x?.phoneMisses)).toBe(1);
    expect((await settings(page))?.phoneOff).toBe(false);
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    expect(await page.isVisible('#voicePhoneOff')).toBe(false);
    expect(transcriptions).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('uses the engine where the phone has no on-device recogniser for the language', async () => {
    const { ctx, page, errors, calls } = await appPhone({ onDevice: false });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-engine');
    expect(await page.getAttribute('#voiceIn-engine', 'aria-checked')).toBe('true');
    expect(await page.locator('#voiceIn-phone').count()).toBe(0);
    expect((await calls()).filter((c) => c.startsWith('ForgeSpeech.'))).toEqual(['ForgeSpeech.available']);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('hold to talk on this phone (the iPhone app)', () => {
  it("is heard by Apple's recogniser on the phone: chosen first, the live words shown, the final words asked, nothing sent to the engine's speech to text", async () => {
    const { ctx, page, errors, outside, transcriptions, calls } = await appPhone({ onDevice: true, ios: true });
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('#voiceIn-phone');
    expect(await page.getAttribute('#voiceIn-phone', 'aria-checked')).toBe('true');
    expect(await page.locator('#voiceInHead + .model-list .model-card').first().getAttribute('id')).toBe('voiceIn-phone');
    await page.click('#voiceOut-off');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toBe('$3.00');

    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    expect(await page.textContent('.listen-route')).toBe('Stays on this phone. This phone turns it into words. Your voice does not leave the phone.');
    await expect.poll(() => page.textContent('.listen-text'), { timeout: 4000 }).toBe('What should I bring');
    await expect.poll(() => page.locator('#talkBtn .bar').first().evaluate((b) => Number((b as HTMLElement).style.getPropertyValue('--h')))).toBeGreaterThan(0.12);
    await page.mouse.up();

    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe('What should I bring to the beach?');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(transcriptions).toEqual([]);
    const made = await calls();
    expect(made.filter((c) => c.startsWith('ForgeSpeech.'))).toEqual(['ForgeSpeech.available', 'ForgeSpeech.start', 'ForgeSpeech.stop']);
    // The iPhone app has no Forge Private Voice.
    expect(made.filter((c) => c.startsWith('ForgeAsr.'))).toEqual([]);
    expect(outside.every((u) => u.startsWith('https://ai.forge-reserve.com/'))).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a silent hold asks nothing: the app says nothing was heard', async () => {
    const { ctx, page, errors, transcriptions, calls } = await appPhone({ onDevice: true, ios: true, silent: true });
    const chats: string[] = [];
    page.on('request', (r) => r.url().endsWith('/v1/chat/completions') && chats.push(r.url()));
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toBe('$3.00');
    await hold(page, '#talkBtn', 900);
    await expect.poll(() => page.textContent('#answerErrorText'), { timeout: 8000 }).toBe('Nothing was heard. Hold the button and speak.');
    expect((await calls()).filter((c) => c.startsWith('ForgeSpeech.'))).toEqual(['ForgeSpeech.available', 'ForgeSpeech.start', 'ForgeSpeech.stop']);
    expect(transcriptions).toEqual([]);
    expect(chats).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("uses the engine where Apple hears the language only on its servers, and in an app built before ForgeSpeech", async () => {
    for (const opts of [{ onDevice: false, ios: true }, { onDevice: true, ios: true, speech: false }]) {
      const { ctx, page, errors, calls } = await appPhone(opts);
      await page.goto(`${g.url}/v2/#/more/voice`);
      await page.waitForSelector('#voiceIn-engine');
      expect(await page.getAttribute('#voiceIn-engine', 'aria-checked')).toBe('true');
      expect(await page.locator('#voiceIn-phone').count()).toBe(0);
      expect((await calls()).filter((c) => c.startsWith('ForgeSpeech.'))).toEqual(opts.speech === false ? [] : ['ForgeSpeech.available']);
      expect(errors).toEqual([]);
      await ctx.close();
    }
  }, 90_000);
});
