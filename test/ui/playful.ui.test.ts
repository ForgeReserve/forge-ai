import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { selection, wordAt } from './select.ts';
import { micArgs } from './mic.ts';

// Playful mode (docs/PLAYFUL.md) in a phone-sized Chrome: chosen in Mode and look and kept after a reload,
// its home (Pip, the rings, the coloured bar) and its answer (a streamed answer in the card, Again, Share,
// held Burn), Hold to talk with Chrome's fake microphone, and the fit at 360 by 640 and 412 by 915. The
// engine is a local gateway with the mock models and private mock audio models, with the local test mints.
// PLAYFUL_SHOTS=1 also saves screenshots of the home and the answer to .tmp/playful-shots.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = process.env.PLAYFUL_SHOTS ? resolve(import.meta.dirname, '../../.tmp/playful-shots') : null;

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    audio: true,
    env: { FORGE_INVITE_ONLY: 'true' },
    // The mock model whose answer opens with a sentence and goes on in Markdown, for the card's two sizes.
    editCatalog: (c) => c.models.push({ ...c.models.find((m: any) => m.id === 'mock-echo'), id: 'mock-think', upstream: 'mock-think' }),
  });
  browser = await chromium.launch({
    channel: 'chrome',
    headless: true,
    args: micArgs(),
  });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
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
  asked: string[];
}

/**
 * A phone past the first run. funded: a $3 balance, Private only off and `model` chosen. playful: Playful
 * chosen in Mode and look. Ends on the home.
 */
async function phone({ viewport = PHONE.viewport, funded = true, playful = true, model = 'mock-echo' } = {}): Promise<Phone> {
  const ctx = await browser.newContext({ ...PHONE, viewport });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} ${m.location().url}`));
  const asked: string[] = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await page.goto(`${g.url}/v2/`);
  await page.waitForSelector('[data-screen=home]');
  if (funded) {
    const key = await fundedKey();
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    await page.click(`[data-model="${model}"]`);
  }
  if (playful) await choose(page, 'playful');
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
  // $3 at the mock models' price: a little left.
  if (funded) await expect.poll(() => page.getAttribute('#starChip', 'data-level'), { timeout: 8000 }).toMatch(/^(lots|little)$/);
  return { ctx, page, errors, asked };
}

/**
 * Chooses a mode in More, Mode and look. Playful's helper screens are what this file tests: "Open as a
 * game first" is turned off, so the app opens on the helper (the cover game is game.ui.test.ts).
 */
async function choose(page: Page, mode: string) {
  await page.goto(`${g.url}/v2/#/more/look`);
  await page.waitForSelector('[data-screen=look]');
  await page.click(`#mode-${mode}`);
  // On only once the mode's screens, styles and typefaces are in (Playful waits up to 1.5 s for its typefaces).
  await expect.poll(() => page.getAttribute(`#mode-${mode}`, 'aria-checked'), { timeout: 10_000 }).toBe('true');
  if (mode === 'playful' && (await page.getAttribute('#gameFirst', 'aria-checked')) === 'true') {
    await page.click('#gameFirst');
    await expect.poll(() => page.getAttribute('#gameFirst', 'aria-checked')).toBe('false');
    // The settings are written to IndexedDB without waiting: give the write a moment before the page goes.
    await page.waitForTimeout(500);
  }
}

const playfulHome = (page: Page) => page.waitForSelector('[data-screen=home][data-mode=playful]');
const bg = (page: Page, sel: string) => page.$eval(sel, (n) => getComputedStyle(n).backgroundColor);
/** The text of Pip's bubble or line, without the info button's words. */
const pipText = (page: Page, sel: string) =>
  page.$eval(sel, (n) => {
    const c = n.cloneNode(true) as HTMLElement;
    for (const x of c.querySelectorAll('.sr-only, .info-btn, [hidden]')) x.remove();
    return (c.textContent ?? '').trim();
  });

/** True when the element is wholly inside the window. */
const inView = (page: Page, sel: string) =>
  page.$eval(sel, (n) => {
    const r = n.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  });
const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
/** Takes the screenshot without a toast left from the set-up (Choose a model says which one was chosen). */
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, name) });
}

/** Asks a typed question from the home and waits for the whole answer in the Playful card. */
async function askTyped(page: Page, question: string, done = /Forge word/) {
  await page.click('#btn-type');
  await page.waitForSelector('[data-screen=type]');
  await page.fill('#question', question);
  await page.click('#sendBtn');
  await page.waitForSelector('[data-screen=answer][data-mode=playful]');
  await expect.poll(() => page.textContent('#answerText'), { timeout: 15_000 }).toMatch(done);
  await page.waitForSelector('#shareBtn', { timeout: 15_000 });
}

describe('Playful mode', () => {
  it('is chosen in Mode and look, stays after a reload, and switching back to Default is as easy', async () => {
    const { ctx, page, errors, asked } = await phone({ funded: false, playful: false });
    // Default loads none of Playful's screens, styles or fonts.
    expect(asked.filter((p) => /playful\/(home|answer)|playful\.css|vendor\/(baloo|nunito)/.test(p))).toEqual([]);
    expect(await page.getAttribute('[data-screen=home]', 'data-mode')).toBeNull();
    await choose(page, 'playful');
    expect(await page.textContent('#mode-playful')).toContain('On now.');
    expect(await page.getAttribute('#mode-default', 'aria-checked')).toBe('false');
    // Done from Mode and look (opened by its address) goes back to the home with More open.
    await page.click('#lookDone');
    await page.waitForSelector('[data-screen=home][data-mode=playful] #moreSheet');
    await page.click('#btn-more');
    await page.waitForSelector('#moreSheet', { state: 'detached' });
    await page.reload();
    await playfulHome(page);
    expect(await page.evaluate(() => localStorage.getItem('forge2.mode'))).toBe('playful');
    // The fonts are vendored: they came from this app's own address.
    expect(asked.filter((p) => /\/v2\/vendor\/(baloo-2|nunito)\/.*\.woff2$/.test(p)).length).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.fonts.check('800 20px "Baloo 2"') && document.fonts.check('700 16px Nunito'))).toBe(true);

    // Back to Default through More, then a reload: still Default, and nothing kept for Playful.
    await page.click('#btn-more');
    await page.click('#moreLook');
    await page.waitForSelector('[data-screen=look]');
    await page.click('#mode-default');
    await expect.poll(() => page.getAttribute('#mode-default', 'aria-checked')).toBe('true');
    expect(await page.textContent('#mode-default')).toContain('Rings and talk. On now.');
    await page.click('#lookDone');
    await page.waitForSelector('[data-screen=home]:not([data-mode])');
    await page.goto(`${g.url}/v2/#/`);
    await page.reload();
    await page.waitForSelector('[data-screen=home]:not([data-mode])');
    expect(await page.evaluate(() => localStorage.getItem('forge2.mode'))).toBeNull();
    expect(await page.textContent('#talkBtn')).toContain('Hold to talk');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('home: Pip, both rings, the bar in its colours, and Type, Add and More open as on Default', async () => {
    const { ctx, page, errors } = await phone();
    await playfulHome(page);
    expect(await page.getAttribute('.pf-helper svg.pip', 'aria-label')).toBe('Pip, a round yellow helper with a small sprout');
    expect(await pipText(page, '#pipSays')).toBe('Hi! What are you wondering about?');
    expect(await page.textContent('#privacyPill')).toContain('Standard');
    expect(await page.locator('.pf-rings .ring-paid').count()).toBe(1);
    expect(await page.locator('.pf-rings .ring-memory').count()).toBe(1);
    // A full balance fills the gold ring; the bands are the design's colours on its track.
    await expect.poll(() => page.$eval('.pf-rings .rings-svg', (s) => Number(s.getAttribute('data-funds')))).toBe(942);
    expect(await page.$eval('.pf-rings .ring-paid', (n) => getComputedStyle(n).stroke)).toBe('rgb(255, 210, 63)');
    expect(await page.$eval('.pf-rings .ring-memory', (n) => getComputedStyle(n).stroke)).toBe('rgb(61, 220, 151)');
    expect(await page.$eval('.pf-rings .ring-track-gold', (n) => getComputedStyle(n).stroke)).toBe('rgb(58, 48, 166)');
    expect(await bg(page, 'main.pf')).toBe('rgb(75, 63, 201)');
    expect(await page.getAttribute('meta[name="theme-color"]', 'content')).toBe('#4B3FC9');
    expect(await bg(page, '#btn-type')).toBe('rgb(255, 210, 63)');
    expect(await bg(page, '#btn-add')).toBe('rgb(61, 220, 151)');
    expect(await bg(page, '#btn-more')).toBe('rgb(255, 138, 122)');
    expect(await bg(page, '#talkBtn')).toBe('rgb(255, 255, 255)');
    expect(await page.$eval('.pf-bubble', (n) => getComputedStyle(n).fontFamily)).toMatch(/^"Baloo 2"/);
    // Every control has a name and is at least 48 px each way.
    const small = await page.$$eval('main button', (bs) =>
      bs
        .filter((b) => (b as HTMLElement).offsetParent && !b.classList.contains('ring-hit'))
        .filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width < 48 || r.height < 48 || !((b as HTMLElement).innerText.trim() || b.getAttribute('aria-label'));
        })
        .map((b) => b.id || b.className),
    );
    expect(small).toEqual([]);

    // The star opens Funds and memory, as the money chip does.
    await page.click('#starChip');
    await page.waitForSelector('[data-screen=funds]');
    await page.goBack();
    await playfulHome(page);
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await page.goBack();
    await playfulHome(page);
    await page.click('#btn-add');
    await page.waitForSelector('#addSheet');
    expect(await page.textContent('#btn-add')).toContain('Close');
    await page.click('#btn-add');
    await page.waitForSelector('#addSheet', { state: 'detached' });
    await page.click('#btn-more');
    await page.waitForSelector('#moreSheet');
    expect(await page.isVisible('#moreLook')).toBe(true);
    await page.click('#btn-more');
    await playfulHome(page);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('with no money, Pip says so and leads to Add money or Start free; a held question is stopped the same way', async () => {
    const { ctx, page, errors } = await phone({ funded: false });
    await playfulHome(page);
    expect(await page.textContent('#starWords')).toMatch(/None left|Start free/);
    const go = await page.getAttribute('#pipGo', 'data-go');
    expect(['addFunds', 'startFree']).toContain(go);
    await page.click('#pipGo');
    await page.waitForSelector(go === 'addFunds' ? '[data-screen=addFunds]' : '[data-screen=startFree]');
    await page.goBack();
    await playfulHome(page);
    // Holding the talk button with nothing to pay with: the app's blocker, its words passed on to the next screen.
    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForSelector('[data-screen=addFunds], [data-screen=startFree], [data-screen=freeOut]');
    await expect.poll(() => page.$eval('#toast', (n) => n.classList.contains('show')).catch(() => false)).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a typed question streams into the card; Again reads it, Share copies or asks again, and Burn is held', async () => {
    const { ctx, page, errors, asked } = await phone();
    // Read aloud by the engine's voice (a phone voice is silent in a test browser).
    await page.goto(`${g.url}/v2/#/more/voice`);
    await page.waitForSelector('[data-screen=voice]');
    await page.click('#voiceOut-engine');
    await page.goto(`${g.url}/v2/#/`);
    await playfulHome(page);
    await askTyped(page, 'Why is the sky dark at night?');
    expect(await page.textContent('#pfAsked')).toBe('Why is the sky dark at night?');
    expect((await page.textContent('#answerLead'))!.trim()).toMatch(/^Forge( word)+$/);
    expect(await pipText(page, '#pipLine')).toBe('Pip found an answer');
    expect(await page.$eval('#answerLead', (n) => getComputedStyle(n).fontFamily)).toMatch(/^"Baloo 2"/);
    expect(await page.textContent('#pipCareful')).toBe('Pip can get things wrong. Check big things with a grown-up you trust.');

    // Again: the answer read aloud, and Pip says so in green.
    const speech = asked.filter((p) => p.endsWith('/v1/audio/speech')).length;
    await page.click('#speakBtn');
    await expect.poll(() => pipText(page, '#pipLine'), { timeout: 8000 }).toMatch(/^Pip is (reading it to you|getting the voice ready)$/);
    await expect.poll(() => page.getAttribute('#pipLine', 'data-reading'), { timeout: 8000 }).toBe('true');
    expect(await page.$eval('#pipLine', (n) => getComputedStyle(n).color)).toBe('rgb(46, 125, 91)');
    expect(asked.filter((p) => p.endsWith('/v1/audio/speech')).length).toBeGreaterThan(speech);
    if (await page.isVisible('#speakStopBtn')) await page.click('#speakStopBtn');

    // Share: Copy and Ask again (with its price) behind it. Copy says so in Pip's line, not a toast.
    await page.click('#shareBtn');
    expect(await page.getAttribute('#shareBtn', 'aria-expanded')).toBe('true');
    expect(await page.isVisible('#shareTray')).toBe(true);
    expect(await page.textContent('#againBtn')).toMatch(/Ask again(Under|Up to) \$\d+\.\d\d/);
    await page.click('#copyBtn');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/^Forge( word)+$/);
    await expect.poll(() => pipText(page, '#pipLine')).toBe('Copied');
    expect(await page.$eval('#toast', (n) => n.classList.contains('show') && /Copied/.test(n.textContent ?? '')).catch(() => false)).toBe(false);

    // Burn: a tap (a finger's, real touch input) only says to hold it; held, the conversation burns and
    // Pip says so on the home.
    await page.tap('#burnBtn');
    await expect.poll(() => pipText(page, '#pipLine')).toMatch(/^Hold to burn/);
    expect(await page.isVisible('[data-screen=answer]')).toBe(true);
    const b = (await page.locator('#burnBtn').boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForSelector('[data-screen=home][data-mode=playful]', { timeout: 10_000 });
    await page.mouse.up();
    await expect.poll(() => pipText(page, '#pipSays')).toMatch(/^Burned/);
    await page.goto(`${g.url}/v2/#/answer`);
    await page.waitForSelector('[data-screen=answer][data-mode=playful]');
    expect(await pipText(page, '#pipLine')).toBe('No answer yet. Hold the button and ask Pip.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a long press selects none of Pip’s screens, only the answer and the question asked', async () => {
    const { ctx, page, errors } = await phone();
    await playfulHome(page);
    const check = async (where: string) => {
      const s = await selection(page);
      expect(s.selectable, `${where}: interface that can be selected`).toEqual([]);
      expect(s.unselectable, `${where}: content that cannot be selected`).toEqual([]);
      expect(s.chrome, `${where}: interface parts looked at`).toBeGreaterThan(2);
      return s;
    };
    await check('home');
    await page.click('#btn-add');
    await page.waitForSelector('.float-card');
    await check('home with Add open');
    await page.click('#btn-add');
    await page.waitForSelector('.float-card', { state: 'detached' });
    await askTyped(page, 'Why is the sky blue?');
    expect((await check('answer')).content).toBeGreaterThan(1);
    expect(await wordAt(page, '#answerText')).not.toBe('');
    expect(await wordAt(page, '#shareBtn')).toBe('');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('Hold to talk records with Pip listening, and sliding off cancels with Pip saying so', async () => {
    const { ctx, page, errors, asked } = await phone();
    await playfulHome(page);
    const box = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    expect(await page.textContent('#talkBtn')).toContain('Let go to send');
    expect(await page.getAttribute('.pf-helper svg.pip', 'data-mood')).toBe('listening');
    // The recording's line (time, where the sound goes, the price) is in Pip's bubble.
    await expect.poll(() => page.textContent('#pipBubble #talkTime'), { timeout: 4000 }).toMatch(/^0:01\. Slide off to cancel\.$/);
    expect(await page.textContent('#pipBubble #talkPrice')).toMatch(/^(Under|Up to) \$\d+\.\d\d$/);
    await page.mouse.move(box.x + box.width / 2, box.y - 140, { steps: 4 });
    await expect.poll(() => page.textContent('#talkBtn')).toContain('Let go to cancel');
    await page.mouse.up();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('idle');
    await expect.poll(() => pipText(page, '#pipSays')).toBe('Cancelled.');
    expect(await page.getAttribute('.pf-helper svg.pip', 'data-mood')).toBe('oops');
    expect(await page.isVisible('[data-screen=home]')).toBe(true);
    expect(asked.filter((p) => p.endsWith('/v1/audio/transcriptions'))).toEqual([]);

    // Held and let go on the button: sent, heard and answered on the Playful answer.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect.poll(() => page.getAttribute('#talkBtn', 'data-phase')).toBe('recording');
    await page.waitForTimeout(1200);
    await page.mouse.up();
    await page.waitForSelector('[data-screen=answer][data-mode=playful]');
    await expect.poll(() => page.textContent('#pfAsked'), { timeout: 10_000 }).toBe('What should I bring on Saturday?');
    await expect.poll(() => page.textContent('#answerText'), { timeout: 15_000 }).toMatch(/Forge word/);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a failed answer and a blocked microphone: Pip looks worried and says what to do', async () => {
    const { ctx, page, errors } = await phone({ model: 'mock-fail' });
    // The model fails: the error in the card with its one next step, Try again, and its price.
    errors.length = 0;
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'Why is the sky dark at night?');
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer][data-mode=playful]');
    await page.waitForSelector('#answerError:not([hidden])', { timeout: 15_000 });
    expect(await page.textContent('#nextStep')).toBe('Try again');
    expect(await page.textContent('#retryPrice')).toMatch(/(Under|Up to) \$\d+\.\d\d/);
    expect(await pipText(page, '#pipLine')).toBe('Oops. Pip got stuck.');
    expect(await page.getAttribute('.pf-card-head svg.pip', 'data-mood')).toBe('oops');
    expect(await page.locator('#againBtn').count()).toBe(0);
    // The engine answered 500 for the failing mock model: that is the error shown, not a fault of the page.
    expect(errors.filter((e) => !/status of 50\d/.test(e))).toEqual([]);
    await ctx.close();

    // A microphone the phone refuses: Pip says so on the home, and nothing is recorded.
    const p2 = await phone();
    await p2.page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('blocked', 'NotAllowedError'));
    });
    const box = (await p2.page.locator('#talkBtn').boundingBox())!;
    await p2.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await p2.page.mouse.down();
    await expect.poll(() => pipText(p2.page, '#pipSays'), { timeout: 5000 }).toBe('Microphone blocked.');
    await p2.page.mouse.up();
    expect(await p2.page.getAttribute('.pf-helper svg.pip', 'data-mood')).toBe('oops');
    expect(p2.errors).toEqual([]);
    await p2.ctx.close();
  }, 90_000);

  for (const size of [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    it(`fits ${size.width} by ${size.height}: the talk button, the bar and the card in view, nothing scrolls sideways`, async () => {
      const { ctx, page, errors } = await phone({ viewport: size, model: 'mock-think' });
      await playfulHome(page);
      for (const sel of ['#talkBtn', '.bottom-row', '#pipBubble', '#starChip', '#privacyPill']) expect(await inView(page, sel), sel).toBe(true);
      expect(await noSideScroll(page)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      await shot(page, `home-${size.width}x${size.height}.png`);
      await askTyped(page, 'Why is the sky dark at night?', /console\.log/);
      await shot(page, `answer-${size.width}x${size.height}.png`);
      for (const sel of ['#replyBtn', '.bottom-row', '.pf-card', '#burnBtn', '#pipCareful']) expect(await inView(page, sel), sel).toBe(true);
      expect(await noSideScroll(page)).toBe(true);
      expect(errors).toEqual([]);
      await ctx.close();
    }, 60_000);
  }

  it('fits 360 by 640 with Pip leading to Add money, the talk button and the bar still in view', async () => {
    const { ctx, page, errors } = await phone({ viewport: { width: 360, height: 640 }, funded: false });
    await playfulHome(page);
    await page.waitForSelector('#pipGo');
    for (const sel of ['#talkBtn', '.bottom-row', '#pipGo']) expect(await inView(page, sel), sel).toBe(true);
    expect(await noSideScroll(page)).toBe(true);
    await shot(page, 'home-empty-360x640.png');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
