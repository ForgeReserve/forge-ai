import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The first run (slice A6) in a phone-sized Chrome on a clean profile: Welcome, How you pay, What it can
// and cannot hide, Private only, then the home. Shown once, skippable, and under More. Also the empty
// states (home, Funds, History) and the price shown before Ask again.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;
let invite: string;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'true' } });
  invite = createInvite(g);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

/**
 * A phone. `seen`: the first run was already seen. `voices`: replaces the phone's speech voices with
 * stand-ins that keep what they are asked to read (an empty list: a phone with no voice of its own).
 */
async function phone({ seen = false, voices = undefined as undefined | boolean, viewport = PHONE.viewport } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; requests: string[] }> {
  const ctx = await browser.newContext({ ...PHONE, viewport });
  if (seen) await pastFirstRun(ctx);
  if (voices !== undefined)
    await ctx.addInitScript((has: boolean) => {
      const w = window as any;
      w.__spoken = [];
      class Utterance {
        text: string;
        voice: unknown = null;
        lang = '';
        onend: null | (() => void) = null;
        onerror: null | ((e: unknown) => void) = null;
        constructor(text: string) {
          this.text = text;
        }
      }
      let timer: any = null;
      let queue: Utterance[] = [];
      const next = () => {
        if (timer) return;
        const u = queue.shift();
        if (!u) return;
        w.__spoken.push(u.text);
        timer = setTimeout(() => {
          timer = null;
          u.onend?.();
          next();
        }, 250);
      };
      w.SpeechSynthesisUtterance = Utterance;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          getVoices: () => (has ? [{ name: 'Phone voice', lang: 'en-US', localService: true }] : []),
          speak: (u: Utterance) => {
            queue.push(u);
            next();
          },
          cancel: () => {
            clearTimeout(timer);
            timer = null;
            for (const u of queue) u.onend?.();
            queue = [];
          },
        },
      });
    }, !!voices);
  const page = await ctx.newPage();
  const errors: string[] = [];
  const requests: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  return { ctx, page, errors, requests };
}

const step = (page: Page) => page.getAttribute('[data-screen=intro]', 'data-step');
const atStep = (page: Page, s: string) => page.waitForSelector(`[data-screen=intro][data-step=${s}]`);

/** A balance key funded with $2.00 through the API. */
async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 200);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

describe('first run in a phone-sized browser', () => {
  it('walks Welcome, How you pay, the limits and Private only on a clean profile, then never shows again', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/`);
    await atStep(page, 'welcome');
    expect(await page.evaluate(() => location.hash)).toBe('#/start');
    expect(await page.textContent('h1')).toBe("AI that doesn't know who you are.");
    // One idea a step: icons first, a short heading, one sentence. The detail is under Learn more.
    expect(await page.locator('#welcomeIcons .way').allTextContents()).toEqual(['No account', 'Like cash', 'Sealed', 'On this phone']);
    expect(await page.textContent('#introLead')).toBe('No account, no name, and you pay like cash.');
    expect(await page.isVisible('.intro-item')).toBe(false);
    await page.click('#learnMore summary');
    expect(await page.locator('.intro-item b').allTextContents()).toEqual(['No account', 'Paid like cash', 'Read only in sealed hardware', 'Kept on this phone']);
    expect(await page.textContent('#introStep')).toBe('Step 1 of 4');
    expect(await page.isVisible('#introBack')).toBe(false);
    expect(await page.isVisible('#introSkip')).toBe(true);
    // This engine needs an invite code to open a balance: Welcome asks for it.
    await page.waitForSelector('#introInviteField:not([hidden])');
    await page.fill('#introInvite', invite);

    await page.click('#introNext');
    await atStep(page, 'pay');
    expect(await page.textContent('h1')).toBe('How you pay');
    expect(await page.textContent('#introStep')).toBe('Step 2 of 4');
    // Shown by icon, and only the ways that work here: no free questions or cards before their slices.
    await page.waitForSelector('[data-way]');
    const ways = await page.locator('[data-way]').evaluateAll((n) => n.map((x) => x.getAttribute('data-way')));
    expect(ways[0]).toBe('note');
    expect(ways).not.toContain('free');
    expect(ways).not.toContain('card');
    expect(await page.locator('[data-way=note] svg').count()).toBe(1);
    expect(await page.textContent('[data-way=note]')).toBe('Paper note');
    expect(await page.textContent('#introLead')).toBe('Each question costs a little, and you see the price first.');
    // Funds are like cash: said under Learn more, never dropped.
    expect(await page.isVisible('#payCash')).toBe(false);
    await page.click('#learnMore summary');
    expect(await page.textContent('#payCash')).toBe('Funds work like cash in a pocket. If this phone is lost or erased, the balance on it is lost. Keep small amounts.');

    // Back goes to the step before, and what was typed there is still there.
    await page.click('#introBack');
    await atStep(page, 'welcome');
    expect(await page.inputValue('#introInvite')).toBe(invite);
    await page.click('#introNext');
    await atStep(page, 'pay');

    await page.click('#introNext');
    await atStep(page, 'limits');
    expect(await page.textContent('h1')).toBe('What it can and cannot hide');
    expect(await page.textContent('#introLead')).toBe('It hides your typed questions, not your network address.');
    expect(await page.isVisible('#limitsCannot')).toBe(false);
    await page.click('#learnMore summary');
    expect(await page.locator('#limitsCan .intro-item').count()).toBe(3);
    expect(await page.locator('#limitsCannot .intro-item b').allTextContents()).toEqual([
      'Your network address',
      'Your voice',
      'Where your money came from',
      'What you type',
      'A phone that is already watched',
      'Being forced to unlock',
      'Wrong answers',
    ]);
    expect(await page.textContent('#limitsCannot')).toContain('Only Tor or a relay hides it.');
    expect(await page.textContent('#introStep')).toBe('Step 3 of 4');

    await page.click('#introNext');
    await atStep(page, 'private');
    // Private only is on by default, and the step says what that does and does not cover.
    expect(await page.textContent('#privateState')).toBe('On');
    expect(await page.textContent('#introLead')).toBe('Only models in sealed hardware, so Forge cannot read your typed questions.');
    expect(await page.isVisible('#privateSub')).toBe(false);
    await page.click('#learnMore summary');
    expect(await page.textContent('#privateMore')).toContain('Forge and the model provider cannot read them.');
    expect(await page.textContent('#privateVoice')).toContain('The engine could hear or read them.');
    expect(await page.isVisible('#privateHidden')).toBe(true);
    expect(await page.isVisible('#privateTurnOn')).toBe(false);
    expect(await page.textContent('#introNext')).toBe('Start');
    expect(await page.textContent('#introStep')).toBe('Step 4 of 4');

    await page.click('#introNext');
    await page.waitForSelector('[data-screen=home]');
    expect(await page.evaluate(() => location.hash)).toBe('#/');
    // The phone's back button does not walk through the guide again: the home is the first entry.
    expect(await page.evaluate(() => history.state?.forge2 ?? 0)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('forge2.firstRun'))).toBe('done');

    // The invite code typed on Welcome is the one Add funds uses.
    await page.goto(`${g.url}/v2/#/funds/add/ecash`);
    await page.waitForSelector('[data-fund=ecash]');
    expect(await page.inputValue('#invite')).toBe(invite);

    // It does not show again, however the app is opened.
    for (const url of [`${g.url}/v2/`, `${g.url}/v2/#/`]) {
      await page.goto(url);
      await page.reload();
      await page.waitForSelector('[data-screen=home]');
      expect(await page.isVisible('[data-screen=intro]')).toBe(false);
    }

    // It is always under More, and Skip there goes back to the home.
    await page.click('#btn-more');
    expect(await page.textContent('#moreIntro')).toContain('How Forge works');
    await page.click('#moreIntro');
    await atStep(page, 'welcome');
    await page.click('#introNext');
    await atStep(page, 'pay');
    await page.click('#introSkip');
    await page.waitForSelector('[data-screen=home]');
    expect(await page.isVisible('#moreSheet')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('can be skipped from the first step, and an address that names a screen opens that screen', async () => {
    const { ctx, page, errors } = await phone();
    // Opened on a screen, not the home: that screen, with no guide in the way.
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    await page.goto(`${g.url}/v2/#/photo/missed`);
    await page.reload();
    await page.waitForSelector('[data-screen=photo]');

    // Opened plainly: the guide, until it is skipped.
    const p2 = await ctx.newPage();
    p2.on('pageerror', (e) => errors.push(e.message));
    await p2.goto(`${g.url}/v2/`);
    await atStep(p2, 'welcome');
    await p2.click('#introSkip');
    await p2.waitForSelector('[data-screen=home]');
    await p2.reload();
    await p2.waitForSelector('[data-screen=home]');
    expect(await p2.isVisible('[data-screen=intro]')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('Private only off: the step says so plainly and turns it back on', async () => {
    const { ctx, page } = await phone({ seen: true });
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('false');
    await page.goto(`${g.url}/v2/#/start/private`);
    await atStep(page, 'private');
    expect(await page.textContent('#privateState')).toBe('Off');
    expect(await page.textContent('#privateSub')).toBe('Standard models are shown too. The engine and the model provider can read questions to them.');
    expect(await page.isVisible('#privateHidden')).toBe(false);
    await page.click('#privateTurnOn');
    await expect.poll(() => page.textContent('#privateState')).toBe('On');
    expect(await page.isVisible('#privateTurnOn')).toBe(false);
    await page.waitForTimeout(300); // the setting is written to IndexedDB
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.reload();
    await page.waitForSelector('[data-screen=model]');
    expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('true');
    await ctx.close();
  }, 60_000);

  it("Listen reads the step aloud with the phone's own voice, and is not offered without one", async () => {
    const { ctx, page, errors, requests } = await phone({ voices: true });
    await page.goto(`${g.url}/v2/`);
    await atStep(page, 'welcome');
    await page.waitForSelector('#introListen:not([hidden])');
    expect(await page.textContent('#introListen')).toBe('Listen');
    await page.click('#introListen');
    await expect.poll(() => page.textContent('#introListen')).toBe('Stop');
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.length), { timeout: 10_000 }).toBe(2);
    // It reads the step's heading and its one sentence.
    expect(await page.evaluate(() => (window as any).__spoken)).toEqual(["AI that doesn't know who you are.", 'No account, no name, and you pay like cash.']);
    await expect.poll(() => page.textContent('#introListen'), { timeout: 10_000 }).toBe('Listen');
    // Stop stops it.
    await page.click('#introNext');
    await atStep(page, 'pay');
    await page.click('#introListen');
    await expect.poll(() => page.textContent('#introListen')).toBe('Stop');
    await page.click('#introListen');
    await expect.poll(() => page.textContent('#introListen')).toBe('Listen');
    const before = await page.evaluate(() => (window as any).__spoken.length);
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).__spoken.length)).toBe(before);
    // Read on the phone: nothing was sent to the engine's voice.
    expect(requests.filter((r) => r.startsWith('/v1/audio'))).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();

    const none = await phone({ voices: false });
    await none.page.goto(`${g.url}/v2/`);
    await atStep(none.page, 'welcome');
    await none.page.waitForTimeout(500);
    expect(await none.page.isVisible('#introListen')).toBe(false);
    await none.ctx.close();
  }, 60_000);

  it('fits 360 px with no sideways scrolling and 44 px touch targets on every step', async () => {
    const { ctx, page } = await phone({ seen: true, viewport: { width: 360, height: 740 } });
    for (const route of ['start', 'start/pay', 'start/limits', 'start/private']) {
      await page.goto(`${g.url}/v2/#/${route}`);
      await page.waitForSelector('[data-screen=intro]');
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(360);
      const small = await page.locator('main button:visible, main input:visible').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 44 || r.height < 44)).length);
      expect(small, `touch targets on ${route}`).toBe(0);
    }
    await ctx.close();
  }, 60_000);

  it('comes back after Erase everything, which leaves a clean profile', async () => {
    const { ctx, page } = await phone();
    await page.goto(`${g.url}/v2/`);
    await atStep(page, 'welcome');
    await page.click('#introSkip');
    await page.waitForSelector('[data-screen=home]');
    await page.goto(`${g.url}/v2/#/more/erase`);
    await page.waitForSelector('[data-screen=erase]');
    await page.focus('#eraseHold');
    await page.keyboard.down(' ');
    await page.waitForTimeout(2_300);
    await page.keyboard.up(' ');
    await page.waitForSelector('[data-screen=erased]');
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    await page.click('#erasedAgain');
    await atStep(page, 'welcome');
    await ctx.close();
  }, 60_000);
});

/** The amount on a price line or tile, without its label: "Up to $0.27". */
function amount(text: string | null, label: string): string {
  expect(text?.startsWith(label), `${text} starts with ${label}`).toBe(true);
  return String(text).slice(label.length);
}

describe('empty states and the price before sending', () => {
  it('home, Funds and History say what to do when there is nothing yet', async () => {
    const { ctx, page, errors } = await phone({ seen: true });
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    // Home with no funds: scan a note, or every other way in.
    await page.waitForSelector('#otherWays:not([hidden])');
    expect(await page.textContent('#otherWays')).toBe('Other ways to add funds');
    expect(await page.isVisible('#scanNote')).toBe(true);
    await page.click('#otherWays');
    await page.waitForSelector('[data-screen=addFunds]');

    // Funds with no funds: what is free, each way by its icon, and no dead Take out button.
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    expect(await page.textContent('#fundsEmptySub')).toBe('Questions need funds. Share unseen, History and Erase are free.');
    await page.waitForSelector('#fundsWays:not([hidden])');
    expect(await page.isVisible('#way-ecash')).toBe(true);
    expect(await page.isVisible('#way-note')).toBe(false); // Scan a note has its own button above
    expect(await page.isVisible('#fundsScanNote')).toBe(true);
    expect(await page.isVisible('#takeOutBtn')).toBe(false);
    await page.click('#way-ecash');
    await page.waitForSelector('[data-fund=ecash]');

    // History with nothing in it: what will be kept here, and a way to ask.
    await page.goto(`${g.url}/v2/#/more/history`);
    await page.waitForSelector('#historyEmpty');
    expect(await page.textContent('#historyEmpty')).toContain('Nothing here yet');
    expect(await page.textContent('#historyEmpty')).toContain('No conversations yet. Questions you ask are kept here.');
    await page.click('#historyAsk');
    await page.waitForSelector('[data-screen=home]');

    // Reached from home, More, History: Ask a question goes back to that home, so the phone's Back
    // does not return to the empty History.
    await page.click('#btn-more');
    await page.click('#moreHistory');
    await page.waitForSelector('#historyEmpty');
    await page.click('#historyAsk');
    await page.waitForSelector('[data-screen=home]');
    expect(await page.evaluate(() => (history.state as any)?.forge2 ?? 0)).toBe(0);

    // With funds, the empty states are gone.
    const key = await fundedKey();
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).toBe('$2.00');
    expect(await page.isVisible('#otherWays')).toBe(false);
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.isVisible('#takeOutBtn')).toBe(true);
    expect(await page.isVisible('#fundsWays')).toBe(false);
    expect(await page.isVisible('#fundsEmptySub')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('shows the price on Ask again and on Try again before the tap', async () => {
    const { ctx, page } = await phone({ seen: true });
    const key = await fundedKey();
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.reload();
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    await page.click('[data-model="mock-echo"]');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'What should I bring on Saturday?');
    expect(await page.textContent('#priceLine')).toMatch(/^Price(Under|Up to) \$\d+\.\d\d$/);
    // Ask again sends the same conversation the question did, so it shows the same price.
    const asked = amount(await page.textContent('#priceLine'), 'Price');
    await page.click('#sendBtn');
    await page.waitForSelector('#againBtn', { timeout: 20_000 });
    expect(await page.textContent('#againBtn')).toMatch(/^Ask again(Under|Up to) \$\d+\.\d\d$/);
    expect(amount(await page.textContent('#againBtn'), 'Ask again')).toBe(asked);

    // A failed answer: Try again is a paid question too, priced before the tap.
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    await page.click('[data-model="mock-fail"]');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'Will this work?');
    // Try again sends the conversation up to this question, without the failed reply: the same price.
    const failing = amount(await page.textContent('#priceLine'), 'Price');
    await page.click('#sendBtn');
    await page.waitForSelector('#answerError:not([hidden])', { timeout: 20_000 });
    expect(await page.textContent('#nextStep')).toBe('Try again');
    expect(await page.textContent('#retryPrice')).toMatch(/^Price(Under|Up to) \$\d+\.\d\d$/);
    expect(amount(await page.textContent('#retryPrice'), 'Price')).toBe(failing);
    await ctx.close();
  }, 60_000);
});
