import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, PRICE_IN, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay } from './ways.ts';

// Choose a model shows first which models the money on the phone can pay for (screens/settings.js,
// core/balances.js cannotPay): one a short question to it would stop for want of money is dimmed and
// carries the Add money mark, and choosing it goes straight on to Add money. Free models and models the
// balance covers look and behave as before.
const PHONE = { viewport: { width: 412, height: 892 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const MARK = 'Add money first';

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_UNITS: 'usd,sat' },
    editCatalog: (c) => {
      // mock-echo holds about 29 cents for a short question; Dear Echo about $2.60.
      c.models.push({ id: 'dear-echo', name: 'Dear Echo', supplier: 'mock', upstream: 'mock-echo', input_usd_per_mtok: PRICE_IN, output_usd_per_mtok: 10_000, max_output_tokens: 256, price_verified: true });
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

async function topup(unit: 'usd' | 'sat', amount: number): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, unit, amount), invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

/** A phone keeping this balance key, on Choose a model with Private only off. noRate: the engine gives no BTC/USD rate. */
async function phone(key: string, { noRate = false } = {}) {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  await ctx.addInitScript((k) => localStorage.getItem('forge.balanceKey') || localStorage.setItem('forge.balanceKey', k), key);
  if (noRate)
    await ctx.route('**/v1/models', async (route) => {
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), btc_usd: null } });
    });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${g.url}/v2/`);
  await page.waitForSelector('[data-screen=home]');
  await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toMatch(/\d/);
  await openList(page);
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.waitForSelector('[data-model="dear-echo"]');
  return { page, errors, close: () => ctx.close() };
}

async function openList(page: Page) {
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
}

/** The models that carry the mark, by the attribute and by their accessible name, which must agree. */
async function marked(page: Page): Promise<string[]> {
  const ids = await page.$$eval('[data-model]', (els) => els.filter((e) => e.hasAttribute('data-poor')).map((e) => e.getAttribute('data-model')!));
  const named = await page.getByRole('radio', { name: new RegExp(MARK) }).evaluateAll((els) => els.map((e) => e.getAttribute('data-model')!));
  expect(named.sort()).toEqual([...ids].sort());
  // Each marked card has its picture: the Add money mark, and is dimmed; an unmarked one has neither.
  for (const id of ids) {
    expect(await page.locator(`[data-model="${id}"] .model-poor svg`).count()).toBe(1);
    expect(Number(await page.locator(`[data-model="${id}"] .model-name b`).evaluate((b) => getComputedStyle(b).opacity))).toBeLessThan(1);
  }
  return ids.sort();
}

describe('Choose a model, and what the balance can pay for', () => {
  it('a small dollar balance: the cheap model and the free one as before, the dear one marked; tapping it chooses it and opens Add money, and Ask now asks with it', async () => {
    const { page, errors, close } = await phone(await topup('usd', 100));
    await expect.poll(() => marked(page)).toEqual(['dear-echo']);
    expect(await page.locator('[data-model="mock-echo"] .model-poor').count()).toBe(0);
    expect(await page.locator('[data-model="free-echo"] .model-poor').count()).toBe(0);
    expect(Number(await page.locator('[data-model="mock-echo"] .model-name b').evaluate((b) => getComputedStyle(b).opacity))).toBe(1);
    const chosen = () => page.evaluate(async (src) => (await new Function('s', 'return import(s)')(src)).kv.get('settings').then((x: any) => x?.model), '/v2/core/db.js');

    // Tapping a marked model chooses it and goes straight on to Add money.
    await page.locator('[data-model="dear-echo"]').tap();
    await page.waitForSelector('[data-screen=addFunds]');
    await expect.poll(chosen).toBe('dear-echo');
    // The list is not under Add money: Back goes where the list was opened from.
    await page.goBack();
    await page.waitForSelector('[data-screen=home]');
    await openList(page);
    await expect.poll(() => marked(page)).toEqual(['dear-echo']);
    expect(await page.getAttribute('[data-model="dear-echo"]', 'aria-checked')).toBe('true');
    await page.locator('[data-model="dear-echo"]').tap();

    // Money added (eCash, from Add money): the success panel's Ask now goes home, with the dear model
    // chosen, and a question to it can be paid for now.
    await openWay(page, 'ecash');
    await page.waitForSelector('[data-fund=ecash] #ecashToken');
    await page.fill('#ecashToken', await mintToken(MINT_A, 'usd', 300));
    await page.click('#ecashAdd');
    await page.waitForSelector('#fundsAdded');
    await page.click('#fundsAsk');
    await page.waitForSelector('[data-screen=home]');
    expect(await chosen()).toBe('dear-echo');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'Hi');
    await expect.poll(() => page.isVisible('#typeNotice')).toBe(false);
    expect(await page.isDisabled('#sendBtn')).toBe(false);
    await openList(page);
    await page.waitForSelector('[data-model="dear-echo"]');
    await expect.poll(() => marked(page)).toEqual([]);
    // An unmarked model closes the list, as before.
    await page.locator('[data-model="mock-echo"]').tap();
    await page.waitForSelector('[data-screen=home]');
    expect(errors).toEqual([]);
    await close();
  }, 90_000);

  it('a sat balance pays with a rate; without one it cannot, so every paid model is marked and the free one is not', async () => {
    const key = await topup('sat', 2000);
    const a = await phone(key);
    await expect.poll(() => marked(a.page)).toEqual(['dear-echo']);
    expect(a.errors).toEqual([]);
    await a.close();

    const b = await phone(key, { noRate: true });
    const paid = (await b.page.$$eval('[data-model]', (els) => els.map((e) => e.getAttribute('data-model')!))).filter((id) => id !== 'free-echo').sort();
    expect(paid).toEqual(expect.arrayContaining(['dear-echo', 'mock-echo']));
    await expect.poll(() => marked(b.page)).toEqual(paid);
    expect(await b.page.locator('[data-model="free-echo"] .model-poor').count()).toBe(0);
    // As asking says: the cheap model chosen, a question cannot be paid without a rate.
    await b.page.locator('[data-model="mock-echo"]').tap();
    await b.page.goto(`${g.url}/v2/#/type`);
    await b.page.waitForSelector('[data-screen=type]');
    await b.page.fill('#question', 'Hi');
    await expect.poll(() => b.page.textContent('#typeNotice')).toMatch(/^Not enough funds\./);
    expect(b.errors).toEqual([]);
    await b.close();
  }, 90_000);

  it('with no money at all every paid model is marked; a free model never is', async () => {
    const r = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
    const { key } = (await r.json()) as any;
    const { page, errors, close } = await phone(key);
    const paid = (await page.$$eval('[data-model]', (els) => els.map((e) => e.getAttribute('data-model')!))).filter((id) => id !== 'free-echo').sort();
    expect(paid).toContain('mock-echo');
    await expect.poll(() => marked(page)).toEqual(paid);
    expect(await page.locator('[data-model="free-echo"] .model-poor').count()).toBe(0);
    expect(errors).toEqual([]);
    await close();
  }, 60_000);
});
