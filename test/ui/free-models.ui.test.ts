import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium } from 'playwright-core';
import { createInvite, type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Free models (docs/PAYMENTS.md, Free models) in the v2 app: the model list shows a Free badge, a phone
// with no balance key is sent to open one with an invite code, and then a question at a $0 balance
// shows "Free", is sent, is answered, and the balance stays at 0. The v1 app's model menu says Free too.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true' },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'free-echo', name: 'Free Echo', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
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
    expect(await freeCard.textContent()).toContain('Free to use. Needs a balance, even with nothing on it.');
    expect(await page.locator('[data-model="mock-echo"] .tag.free').count()).toBe(0);
    expect(await page.locator('[data-model="mock-echo"]').textContent()).toMatch(/in, .* out per 1M/);
    await freeCard.click();
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');

    // No balance key yet: Type says the model is free and needs a balance, not "add funds".
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await expect.poll(() => page.textContent('#typeNotice')).toContain('This model is free, but it needs a balance.');
    expect(await page.textContent('#priceLine')).toBe('PriceFree');
    await page.click('#noticeBtn');
    await page.waitForSelector('[data-fund=invite]');
    await page.click('#openBalance');
    expect(await page.textContent('[role=status].msg')).toContain('invite code');
    await page.fill('#openInvite', createInvite(g));
    await page.click('#openBalance');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsNote')).toBe('Questions to this model are free.');
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

describe('Start free on the first run', () => {
  it('opens a $0 balance with the invite code alone; free models work, paid ones still need funds', async () => {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=intro][data-step=welcome]');
    await page.waitForSelector('#introStartFree:not([hidden])');
    expect(await page.textContent('#introStartFree')).toBe('Start free');
    await page.click('#introStartFree');
    expect(await page.textContent('#introFreeMsg')).toBe('Enter your invite code first.');
    await page.fill('#introInvite', 'not-a-code');
    await page.click('#introStartFree');
    await expect.poll(() => page.textContent('#introFreeMsg')).toBe('This invite code does not work. Check it and try again.');
    await page.fill('#introInvite', createInvite(g));
    await page.click('#introStartFree');
    // Private only is on by default and the free models are Standard: the words say how to see them.
    await expect.poll(() => page.textContent('#introFreeMsg')).toBe('Balance opened. The free models are Standard models: turn off Private only in Choose a model to use them.');
    const key = await page.evaluate(() => localStorage.getItem('forge.balanceKey'));
    expect(key).toMatch(/^sk-forge-/);
    // The field and the button are gone once there is a key.
    await expect.poll(() => page.isVisible('#introInviteField')).toBe(false);

    // The balance is $0 and real: a free model answers on it, a paid one is refused for funds.
    const w = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(w.balance_msub).toBe(0);
    const ask = (model: string) =>
      fetch(`${g.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }) });
    expect((await ask('free-echo')).status).toBe(200);
    expect((await ask('mock-echo')).status).toBe(402);

    // Turning Private only off and choosing the free model, Type sends at $0 with no funds notice.
    await page.click('#introSkip');
    await page.waitForSelector('[data-screen=home]');
    await page.click('#btn-more');
    await page.click('#moreModel');
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    await page.click('[data-model="free-echo"]');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'Hello?');
    expect(await page.textContent('#priceLine')).toBe('PriceFree');
    expect(await page.isVisible('#typeNotice')).toBe(false);
    expect(await page.isDisabled('#sendBtn')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('is not offered on an engine with no free models', async () => {
    const plain = await startGateway({ env: { FORGE_INVITE_ONLY: 'true' } });
    try {
      const ctx = await browser.newContext(PHONE);
      const page = await ctx.newPage();
      await page.goto(`${plain.url}/v2/`);
      await page.waitForSelector('#introInviteField:not([hidden])');
      // The methods are read after the first paint; give them the time a phone would.
      await page.waitForTimeout(500);
      expect(await page.isVisible('#introStartFree')).toBe(false);
      expect((await (await fetch(`${plain.url}/v1/wallet/fund/methods`)).json()).open).toEqual({ enabled: false, free_models: [] });
      await ctx.close();
    } finally {
      await plain.close();
    }
  });
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
