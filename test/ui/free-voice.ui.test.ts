import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { MOCK_TRANSCRIPT } from '../../src/suppliers/mock.ts';
import { createInvite, type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Free voice questions (docs/PAYMENTS.md) in the v2 app: a $0 balance opened with an invite, on a free
// model, holds to talk, sees "Free", and gets an answer without being charged. Once today's free voice
// questions are used up, the app says so plainly, before recording and when the engine refuses one.
// The microphone is Chrome's fake capture device; the engine is a local gateway with mock audio models.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const USED_UP = 'Free voice questions are used up for today. Type instead, or add funds.';

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    audio: true,
    env: { FORGE_INVITE_ONLY: 'true', FORGE_FREE_VOICE_PER_DAY: '1' },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'free-echo', name: 'Free Echo', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
    },
  });
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

/** A $0 balance opened with an invite code, as Start free opens one. */
async function openKey(): Promise<{ key: string; id: string }> {
  const r = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`open failed: ${JSON.stringify(b)}`);
  return { key: b.key, id: b.account_id };
}

interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  transcriptions: number[];
  id: string;
}

/** A phone with a $0 balance key, the microphone allowed, Private only off, the free model, nothing read aloud. */
async function phone(): Promise<Phone> {
  const ctx = await browser.newContext({ ...PHONE });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 402/.test(m.text()) && errors.push(m.text()));
  const transcriptions: number[] = [];
  page.on('request', (r) => r.url().endsWith('/v1/audio/transcriptions') && transcriptions.push(Date.now()));
  const { key, id } = await openKey();
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click('[data-model="free-echo"]');
  await page.goto(`${g.url}/v2/#/more/voice`);
  await page.waitForSelector('[data-screen=voice]');
  expect(await page.getAttribute('#voiceIn-engine', 'aria-checked')).toBe('true');
  await page.click('#voiceOut-off');
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
  await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toBe('$0.00');
  return { ctx, page, errors, transcriptions, id };
}

async function press(page: Page) {
  const box = (await page.locator('#talkBtn').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
}

describe('free voice questions', () => {
  it('a $0 balance holds to talk, sees Free, and gets an answer at no charge', async () => {
    const { ctx, page, errors, transcriptions, id } = await phone();
    await press(page);
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    await expect.poll(() => page.textContent('#talkTime'), { timeout: 4000 }).toMatch(/^0:01\./);
    expect(await page.textContent('#talkPrice')).toBe('Free');
    await page.mouse.up();

    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('.asked')).toBe(MOCK_TRANSCRIPT);
    await expect.poll(() => page.textContent('#answerText'), { timeout: 20_000 }).toMatch(/^Forge word/);
    expect(transcriptions).toHaveLength(1);
    const row: any = g.deps.db.prepare("SELECT charged_msub, cost_source, status FROM requests WHERE model = 'mock-transcribe' AND account_id = ?").get(id);
    expect(row).toEqual({ charged_msub: 0, cost_source: 'operator', status: 'settled' });
    expect(g.deps.ledger.get(id)!.balance_msub).toBe(0);

    // The one free voice question of the day is used: the next hold says so, and records nothing.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await press(page);
    await expect.poll(() => page.textContent('#toast')).toBe(USED_UP);
    await page.mouse.up();
    expect(await page.getAttribute('#talkBtn', 'data-phase')).toBe('idle');
    expect(transcriptions).toHaveLength(1);
    // Typing is not affected: the free model still answers.
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'And by typing?');
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('#answerText'), { timeout: 20_000 }).toMatch(/^Forge word/);
    expect(g.deps.ledger.get(id)!.balance_msub).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('says so plainly when the engine refuses one that was used up elsewhere', async () => {
    const { ctx, page, errors, transcriptions, id } = await phone();
    // The same balance's free voice question is used on another phone after this one last looked.
    g.deps.freeVoice!.take(id, 10_000_000);
    await press(page);
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    await page.waitForTimeout(900);
    await page.mouse.up();
    await page.waitForSelector('[data-screen=answer]');
    await expect.poll(() => page.textContent('#answerError'), { timeout: 8000 }).toContain(USED_UP);
    expect(await page.textContent('#nextStep')).toBe('Add funds');
    expect(transcriptions).toHaveLength(1);
    expect(g.deps.ledger.get(id)!.balance_msub).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});
