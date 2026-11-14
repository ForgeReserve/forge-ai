import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { MOCK_TRANSCRIPT } from '../../src/suppliers/mock.ts';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

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
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
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
async function phone(): Promise<Phone> {
  const ctx = await browser.newContext({ ...PHONE });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone'], { origin: g.url });
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
    await expect.poll(() => page.textContent('#talkTime'), { timeout: 4000 }).toMatch(/^0:01\. Slide your finger off the button to cancel\.$/);
    expect(await page.textContent('.listen-route')).toBe('Goes through the engine to a private model. The engine could hear it on the way. Not saved.');
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

  it('a tap explains the button, sliding off cancels, and neither sends anything', async () => {
    const { ctx, page, errors, calls } = await phone();
    await hold(page, '#talkBtn', 80);
    await expect.poll(() => page.textContent('#toast')).toBe('Hold the button down while you talk. Let go to send. Slide off the button to cancel.');
    expect(await page.getAttribute('#talkBtn', 'data-phase')).toBe('idle');

    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700);
    await page.mouse.move(box.x + box.width / 2, box.y - 150, { steps: 4 });
    await expect.poll(() => page.textContent('#talkBtn')).toContain('Let go to cancel');
    expect(await page.textContent('#talkTime')).toMatch(/Let go now to cancel\.$/);
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
    expect(await page.textContent('#answerError')).toBe('The model did not answer. You were not charged.Hold the button to say it again.');
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
