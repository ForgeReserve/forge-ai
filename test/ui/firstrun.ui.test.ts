import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The first run (slice A6, the design approved 2026-11-14: C-Welcome, C-Pay, C-Limits, C-Private) in a
// phone-sized Chrome on a clean profile: Welcome, How you pay, What it hides, Private only, then the
// home. Shown once, skippable, and under More. Also the empty states (home, Funds, History) and the
// price shown before Ask again.
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

const SIZES = [
  { width: 360, height: 640 },
  { width: 412, height: 915 },
];
const SHOTS = join(import.meta.dirname, '../../.tmp/firstrun-c');

/** Opens a sheet by its link, and waits until it is open. */
async function openSheet(page: Page, link: string, sheet: string): Promise<void> {
  await page.click(link);
  await page.waitForSelector(`dialog#${sheet}[open]`);
}

describe('first run in a phone-sized browser', () => {
  it('walks Welcome, How you pay, What it hides and Private only on a clean profile, then never shows again', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/`);
    await atStep(page, 'welcome');
    expect(await page.evaluate(() => location.hash)).toBe('#/start');
    // Dark on the first paint, before the app has drawn anything, and on the first run itself.
    expect(await page.evaluate(() => document.documentElement.classList.contains('fr-boot'))).toBe(true);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('main')!).backgroundColor)).toBe('rgb(11, 13, 16)');
    expect(await page.getAttribute('meta[name="theme-color"]', 'content')).toBe('#0B0D10');
    expect(await page.textContent('h1')).toBe("AI that doesn't know who you are.");
    expect(await page.textContent('#introLead')).toBe('No account. No name. You pay like cash.');
    expect(await page.getAttribute('.fr-hero svg', 'aria-label')).toBe('A hooded person with no face, inside two rings. One quarter of each ring is lit.');
    // The step dots between Listen and Skip, a quarter of the rings lit; no Back button (the phone's Back is the way back).
    expect(await page.getAttribute('#introStep', 'aria-label')).toBe('Step 1 of 4');
    expect(await page.locator('#introStep span.now').count()).toBe(1);
    expect(await page.getAttribute('.fr-hero .fr-arc >> nth=1', 'stroke-dasharray')).toBe('185.4 741.4');
    expect(await page.isVisible('#introSkip')).toBe(true);
    expect(await page.locator('main button', { hasText: /^Back$/ }).count()).toBe(0);
    expect(await page.getAttribute('#introNext', 'aria-label')).toBe('Next');

    // This engine needs an invite code to open a balance: "I have an invite code" opens the field.
    await page.waitForSelector('#introInviteLink:not([hidden])');
    expect(await page.textContent('#introInviteLink')).toBe('I have an invite code');
    expect(await page.locator('#introInviteLink svg').count()).toBe(1);
    expect(await page.isVisible('#introInvite')).toBe(false);
    await openSheet(page, '#introInviteLink', 'inviteSheet');
    expect(await page.textContent('#inviteSheetTitle')).toBe('Invite code');
    await page.fill('#introInvite', invite);
    await page.click('#introInviteDone');
    await page.waitForSelector('dialog#inviteSheet:not([open])', { state: 'attached' });

    await page.click('#introNext');
    await atStep(page, 'pay');
    expect(await page.textContent('h1')).toBe('Pay a little, per question.');
    expect(await page.textContent('#introLead')).toBe('You see the price before you send.');
    expect(await page.getAttribute('#introStep', 'aria-label')).toBe('Step 2 of 4');
    expect(await page.getAttribute('.fr-hero .fr-arc >> nth=1', 'stroke-dasharray')).toBe('370.7 741.4');
    expect(await page.textContent('#learnMoreLink')).toBe('Learn more');
    // Learn more: the ways to pay by icon, only those that work here (no free questions or cards on
    // this engine and website), the two rings, and funds work like cash.
    expect(await page.isVisible('#payCash')).toBe(false);
    await openSheet(page, '#learnMoreLink', 'learnSheet');
    expect(await page.textContent('#learnSheetTitle')).toBe('How you pay');
    await page.waitForSelector('[data-way]');
    const ways = await page.locator('[data-way]').evaluateAll((n) => n.map((x) => x.getAttribute('data-way')));
    expect(ways[0]).toBe('note');
    expect(ways).not.toContain('free');
    expect(ways).not.toContain('card');
    expect(await page.locator('[data-way=note] svg').count()).toBe(1);
    expect(await page.textContent('[data-way=note]')).toBe('Paper note');
    expect(await page.textContent('#payCash')).toBe('Funds work like cash in a pocket. If this phone is lost or erased, the balance on it is lost. Keep small amounts.');
    await page.click('#learnSheetClose');
    await page.waitForSelector('dialog#learnSheet:not([open])', { state: 'attached' });

    // The phone's Back goes to the step before, and the code typed there is still there.
    await page.goBack();
    await atStep(page, 'welcome');
    await openSheet(page, '#introInviteLink', 'inviteSheet');
    expect(await page.inputValue('#introInvite')).toBe(invite);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog#inviteSheet:not([open])', { state: 'attached' });
    await page.click('#introNext');
    await atStep(page, 'pay');

    await page.click('#introNext');
    await atStep(page, 'limits');
    expect(await page.textContent('h1')).toBe('Know what it hides.');
    expect(await page.textContent('#introLead')).toBe('Only the AI can read what you type. Your connection shows, unless you use Tor.');
    expect(await page.getAttribute('#introStep', 'aria-label')).toBe('Step 3 of 4');
    expect(await page.getAttribute('.fr-hero .fr-arc >> nth=1', 'stroke-dasharray')).toBe('556.1 741.4');
    // See the full list: everything Forge hides and cannot hide.
    expect(await page.textContent('#fullListLink')).toBe('See the full list');
    expect(await page.isVisible('#limitsCannot')).toBe(false);
    await openSheet(page, '#fullListLink', 'learnSheet');
    expect(await page.textContent('#learnSheetTitle')).toBe('What it can and cannot hide');
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
    // A tap outside the sheet closes it.
    await page.mouse.click(200, 30);
    await page.waitForSelector('dialog#learnSheet:not([open])', { state: 'attached' });

    await page.click('#introNext');
    await atStep(page, 'private');
    // Private only is on by default, and the step says what that does and does not cover.
    expect(await page.textContent('h1')).toBe('Private by default.');
    expect(await page.getAttribute('#privateToggle', 'role')).toBe('switch');
    expect(await page.getAttribute('#privateToggle', 'aria-checked')).toBe('true');
    expect(await page.textContent('#privateState')).toBe('On');
    expect(await page.textContent('#introLead')).toBe('Only private models. Forge cannot read what you type.');
    expect(await page.getAttribute('.fr-hero svg', 'aria-label')).toBe('A closed padlock, inside two fully lit rings.');
    expect(await page.getAttribute('#introStep', 'aria-label')).toBe('Step 4 of 4');
    // No Skip on the last step: Start is the way on, a check mark named Start.
    expect(await page.isVisible('#introSkip')).toBe(false);
    expect(await page.getAttribute('#introNext', 'aria-label')).toBe('Start');
    expect(await page.locator('#introNext svg path').getAttribute('d')).toBe('M5 12.5l4.5 4.5L19 7.5');
    await openSheet(page, '#learnMoreLink', 'learnSheet');
    expect(await page.textContent('#learnSheetTitle')).toBe('Private only');
    expect(await page.textContent('#privateMore')).toContain('Forge and the model provider cannot.');
    expect(await page.textContent('#privateVoice')).toContain('The engine could hear or read them.');
    expect(await page.isVisible('#privateHidden')).toBe(true);
    expect(await page.isVisible('#privateOffSub')).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForSelector('dialog#learnSheet:not([open])', { state: 'attached' });

    await page.click('#introNext');
    await page.waitForSelector('[data-screen=home]');
    expect(await page.evaluate(() => location.hash)).toBe('#/');
    // The phone's back button does not walk through the guide again: the home is the first entry.
    expect(await page.evaluate(() => history.state?.forge2 ?? 0)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('forge2.firstRun'))).toBe('done');
    // The home is in the look again (Light), not the first run's dark.
    expect(await page.getAttribute('meta[name="theme-color"]', 'content')).toBe('#F6F5F1');

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
      expect(await page.evaluate(() => document.documentElement.classList.contains('fr-boot'))).toBe(false);
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

  it('the Private only switch sets the setting, opens the padlock when off, and is dark in every look', async () => {
    const { ctx, page } = await phone({ seen: true });
    // The Dark look: the first run keeps its own dark ground all the same.
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.waitForSelector('[data-screen=look]');
    await page.click('#look-dark');
    await page.goto(`${g.url}/v2/#/start/private`);
    await atStep(page, 'private');
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('main')!).backgroundColor)).toBe('rgb(11, 13, 16)');
    expect(await page.getAttribute('#privateToggle', 'aria-checked')).toBe('true');
    const shackle = () => page.getAttribute('.fr-hero [data-fr=shackle] >> nth=0', 'd');
    expect(await shackle()).toBe('M127 142V116a23 23 0 0 1 46 0v26');

    await page.click('#privateToggle');
    await expect.poll(() => page.getAttribute('#privateToggle', 'aria-checked')).toBe('false');
    expect(await page.textContent('#privateState')).toBe('Off');
    expect(await page.textContent('#introLead')).toBe('Standard models are shown too. They can read what you type.');
    expect(await shackle()).toBe('M173 142V108a23 23 0 0 0-46 0v10');
    expect(await page.getAttribute('.fr-hero svg', 'aria-label')).toBe('An open padlock, inside two fully lit rings.');
    expect(await page.getAttribute('.fr-hero [data-fr=hole]', 'opacity')).toBe('0.85');
    await openSheet(page, '#learnMoreLink', 'learnSheet');
    expect(await page.textContent('#privateOffSub')).toBe('Standard models are shown too. The engine and the model provider can read questions to them.');
    expect(await page.isVisible('#privateHidden')).toBe(false);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300); // the setting is written to IndexedDB

    // The setting itself changed: the Model screen says so, after a reload.
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.reload();
    await page.waitForSelector('[data-screen=model]');
    expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('false');

    // Opened again with it off: the step shows Off, and the switch turns it back on.
    await page.goto(`${g.url}/v2/#/start/private`);
    await atStep(page, 'private');
    expect(await page.textContent('#privateState')).toBe('Off');
    await page.click('#privateToggle');
    await expect.poll(() => page.getAttribute('#privateToggle', 'aria-checked')).toBe('true');
    expect(await page.textContent('#introLead')).toBe('Only private models. Forge cannot read what you type.');
    expect(await shackle()).toBe('M127 142V116a23 23 0 0 1 46 0v26');
    await page.waitForTimeout(300);
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.reload();
    await page.waitForSelector('[data-screen=model]');
    expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('true');
    await ctx.close();
  }, 60_000);

  it('Listen plays the recorded clip of the step, on the phone, and works without a phone voice', async () => {
    // No voice of the phone's own: the recorded clips still read the steps.
    const { ctx, page, errors, requests } = await phone({ voices: false });
    await page.addInitScript(() => {
      const w = window as any;
      w.__played = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        w.__played.push(this.src);
        this.addEventListener('ended', () => w.__played.push('ended'));
        return play.call(this);
      };
    });
    await page.goto(`${g.url}/v2/`);
    await atStep(page, 'welcome');
    await page.waitForSelector('#introListen:not([hidden])');
    expect(await page.textContent('#introListen')).toBe('Listen');
    await page.click('#introListen');
    await expect.poll(() => page.textContent('#introListen')).toBe('Stop');
    expect(requests).toContain('/v2/voice/en/welcome.ogg');
    await expect.poll(() => page.evaluate(() => (window as any).__played.length)).toBeGreaterThan(0);
    // The clip plays to its end (about 5 seconds), then Listen is offered again.
    await expect.poll(() => page.evaluate(() => (window as any).__played.includes('ended')), { timeout: 15_000 }).toBe(true);
    await expect.poll(() => page.textContent('#introListen')).toBe('Listen');
    // Stop stops it.
    await page.click('#introNext');
    await atStep(page, 'pay');
    await page.click('#introListen');
    await expect.poll(() => page.textContent('#introListen')).toBe('Stop');
    expect(requests).toContain('/v2/voice/en/pay.ogg');
    await page.click('#introListen');
    await expect.poll(() => page.textContent('#introListen')).toBe('Listen');
    expect(await page.evaluate(() => [...document.querySelectorAll('audio')].every((a) => a.paused))).toBe(true);
    // Private only reads what the switch is set to: its Off words have their own clip.
    await page.goto(`${g.url}/v2/#/start/private`);
    await atStep(page, 'private');
    await page.click('#privateToggle');
    await expect.poll(() => page.getAttribute('#privateToggle', 'aria-checked')).toBe('false');
    await page.waitForSelector('#introListen:not([hidden])');
    await page.click('#introListen');
    await expect.poll(() => requests.includes('/v2/voice/en/private-off.ogg')).toBe(true);
    await page.click('#introListen');
    await page.click('#privateToggle');
    // Played on the phone: nothing was sent to the engine's voice.
    expect(requests.filter((r) => r.startsWith('/v1/audio'))).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('Listen works offline: the service worker keeps the clips', async () => {
    const { ctx, page, errors } = await phone({ voices: false });
    await page.addInitScript(() => {
      const w = window as any;
      w.__playing = [];
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        this.addEventListener('playing', () => w.__playing.push(this.src));
        return play.call(this);
      };
    });
    await page.goto(`${g.url}/v2/`);
    await atStep(page, 'welcome');
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    // Once more online with the worker in charge, so it keeps the app's files too; then offline.
    await page.reload();
    await atStep(page, 'welcome');
    await ctx.setOffline(true);
    await page.reload();
    await atStep(page, 'welcome');
    await page.waitForSelector('#introListen:not([hidden])');
    await page.click('#introListen');
    await expect.poll(() => page.evaluate(() => (window as any).__playing[0] ?? ''), { timeout: 10_000 }).toMatch(/^blob:/);
    expect(errors.filter((e) => !/Failed to load resource|ERR_INTERNET_DISCONNECTED/.test(e))).toEqual([]);
    await ctx.setOffline(false);
    await ctx.close();
  }, 60_000);

  it("Listen uses the phone's own voice when a clip does not match the words, and is not offered with neither", async () => {
    // A clip recorded from other words (the strings changed since): the phone's voice reads the step.
    const stale = await phone({ voices: true });
    await stale.page.route('**/v2/voice/en/manifest.json', async (route) => {
      const m = await (await route.fetch()).json();
      for (const c of Object.values(m.clips) as any[]) c.text = ['Old words.'];
      await route.fulfill({ json: m });
    });
    await stale.page.goto(`${g.url}/v2/`);
    await atStep(stale.page, 'welcome');
    await stale.page.waitForSelector('#introListen:not([hidden])');
    await stale.page.click('#introListen');
    await expect.poll(() => stale.page.evaluate(() => (window as any).__spoken.length), { timeout: 10_000 }).toBe(2);
    expect(await stale.page.evaluate(() => (window as any).__spoken)).toEqual(["AI that doesn't know who you are.", 'No account. No name. You pay like cash.']);
    expect(stale.requests.filter((r) => r.endsWith('.ogg'))).toEqual([]);
    await stale.ctx.close();

    // No clips and no voice of the phone's own: no Listen.
    const none = await phone({ voices: false });
    await none.page.route('**/v2/voice/en/manifest.json', (route) => route.fulfill({ status: 404, body: '' }));
    await none.page.goto(`${g.url}/v2/`);
    await atStep(none.page, 'welcome');
    await none.page.waitForTimeout(500);
    expect(await none.page.isVisible('#introListen')).toBe(false);
    await none.ctx.close();
  }, 60_000);

  for (const size of SIZES) {
    it(`fits ${size.width} by ${size.height} on every step: no scrolling, 48 px touch targets, the hero and Next in the same place`, async () => {
      const { ctx, page } = await phone({ seen: true, viewport: size });
      let hero = '';
      let next = '';
      for (const route of ['start', 'start/pay', 'start/limits', 'start/private']) {
        await page.goto(`${g.url}/v2/#/${route}`);
        await page.waitForSelector('[data-screen=intro]');
        await page.waitForTimeout(200);
        const m = await page.evaluate(() => {
          const main = document.querySelector('main')!;
          const box = (sel: string) => JSON.stringify(document.querySelector(sel)!.getBoundingClientRect());
          return { scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight, mainScroll: main.scrollHeight - main.clientHeight, hero: box('.fr-hero svg'), next: box('#introNext'), bottom: document.querySelector('.fr-links')!.getBoundingClientRect().bottom };
        });
        expect(m.scrollW, route).toBeLessThanOrEqual(size.width);
        expect(m.scrollH, route).toBeLessThanOrEqual(size.height);
        expect(m.mainScroll, `${route} scrolls`).toBe(0);
        expect(m.bottom, route).toBeLessThanOrEqual(size.height);
        // The same hero, in the same place, on every step; and Next too.
        hero ||= m.hero;
        next ||= m.next;
        expect(m.hero, route).toBe(hero);
        expect(m.next, route).toBe(next);
        const small = await page.locator('main button:visible').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width < 48 || r.height < 48).length);
        expect(small, `touch targets on ${route}`).toBe(0);
      }
      const box = JSON.parse(hero);
      if (size.height >= 844) expect([box.width, box.height]).toEqual([300, 300]);
      await ctx.close();
    }, 60_000);
  }

  it('looks like the design at 412 by 915 (screenshots for the owner, under .tmp/firstrun-c/)', async () => {
    mkdirSync(SHOTS, { recursive: true });
    const { ctx, page } = await phone({ seen: true, viewport: { width: 412, height: 915 } });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [i, step] of ['welcome', 'pay', 'limits', 'private'].entries()) {
      await page.goto(`${g.url}/v2/#/${['start', 'start/pay', 'start/limits', 'start/private'][i]}`);
      await atStep(page, step);
      await page.waitForSelector('#introListen:not([hidden])');
      await page.evaluate(() => document.fonts.ready);
      await page.screenshot({ path: join(SHOTS, `${i + 1}-${step}.png`) });
    }
    await page.click('#privateToggle');
    await expect.poll(() => page.getAttribute('#privateToggle', 'aria-checked')).toBe('false');
    await page.screenshot({ path: join(SHOTS, '4-private-off.png') });
    await page.click('#privateToggle');
    await ctx.close();
  }, 60_000);

  it('fills the rings gently between steps, and not at all with reduced motion', async () => {
    const { ctx, page } = await phone({ seen: true });
    const running = () => page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect)?.target instanceof SVGElement).length);
    await page.goto(`${g.url}/v2/#/start`);
    await atStep(page, 'welcome');
    await page.click('#introNext');
    await atStep(page, 'pay');
    expect(await running()).toBeGreaterThan(0);
    // When it ends, the rings are as the design draws them.
    await expect.poll(running, { timeout: 3_000 }).toBe(0);
    expect(await page.getAttribute('.fr-hero .fr-arc >> nth=1', 'stroke-dasharray')).toBe('370.7 741.4');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.click('#introNext');
    await atStep(page, 'limits');
    expect(await running()).toBe(0);
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
