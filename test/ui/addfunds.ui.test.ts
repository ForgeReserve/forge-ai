import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createInvite, creditMintUp, type Gateway, MINT_A, MINT_CREDIT, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay, wayOrder } from './ways.ts';

// Add money as wallet cards (AddFunds-C1 to C4, chosen 2026-11-15): one picture card per way with one
// word, icon tabs and swipe between them, the one big button, Start free with its one question, the
// $0 Funds and home on a free model. Screenshots for the owner are kept under .tmp/addfunds-c/.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SIZES = [
  { width: 360, height: 640 },
  { width: 412, height: 915 },
];
const SHOTS = join(import.meta.dirname, '../../.tmp/addfunds-c');

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp()) || !(await creditMintUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: {
      FORGE_INVITE_ONLY: 'true',
      FORGE_FOREIGN_ALLOW_INSECURE: 'true',
      FORGE_CREDIT_MINT: MINT_CREDIT,
      FORGE_FAUCET_ENABLED: 'true',
      FORGE_FAUCET_POW_BITS: '10',
      FORGE_FAUCET_POW_MAX_BITS: '12',
      FORGE_FAUCET_PER_ADDRESS: '0',
    },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'glm-5.3-flash', name: 'GLM Flash', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

/** A phone that has seen the first run, with a phone voice for Listen (it records what was read). */
async function phone({ viewport = PHONE.viewport, voice = true } = {}) {
  const ctx = await browser.newContext({ ...PHONE, viewport });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: g.url });
  if (voice)
    await ctx.addInitScript(() => {
      const w = window as any;
      w.__spoken = [];
      class Utterance {
        text: string;
        voice: unknown = null;
        lang = '';
        rate = 1;
        onend: null | (() => void) = null;
        onerror: null | ((e: unknown) => void) = null;
        constructor(text: string) {
          this.text = text;
        }
      }
      w.SpeechSynthesisUtterance = Utterance;
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: {
          getVoices: () => [{ name: 'Phone voice', lang: 'en-US', localService: true }],
          speak: (u: Utterance) => {
            w.__spoken.push(u.text);
            setTimeout(() => u.onend?.(), 100);
          },
          cancel: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
        },
      });
    });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 401: a free model with no key; 402: a paid one at $0; 403: a wrong invite code, on purpose.
  page.on('console', (m) => m.type() === 'error' && !/40[123]/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

async function shot(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(450); // the card's word settles in
  await page.screenshot({ path: join(SHOTS, name) });
}

/** A $0 balance key opened with an invite through the API. */
async function zeroKey(): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`open failed: ${JSON.stringify(b)}`);
  return b.key;
}

/** A balance key funded with $2.00 through the API. */
async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 200);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

/** Opens the app with this balance key stored, on the home. */
async function withKey(page: Page, key: string): Promise<void> {
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await page.reload();
  await page.waitForSelector('[data-screen=home]');
}

/** The card on show: its id from the selected tab. */
const current = (page: Page) => page.locator('#wayTabs [aria-selected=true]').getAttribute('id').then((id) => id?.replace(/^tab-/, ''));

/** Buttons on the screen smaller than 48 by 48 px. */
const small = (page: Page, sel = 'main button:visible, main a.btn:visible') =>
  page.locator(sel).evaluateAll((bs) =>
    bs
      .filter((b) => getComputedStyle(b).visibility !== 'hidden')
      .map((b) => ({ id: b.id || b.className, r: b.getBoundingClientRect() }))
      .filter(({ r }) => r.width > 0 && (r.width < 47.5 || r.height < 47.5))
      .map(({ id }) => id),
  );

describe('Add money as wallet cards', () => {
  it('shows each way as one picture card: screenshots of every card', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-start');
    const order = await wayOrder(page);
    for (const [i, id] of order.entries()) {
      await page.click(`#tab-${id}`);
      await expect.poll(() => page.getAttribute(`#tab-${id}`, 'aria-selected')).toBe('true');
      await shot(page, `card-${i + 1}-${id}.png`);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('reads the card on show with Listen: its word and its info line, which the info button shows', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-note');
    await page.click('#tab-note');
    // No sentences on the card until asked: the info line sits behind its button.
    expect(await page.isVisible('#wayInfo-note')).toBe(false);
    await page.click('#wayInfoBtn-note');
    expect(await page.getAttribute('#wayInfoBtn-note', 'aria-expanded')).toBe('true');
    expect(await page.textContent('#wayInfo-note')).toBe('Paper eCash, read with the camera. It cannot be linked to you.');
    await shot(page, 'card-2-note-info.png');
    await page.waitForSelector('#waysListen:not([hidden])');
    await page.click('#waysListen');
    await expect.poll(() => page.evaluate(() => (window as any).__spoken.join(' | '))).toBe('Note | Paper eCash, read with the camera. It cannot be linked to you.');
    // Lightning says who sees the payment.
    await page.click('#tab-lightning');
    await page.click('#wayInfoBtn-lightning');
    expect(await page.textContent('#wayInfo-lightning')).toBe('Your wallet sees a Lightning payment. An exchange that knows your name will see it too.');
    expect(await page.getAttribute('#way-lightning .way-badge', 'aria-label')).toBe('Others can see this payment');
    // Start free says Standard models can read what you type.
    await page.click('#tab-start');
    await page.click('#wayInfoBtn-start');
    expect(await page.textContent('#wayInfo-start')).toBe('No money needed. Free models are Standard models: the company running them can read what you type.');
    // The card's own word is all the screen says: one word per card and per button.
    for (const id of await wayOrder(page)) {
      await page.click(`#tab-${id}`);
      expect((await page.textContent(`#way-${id} .way-word`))!.trim().split(/\s+/)).toHaveLength(1);
      if (id !== 'more') expect((await page.textContent('#wayGo'))!.trim().split(/\s+/)).toHaveLength(1);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('moves between the cards with the icon tabs and with a swipe, and the big button follows', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-start');
    const order = await wayOrder(page);
    expect(order).toEqual(['start', 'note', 'lightning', 'card', 'ecash', 'more']);
    expect(await current(page)).toBe('start');
    expect(await page.textContent('#wayGo')).toBe('Start');
    // A tab: its card comes to the middle, and the big button says what it does.
    await page.click('#tab-lightning');
    expect(await current(page)).toBe('lightning');
    expect(await page.textContent('#wayGo')).toBe('Pay');
    const middle = async (id: string) => {
      const [c, t] = await Promise.all([page.locator(`#way-${id}`).boundingBox(), page.locator('#wayTrack').boundingBox()]);
      return Math.abs(c!.x + c!.width / 2 - (t!.x + t!.width / 2));
    };
    await expect.poll(() => middle('lightning')).toBeLessThan(2);
    // A finger swipes left: the next card. The finger is raw touch events (down, a move every frame, up),
    // which the page scrolls as it would a real finger. Chrome's synthesizeScrollGesture is not used: in
    // headless Chrome on Linux (CI) its touch gesture sends a touchstart and a touchend and no move.
    const cdp = await ctx.newCDPSession(page);
    const box = (await page.locator('#wayTrack').boundingBox())!;
    const swipe = async (xDistance: number) => {
      const x = Math.round(box.x + box.width / 2);
      const y = Math.round(box.y + box.height / 2);
      const steps = 12;
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, 16));
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x + Math.round((xDistance * i) / steps), y }] });
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    };
    await swipe(-200);
    await expect.poll(() => current(page)).toBe('card');
    await expect.poll(() => middle('card')).toBeLessThan(2);
    expect(await page.textContent('#wayGo')).toBe('Tap');
    // And back.
    await swipe(200);
    await expect.poll(() => current(page)).toBe('lightning');
    expect(await page.textContent('#wayGo')).toBe('Pay');
    // The arrow keys on the tabs.
    await page.focus('#tab-lightning');
    await page.keyboard.press('ArrowRight');
    expect(await current(page)).toBe('card');
    // The More card: its tiles open the other ways, and the big button waits.
    await page.click('#tab-more');
    expect(await page.isVisible('#wayGo')).toBe(false);
    expect(await page.locator('#way-more .way-tile').evaluateAll((ts) => ts.map((x) => x.id))).toEqual(['more-free', 'more-fedimint', 'more-othermint']);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('respects reduced motion: a tab jumps to its card, with no swipe hint', async () => {
    const { ctx, page } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-ecash');
    const target = await page.evaluate(() => {
      const t = document.querySelector('#wayTrack') as HTMLElement;
      (document.querySelector('#tab-ecash') as HTMLElement).click();
      const a = t.querySelector('.way-card') as HTMLElement;
      const b = t.querySelector('#way-ecash') as HTMLElement;
      return { now: t.scrollLeft, want: b.offsetLeft - a.offsetLeft };
    });
    expect(Math.abs(target.now - target.want)).toBeLessThan(2);
    // No swipe hand under the icons (owner, 2026-11-15): the next card peeking in says it all.
    expect(await page.locator('.way-hand').count()).toBe(0);
    await ctx.close();
  }, 60_000);

  it('puts Start free first at $0 with free models, then the way used last; a way from More gets its own card', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-start');
    expect((await wayOrder(page))[0]).toBe('start');
    // eCash used: it comes next, after Start free.
    await openWay(page, 'ecash');
    await page.waitForSelector('[data-fund=ecash]');
    await page.goBack();
    await page.waitForSelector('#tab-more');
    expect(await wayOrder(page)).toEqual(['start', 'ecash', 'note', 'lightning', 'card', 'more']);
    // With money on the balance there is no Start free: the way used last is first.
    await page.waitForTimeout(300); // the setting is written to IndexedDB
    await withKey(page, await fundedKey());
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-more');
    await expect.poll(() => wayOrder(page)).toEqual(['ecash', 'note', 'lightning', 'card', 'more']);
    // Other mint, from the More card: next time it has a card of its own, first, and leaves More.
    await openWay(page, 'othermint');
    await page.waitForSelector('[data-fund=othermint]');
    await page.goBack();
    await page.waitForSelector('#tab-more');
    expect(await wayOrder(page)).toEqual(['othermint', 'note', 'lightning', 'card', 'ecash', 'more']);
    expect(await page.locator('#more-othermint').count()).toBe(0);
    await shot(page, 'card-0-othermint-own-card.png');
    // Remembered on this phone: the order holds after a reload.
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector('#tab-more');
    expect((await wayOrder(page))[0]).toBe('othermint');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  for (const size of SIZES)
    it(`fits ${size.width} by ${size.height}: the card area does not scroll, and every button is at least 48 px`, async () => {
      const { ctx, page } = await phone({ viewport: size });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.goto(`${g.url}/v2/#/funds/add`);
      await page.waitForSelector('#tab-start');
      for (const id of await wayOrder(page)) {
        await page.click(`#tab-${id}`);
        if (size.width === 360 && (id === 'note' || id === 'more')) await shot(page, `card-360-${id}.png`);
        const m = await page.evaluate((w) => {
          const main = document.querySelector('main')!;
          const r = (s: string) => document.querySelector(s)!.getBoundingClientRect();
          const card = r(`#way-${w}`);
          return {
            scrollW: document.documentElement.scrollWidth,
            scrollH: document.documentElement.scrollHeight,
            mainScroll: main.scrollHeight - main.clientHeight,
            trackScrollY: (document.querySelector('#wayTrack') as HTMLElement).scrollHeight - (document.querySelector('#wayTrack') as HTMLElement).clientHeight,
            card: { top: card.top, bottom: card.bottom, left: card.left, right: card.right },
            tabs: r('#wayTabs').bottom,
            go: r('#wayGo').bottom,
          };
        }, id);
        if (m.scrollH > size.height) console.log('DBG', await page.evaluate(() => [...document.querySelectorAll('main > *, body > *')].map((e) => `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().top)}-${Math.round(e.getBoundingClientRect().bottom)}`).join('\n')));
        expect(m.scrollW, id).toBeLessThanOrEqual(size.width);
        expect(m.scrollH, id).toBeLessThanOrEqual(size.height);
        expect(m.mainScroll, id).toBe(0);
        expect(m.trackScrollY, id).toBe(0);
        expect(m.card.top, id).toBeGreaterThanOrEqual(0);
        expect(m.card.bottom, id).toBeLessThanOrEqual(m.tabs);
        expect(m.card.left, id).toBeGreaterThanOrEqual(0);
        expect(m.card.right, id).toBeLessThanOrEqual(size.width);
        expect(m.go, id).toBeLessThanOrEqual(size.height);
        // Every tile and button on the card on show is reachable and big enough.
        await expect.poll(() => small(page, `#wayTabs button, #wayGo, #waysListen:visible, .back-head button, #way-${id} button:visible`), { message: id }).toEqual([]);
      }
      // Start free's screen fits too, its question included.
      await page.goto(`${g.url}/v2/#/funds/start-free`);
      await page.waitForSelector('[data-screen=startFree]');
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(size.height);
      expect((await page.locator('#startFreeGo').boundingBox())!.y + 48).toBeLessThanOrEqual(size.height);
      expect(await small(page)).toEqual([]);
      if (size.width === 360) await shot(page, 'start-1-code-360.png');
      await ctx.close();
    }, 90_000);

  it('Start free: the code, the one question, then Funds at $0 on the free model with Ask now and Add money', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-start');
    await shot(page, 'card-1-start.png');
    await page.click('#wayGo');
    await page.waitForSelector('[data-screen=startFree]');
    // Icon tiles, not sentences; the note sits behind the info button.
    expect(await page.locator('#startFreeTiles li').allTextContents()).toEqual(['No name', 'No email', 'No money']);
    expect(await page.isVisible('#startFreeInfo')).toBe(false);
    await page.click('#startFreeInfoBtn');
    expect(await page.textContent('#startFreeInfo')).toBe('Free models answer at no cost. Add money later for private models.');
    await page.click('#startFreeInfoBtn');
    // No code: it says so. A wrong code: it says so.
    await page.click('#startFreeGo');
    expect(await page.textContent('#startFreeMsg')).toBe('Enter your invite code first.');
    await page.fill('#startFreeCode', 'not-a-code');
    await page.click('#startFreeGo');
    await expect.poll(() => page.textContent('#startFreeMsg')).toBe('Code does not work. This invite code does not work. Check it and try again.');
    // Paste puts the copied code in the field.
    await page.evaluate((c) => navigator.clipboard.writeText(c), createInvite(g));
    await page.fill('#startFreeCode', '');
    await page.click('#startFreePaste');
    await expect.poll(() => page.inputValue('#startFreeCode')).toMatch(/.+/);
    await shot(page, 'start-1-code.png');
    await page.click('#startFreeGo');
    // The question, in the same words as everywhere else.
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    expect(await page.textContent('#startFreeOpened')).toBe('Your balance is open.');
    expect(await page.textContent('#startFreeAskText')).toBe('Free models are Standard models: the company running them can read what you type. Use them?');
    expect(await page.textContent('#startFreeUse')).toBe('Use free models');
    expect(await page.textContent('#startFreeKeep')).toBe('Keep Private only');
    expect(await small(page, '#startFreeAsk button')).toEqual([]);
    await shot(page, 'start-2-question.png');
    await page.click('#startFreeUse');
    // Funds at $0 on the free model: the ring's centre says FREE, Ask now, and the fanned cards.
    await page.waitForSelector('[data-screen=funds]');
    expect(await page.textContent('#fundsSaid')).toBe('Private only is off now. You are using GLM Flash, a free model.');
    await page.waitForSelector('#fundsFreeTag:not([hidden])');
    expect(await page.textContent('#fundsFreeTag')).toBe('FREE');
    expect(await page.textContent('#fundsAmount')).toBe('$0.00');
    expect(await page.isVisible('#fundsAsk')).toBe(true);
    expect(await page.textContent('#addFundsBtn .stack-head')).toBe('Add money');
    expect(await page.isVisible('#takeOutBtn')).toBe(false);
    await shot(page, 'start-3-funds.png');
    // The fanned cards open the wallet cards; Start free is gone now that the free model is in use.
    await page.click('#addFundsBtn');
    await page.waitForSelector('#tab-more');
    expect(await page.locator('#tab-start').count()).toBe(0);
    await page.goBack();
    await page.click('#fundsAsk');
    await page.waitForSelector('[data-screen=home]');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('Start free with Keep Private only goes back and keeps it on; with a $0 key there is no code to give', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await withKey(page, await zeroKey());
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-start');
    expect((await wayOrder(page))[0]).toBe('start');
    await page.click('#wayGo');
    await page.waitForSelector('[data-screen=startFree]');
    expect(await page.isVisible('#startFreeField')).toBe(false);
    await page.click('#startFreeGo');
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    // Nothing was opened just now: no "Your balance is open."
    expect(await page.isVisible('#startFreeOpened')).toBe(false);
    await page.click('#startFreeKeep');
    await page.waitForSelector('[data-screen=addFunds]');
    await expect.poll(() => page.textContent('#toast')).toBe('Private only stays on. To use free models later, turn it off in Choose a model.');
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('true');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('the home at $0: one Add money button on a paid model; on a free model a FREE chip with the model and a small Add money', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('#addMoney:not([hidden])');
    expect(await page.textContent('#addMoney')).toBe('Add money');
    expect(await page.isVisible('#freeModelChip')).toBe(false);
    expect(await page.locator('#scanNote, #otherWays:visible').count()).toBe(0);
    await shot(page, 'home-1-paid-model.png');
    await page.click('#addMoney');
    await page.waitForSelector('[data-screen=addFunds]');
    // A free model with no balance key yet: the chip opens Start free.
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
    await page.click('[data-model="glm-5.3-flash"]');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('#freeModelChip:not([hidden])');
    expect(await page.textContent('#freeModelChip')).toBe('GLM FlashFREE');
    expect(await page.getAttribute('#freeModelChip', 'aria-label')).toBe('GLM Flash, a free model. Questions are free');
    // Add money is its icon only, beside the chip, still 48 px and named.
    const add = (await page.locator('#addMoney').boundingBox())!;
    expect(add.width).toBeGreaterThanOrEqual(48);
    expect(add.height).toBeGreaterThanOrEqual(48);
    expect(await page.getAttribute('#addMoney', 'aria-label')).toBe('Add money');
    expect(await page.isVisible('#addMoney span')).toBe(false);
    const chip = (await page.locator('#freeModelChip').boundingBox())!;
    expect(Math.abs(chip.y + chip.height / 2 - (add.y + add.height / 2))).toBeLessThan(2);
    await page.click('#freeModelChip');
    await page.waitForSelector('[data-screen=startFree]');
    // With a $0 key on the free model, the chip opens Choose a model.
    await withKey(page, await zeroKey());
    await page.waitForSelector('#freeModelChip:not([hidden])');
    await shot(page, 'home-2-free-model.png');
    await page.click('#freeModelChip');
    await page.waitForSelector('[data-screen=model]');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('Funds with money: the ring, Take funds out as an icon button, and Add money opening the wallet cards', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await withKey(page, await fundedKey());
    await page.goto(`${g.url}/v2/#/funds`);
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$2.00');
    await page.waitForSelector('#takeOutBtn:not([hidden])');
    expect(await page.getAttribute('#takeOutBtn', 'aria-label')).toBe('Take funds out');
    expect(await page.isVisible('#fundsFreeTag')).toBe(false);
    expect(await page.isVisible('#fundsAsk')).toBe(false);
    expect(Number(await page.getAttribute('.funds-ring-svg', 'data-funds'))).toBeGreaterThan(400);
    await shot(page, 'funds-1-money.png');
    await page.click('#takeOutBtn');
    await page.waitForSelector('[data-screen=takeOut]');
    await expect.poll(() => page.inputValue('#outAmount')).toBe('2.00');
    await page.goBack();
    await page.click('#addFundsBtn');
    await page.waitForSelector('#tab-more');
    expect((await wayOrder(page))[0]).toBe('note');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
