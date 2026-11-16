import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { wayOrder } from './ways.ts';

// Free models (docs/PAYMENTS.md, Free models) in the v2 app: the model list shows a Free badge, a phone
// with no balance key is sent to open one with an invite code, and then a question at a $0 balance
// shows "Free", is sent, is answered, and the balance stays at 0. The v1 app's model menu says Free too.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
// Screenshots of Start free for the owner (2026-11-15: "make start free easier to find"; then "maybe the
// invite code field should be on the last first run screen": the first run's are under start-free-2/).
const SHOTS = join(import.meta.dirname, '../../.tmp/start-free');
const SHOTS_LAST = join(import.meta.dirname, '../../.tmp/start-free-2');

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true' },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'free-echo', name: 'Free Echo', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
      // The fast free model Start free prefers (core/price.js PREFERRED_FREE), listed after the other.
      c.models.push({ id: 'glm-5.3-flash', name: 'GLM Flash', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

describe('free models in the v2 app', () => {
  it('shows Free, opens a balance with an invite, and answers at $0 without charging', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && !/401/.test(m.text()) && errors.push(m.text()));
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');

    // The model list: a Free badge on the free model, a price on the paid one.
    await page.click('#btn-more');
    await page.click('#moreModel');
    await page.waitForSelector('[data-screen=model]');
    if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
    const freeCard = page.locator('[data-model="free-echo"]');
    expect(await freeCard.locator('.tag.free').textContent()).toBe('Free');
    // What it costs is behind the card's info button (reading load): the card shows the Free tag.
    expect(await page.locator('.opt', { has: freeCard }).locator('.info-more').textContent()).toContain('Free to use. Needs a balance, even with nothing on it.');
    expect(await page.locator('[data-model="mock-echo"] .tag.free').count()).toBe(0);
    expect(await page.locator('.opt', { has: page.locator('[data-model="mock-echo"]') }).locator('.info-more').textContent()).toMatch(/in, .* out per 1M/);
    await freeCard.click();
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');

    // No balance key yet: Type says the model is free and offers Start free, with no word of a balance.
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await expect.poll(() => page.textContent('#typeNoticeText')).toBe('This model is free. Start free with your invite code. No money needed.');
    expect(await page.textContent('#noticeBtn')).toBe('Start free');
    expect(await page.textContent('#priceLine')).toBe('PriceFree');
    await page.click('#noticeBtn');
    await page.waitForSelector('[data-screen=startFree]');
    await page.click('#startFreeGo');
    expect(await page.textContent('#startFreeMsg')).toContain('invite code');
    await page.fill('#startFreeCode', createInvite(g));
    await page.click('#startFreeGo');
    await page.waitForSelector('[data-screen=funds]');
    expect(await page.textContent('#fundsSaid')).toBe('Using Free Echo, a free model.');
    await expect.poll(() => page.textContent('#fundsNote')).toBe('This model is free.');
    const key = await page.evaluate(() => localStorage.getItem('forge.balanceKey'));
    expect(key).toMatch(/^sk-forge-/);

    // At $0: no "not enough funds", the price line reads Free, and the question is answered.
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'What should I bring on Saturday?');
    expect(await page.textContent('#priceLine')).toBe('PriceFree');
    expect(await page.getAttribute('#priceLine', 'data-msub')).toBe('0');
    expect(await page.isVisible('#typeNotice')).toBe(false);
    expect(await page.isDisabled('#sendBtn')).toBe(false);
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(((await page.textContent('#answerText')) ?? '').startsWith('Forge word')).toBe(true);
    expect(await page.textContent('#answerNote')).toBe('That was free.');
    // Ask again is free too.
    expect(await page.textContent('#againBtn')).toContain('Free');

    // The engine charged nothing: the balance is still 0, with no reservation.
    const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(w).toMatchObject({ balance_msub: 0, available_msub: 0 });
    expect(g.deps.db.prepare("SELECT charged_msub, cost_source FROM requests WHERE model = 'free-echo'").all()).toEqual([{ charged_msub: 0, cost_source: 'free' }]);
    expect(errors).toEqual([]);
    await ctx.close();
  });
});

/** A phone on a clean profile (seen: the first run was already seen), with its page errors kept. */
async function phone({ seen = false, viewport = PHONE.viewport } = {}) {
  const ctx = await browser.newContext({ ...PHONE, viewport });
  if (seen) await pastFirstRun(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 401 and 402: a free model with no key and a paid one at $0; 403: the wrong invite code, on purpose.
  page.on('console', (m) => m.type() === 'error' && !/40[123]/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

async function shot(page: Page, name: string, dir = SHOTS): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: join(dir, name) });
}

/** A $0 balance key opened with an invite through the API. */
async function zeroKey(): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`open failed: ${JSON.stringify(b)}`);
  return b.key;
}

const privateOnly = async (page: Page) => {
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  return page.getAttribute('#privateOnly', 'aria-checked');
};

describe('Start free on the first run', () => {
  /** Walks a clean profile from Welcome to the last step with Next. */
  const toLastStep = async (page: Page) => {
    for (const s of ['pay', 'limits', 'private']) {
      await page.click('#introNext');
      await page.waitForSelector(`[data-screen=intro][data-step=${s}]`);
    }
  };

  it("is the last step's round button, green, the only one; the invite opens a $0 balance, asks, and Use free models opens the home on a free model", async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=intro][data-step=welcome]');
    // Welcome has no secondary link, even with free models: the round Next button only.
    await page.waitForSelector('#introListen:not([hidden])');
    await page.waitForTimeout(500); // the engine's methods are read after the first paint
    expect(await page.locator('.fr-links button').count()).toBe(0);
    await shot(page, '1-step1.png', SHOTS_LAST);

    await toLastStep(page);
    // The last step has one button once the engine says it has free models: the round one, green, which
    // opens Start free. Learn more is the info button on the Private only card.
    await page.waitForSelector('#introNext.free');
    expect(await page.getAttribute('#introNext', 'aria-label')).toBe('Start free with an invite');
    expect(await page.locator('#introNext').evaluate((b) => getComputedStyle(b).backgroundColor)).toBe('rgb(63, 207, 180)');
    expect(await page.locator('.fr-links button:visible').count()).toBe(0);
    expect(await page.getAttribute('#privateInfo', 'aria-label')).toBe('Learn more about Private only');
    await page.waitForSelector('#introListen:not([hidden])');
    await shot(page, '2-step4-link.png', SHOTS_LAST);

    await page.click('#introNext');
    await page.waitForSelector('dialog#inviteSheet[open]');
    expect(await page.textContent('#inviteSheetTitle')).toBe('Start free');
    expect(await page.textContent('#introStartFree')).toBe('Start free');
    expect(await page.textContent('#introFreeNote')).toBe('Free models answer at no cost. Add money later for private models.');
    expect(await page.textContent('#introAddMoney')).toBe("I'll add money instead");
    expect(await page.isVisible('#introInvite')).toBe(true);
    expect(await page.isVisible('#introInviteDone')).toBe(false);
    expect(await page.isVisible('#introInviteHint')).toBe(false);
    await page.click('#introStartFree');
    expect(await page.textContent('#introFreeMsg')).toBe('Enter your invite code first.');
    await page.fill('#introInvite', 'not-a-code');
    await page.click('#introStartFree');
    await expect.poll(() => page.textContent('#introFreeMsg')).toBe('Code does not work. This invite code does not work. Check it and try again.');
    await page.fill('#introInvite', createInvite(g));
    await page.waitForTimeout(250); // the sheet's rise has ended
    await shot(page, '3-start-free-sheet.png', SHOTS_LAST);
    await page.click('#introStartFree');

    // The balance is open; the question, once, in the sheet. Private only is still on until the answer.
    await page.waitForSelector('#introFreeAsk:not([hidden])');
    expect(await page.textContent('#introFreeAsk p')).toBe('Free models are Standard models: the company running them can read what you type. Use them?');
    expect(await page.textContent('#introUseFree')).toBe('Use free models');
    expect(await page.textContent('#introKeepPrivate')).toBe('Keep Private only');
    expect(await page.textContent('#introFreeMsg')).toBe('Your balance is open.');
    expect(await page.isVisible('#introInvite')).toBe(false);
    expect(await page.isVisible('#introAddMoney')).toBe(false);
    expect(await page.isVisible('#introInviteDone')).toBe(false);
    expect(await page.getAttribute('#privateToggle', 'aria-checked')).toBe('true');
    const key = await page.evaluate(() => localStorage.getItem('forge.balanceKey'));
    expect(key).toMatch(/^sk-forge-/);
    await shot(page, '4-question.png', SHOTS_LAST);

    // Use free models: the first run is over, the home opens and says what changed.
    await page.click('#introUseFree');
    await page.waitForSelector('[data-screen=home]');
    expect(await page.evaluate(() => location.hash)).toBe('#/');
    expect(await page.evaluate(() => localStorage.getItem('forge2.firstRun'))).toBe('done');
    await expect.poll(() => page.textContent('#toast')).toBe('Private only is off now. You are using GLM Flash, a free model.');
    await shot(page, '5-home-after-start-free.png', SHOTS_LAST);

    // The balance is $0 and real: a free model answers on it, a paid one is refused for funds.
    const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(w.balance_msub).toBe(0);
    const ask = (model: string) =>
      fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }) });
    expect((await ask('free-echo')).status).toBe(200);
    expect((await ask('mock-echo')).status).toBe(402);

    // Type shows Free on GLM Flash and sends at $0, with no funds notice.
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'Hello?');
    expect(await page.textContent('#priceLine')).toBe('PriceFree');
    expect(await page.isVisible('#typeNotice')).toBe(false);
    await page.click('#sendBtn');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(await page.textContent('#answerNote')).toBe('That was free.');
    expect(g.deps.db.prepare("SELECT charged_msub FROM requests WHERE model = 'glm-5.3-flash'").all()).toEqual([{ charged_msub: 0 }]);
    expect(await privateOnly(page)).toBe('false');

    // Opened again from More with the key: the switch shows Off, and the round button is Start again.
    await page.goto(`${g.url}/v2/#/start/private`);
    await page.waitForSelector('[data-screen=intro][data-step=private]');
    expect(await page.getAttribute('#privateToggle', 'aria-checked')).toBe('false');
    await page.waitForTimeout(500);
    expect(await page.isVisible('#introInviteLink')).toBe(false);
    expect(await page.locator('.fr-links button:visible').count()).toBe(0);
    expect(await page.getAttribute('#introNext', 'class')).toBe('fr-next');
    expect(await page.getAttribute('#introNext', 'aria-label')).toBe('Start');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("I'll add money instead keeps the code, ends the first run and opens Add money on the paper note; Keep Private only opens the home with it on", async () => {
    const { ctx, page, errors } = await phone();
    const code = createInvite(g);
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=intro][data-step=welcome]');
    await toLastStep(page);
    await page.waitForSelector('#introNext.free');
    await page.click('#introNext');
    await page.waitForSelector('dialog#inviteSheet[open]');
    await page.fill('#introInvite', code);
    await page.click('#introAddMoney');
    // The first run is over: Add money is open on the paper note's card, though Start free's comes first.
    await page.waitForSelector('[data-screen=addFunds]');
    await page.waitForSelector('#wayGo[data-way=note]');
    expect(await page.getAttribute('#tab-note', 'aria-selected')).toBe('true');
    expect(await page.locator('#wayTabs [role=tab]').first().getAttribute('id')).toBe('tab-start');
    await expect.poll(() => page.locator('#way-note').evaluate((c) => Math.round(c.getBoundingClientRect().left + c.getBoundingClientRect().width / 2 - innerWidth / 2))).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('forge2.firstRun'))).toBe('done');
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toBeNull();
    // Back is the home, not the first run.
    await page.goBack();
    await page.waitForSelector('[data-screen=home]');
    // The code is the one the funding screens use, and Start free on Add money has it too.
    await page.goto(`${g.url}/v2/#/funds/add/ecash`);
    await page.waitForSelector('[data-fund=ecash]');
    expect(await page.inputValue('#invite')).toBe(code);
    await page.goto(`${g.url}/v2/#/funds/start-free`);
    await page.waitForSelector('[data-screen=startFree]');
    expect(await page.inputValue('#startFreeCode')).toBe(code);

    // Back on the first run, the sheet still has it: Start free, then Keep Private only.
    await page.goto(`${g.url}/v2/#/start/private`);
    await page.waitForSelector('[data-screen=intro][data-step=private]');
    await page.waitForSelector('#introNext.free');
    await page.click('#introNext');
    await page.waitForSelector('dialog#inviteSheet[open]');
    expect(await page.inputValue('#introInvite')).toBe(code);
    await page.click('#introStartFree');
    await page.waitForSelector('#introFreeAsk:not([hidden])');
    await page.click('#introKeepPrivate');
    await page.waitForSelector('[data-screen=home]');
    expect(await page.evaluate(() => localStorage.getItem('forge2.firstRun'))).toBe('done');
    await expect.poll(() => page.textContent('#toast')).toBe('Private only stays on. To use free models later, turn it off in Choose a model.');
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toMatch(/^sk-forge-/);
    expect(await privateOnly(page)).toBe('true');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  for (const size of [
    { width: 360, height: 640 },
    { width: 412, height: 915 },
  ])
    it(`fits ${size.width} by ${size.height} with Start free on the last step: no scrolling, 48 px touch targets`, async () => {
      const { ctx, page } = await phone({ seen: true, viewport: size });
      await page.goto(`${g.url}/v2/#/start/private`);
      await page.waitForSelector('#introNext.free');
      const m = await page.evaluate(() => {
        const main = document.querySelector('main')!;
        return { scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight, mainScroll: main.scrollHeight - main.clientHeight, bottom: document.querySelector('.fr-links')!.getBoundingClientRect().bottom };
      });
      expect(m.scrollW).toBeLessThanOrEqual(size.width);
      expect(m.scrollH).toBeLessThanOrEqual(size.height);
      expect(m.mainScroll).toBe(0);
      expect(m.bottom).toBeLessThanOrEqual(size.height);
      const small = (sel: string) => page.locator(sel).evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width < 48 || r.height < 48).length);
      expect(await small('main > button:visible, main > :not(dialog) button:visible')).toBe(0);
      // The info button and the switch on the card are inside it, side by side.
      const [card, sw, info] = await Promise.all(['#privateCard', '#privateToggle', '#privateInfo'].map((s) => page.locator(s).boundingBox()));
      expect(info!.x + info!.width).toBeLessThanOrEqual(card!.x + card!.width);
      expect(sw!.x + sw!.width).toBeLessThanOrEqual(info!.x);
      // The label is on one line.
      expect((await page.locator('#privateLabel').boundingBox())!.height).toBeLessThan(30);
      // The sheet's buttons too, the question's included.
      await page.click('#introNext');
      await page.waitForSelector('dialog#inviteSheet[open]');
      expect(await small('dialog#inviteSheet button:visible')).toBe(0);
      await page.fill('#introInvite', createInvite(g));
      await page.click('#introStartFree');
      await page.waitForSelector('#introFreeAsk:not([hidden])');
      expect(await small('dialog#inviteSheet button:visible')).toBe(0);
      const ask = await page.locator('#introFreeAsk').boundingBox();
      expect(ask!.y + ask!.height).toBeLessThanOrEqual(size.height);
      await ctx.close();
    }, 60_000);

  it('is not offered on an engine with no free models: the last step has "I have an invite code", Funds and Type stay as before', async () => {
    const plain = await startGateway({ env: { FORGE_INVITE_ONLY: 'true' } });
    try {
      const ctx = await browser.newContext(PHONE);
      const page = await ctx.newPage();
      await page.goto(`${plain.url}/v2/`);
      await page.waitForSelector('[data-screen=intro][data-step=welcome]');
      // The methods are read after the first paint; give them the time a phone would.
      await page.waitForTimeout(500);
      expect(await page.locator('.fr-links button').count()).toBe(0);
      await toLastStep(page);
      await page.waitForSelector('#introInviteLink:not([hidden])');
      await page.waitForTimeout(500);
      expect(await page.textContent('#introInviteLink')).toBe('I have an invite code');
      await page.click('#introInviteLink');
      await page.waitForSelector('#introInvite');
      expect(await page.textContent('#inviteSheetTitle')).toBe('Invite code');
      expect(await page.isVisible('#introStartFree')).toBe(false);
      expect(await page.isVisible('#introAddMoney')).toBe(false);
      expect(await page.isVisible('#introInviteHint')).toBe(true);
      expect(await page.isVisible('#introInviteDone')).toBe(true);
      expect((await (await fetch(`${plain.url}/v1/wallet/fund/methods`)).json()).open).toEqual({ enabled: false, free_models: [] });
      await page.goto(`${plain.url}/v2/#/funds/add`);
      await page.waitForSelector('#tab-note');
      expect(await page.locator('#tab-start').count()).toBe(0);
      await page.goto(`${plain.url}/v2/#/type`);
      await page.waitForSelector('#typeNotice:not([hidden])');
      expect(await page.isVisible('#noticeBtn')).toBe(true);
      expect(await page.isVisible('#noticeFreeBtn')).toBe(false);
      await ctx.close();
    } finally {
      await plain.close();
    }
  }, 60_000);

  it('reads the ways to pay again after a failed read: later on its own, and at once when the phone is back online', async () => {
    for (const how of ['timer', 'online'] as const) {
      const { ctx, page, errors } = await phone();
      let fail = true;
      let reads = 0;
      await page.route('**/v1/wallet/fund/methods', (route) => (reads++, fail ? route.abort('connectionaborted') : route.continue()));
      await page.goto(`${g.url}/v2/#/start/private`);
      await page.waitForSelector('[data-screen=intro][data-step=private]');
      await expect.poll(() => reads).toBeGreaterThan(0);
      // Without the engine's answer Start free is not offered: the plain round button.
      expect(await page.getAttribute('#introNext', 'class')).not.toContain('free');
      fail = false;
      // The first retry is 2 s after the failure; back online asks at once.
      if (how === 'online') await page.evaluate(() => dispatchEvent(new Event('online')));
      await page.waitForSelector('#introNext.free', { timeout: how === 'online' ? 1500 : 6000 });
      expect(await page.getAttribute('#introNext', 'aria-label')).toBe('Start free with an invite');
      // Once read, it is not asked for again.
      const n = reads;
      await page.evaluate(() => dispatchEvent(new Event('online')));
      await page.waitForTimeout(2500);
      expect(reads).toBe(n);
      expect(errors.filter((e) => !/ERR_CONNECTION_ABORTED/.test(e))).toEqual([]);
      await ctx.close();
    }
  }, 60_000);
});

describe('Start free and the funds notice', () => {
  it('at $0, Start free has no code to ask; "Use a free model" next to Add funds asks while Private only is on, then Type sends free', async () => {
    const { ctx, page, errors } = await phone({ seen: true });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const key = await zeroKey();
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');

    // Add money with a $0 key on a paid (private) model: Start free first, and its screen asks no code.
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-start');
    expect((await wayOrder(page))[0]).toBe('start');
    await page.click('#wayGo');
    await page.waitForSelector('[data-screen=startFree]');
    expect(await page.isVisible('#startFreeField')).toBe(false);

    // Type: the funds notice, with the free model next to Add funds.
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('#typeNotice:not([hidden])');
    expect(await page.textContent('#typeNotice p')).toBe('No funds. Add money to ask a question.');
    expect(await page.textContent('#noticeBtn')).toBe('Add money');
    expect(await page.textContent('#noticeFreeBtn')).toBe('Use a free model');
    const small = await page.locator('#typeNotice button').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width < 48 || r.height < 48).length);
    expect(small).toBe(0);
    await shot(page, '5-funds-notice.png');

    // Keep Private only: nothing changes, the notice is back.
    await page.click('#noticeFreeBtn');
    await page.waitForSelector('#typeFreeAsk');
    expect(await page.textContent('#typeFreeAsk')).toBe('Free models are Standard models: the company running them can read what you type. Use them?');
    await page.click('#typeKeepPrivate');
    await expect.poll(() => page.textContent('#toast')).toBe('Private only stays on. To use free models later, turn it off in Choose a model.');
    await page.waitForSelector('#noticeFreeBtn');
    expect(await page.isDisabled('#sendBtn')).toBe(true);

    // Use free models: Private only goes off, GLM Flash is chosen, and the question is free.
    await page.click('#noticeFreeBtn');
    await page.click('#typeUseFree');
    await expect.poll(() => page.textContent('#toast')).toBe('Private only is off now. You are using GLM Flash, a free model.');
    await expect.poll(() => page.isVisible('#typeNotice')).toBe(false);
    await page.fill('#question', 'Is this free?');
    expect(await page.textContent('#priceLine')).toBe('PriceFree');
    expect(await page.isDisabled('#sendBtn')).toBe(false);
    await page.click('#sendBtn');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(await page.textContent('#answerNote')).toBe('That was free.');
    expect(await privateOnly(page)).toBe('false');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('with Private only off already, "Use a free model" chooses it without asking', async () => {
    const { ctx, page } = await phone({ seen: true });
    const key = await zeroKey();
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.reload();
    await page.goto(`${g.url}/v2/#/more/model`);
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    await page.click('[data-model="mock-echo"]');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('#noticeFreeBtn');
    await page.click('#noticeFreeBtn');
    await expect.poll(() => page.textContent('#toast')).toBe('Using GLM Flash, a free model.');
    expect(await page.locator('#typeFreeAsk').count()).toBe(0);
    await expect.poll(() => page.isVisible('#typeNotice')).toBe(false);
    await ctx.close();
  }, 60_000);
});

describe('free models in the v1 app', () => {
  it('says Free in the model menu', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${g.url}/`);
    // The menu is drawn when it opens, once the models are in.
    await page.waitForFunction(() => !document.querySelector('#modelName .skel'));
    await page.click('#modelBtn');
    await page.waitForSelector('#modelList .opt[data-id="free-echo"]');
    const free = await page.evaluate(() => {
      const o = document.querySelector('#modelList .opt[data-id="free-echo"] .t-price');
      return o ? { text: o.textContent, title: o.getAttribute('title'), cls: o.className } : null;
    });
    expect(free).toEqual({ text: 'Free', title: 'Free to use with a balance key, even with nothing on it', cls: 'tag t-price t-free' });
    const paid = await page.evaluate(() => document.querySelector('#modelList .opt[data-id="mock-echo"] .t-price')?.textContent);
    expect(paid).toMatch(/in · .* out per 1M/);
    await ctx.close();
  });
});
