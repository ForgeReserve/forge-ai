import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Two balances (docs/PAYMENTS.md, Two balances): the home shows one total (one balance in its own unit,
// both in dollars at the app's BTC/USD rate), Funds lists the two as rows with a Take out each, and sat
// eCash on a phone that holds dollars opens the sat balance as it is, with no price to change it.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  // Invite-only, as the live engine is: the second balance is opened with the first one's key.
  g = await startGateway({ env: { FORGE_UNITS: 'usd,sat' } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function api(path: string, body?: object, headers: Record<string, string> = {}) {
  const res = await fetch(`${g.url}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: (await res.json()) as any };
}
const auth = (key: string) => ({ authorization: `Bearer ${key}` });

/** A dollar balance with `cents` on it, and, with `sats`, its sat balance opened with the dollar key. */
async function balances(cents: number, sats = 0): Promise<{ usd: string; sat: string | null }> {
  const usd = await api('/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', cents), invite: createInvite(g) });
  if (!usd.body.key) throw new Error(`topup failed: ${JSON.stringify(usd.body)}`);
  if (!sats) return { usd: usd.body.key, sat: null };
  const sat = await api('/v1/wallet/topup', { token: await mintToken(MINT_A, 'sat', sats) }, { 'X-Forge-Sibling': usd.body.key });
  if (!sat.body.key) throw new Error(`sibling topup failed: ${JSON.stringify(sat.body)}`);
  return { usd: usd.body.key, sat: sat.body.key };
}

/** A phone keeping these keys: the first where a key always was, the second beside it. */
async function phone(first: string | null, second: string | null = null) {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  await ctx.addInitScript(
    ([a, b]) => {
      if (a && !localStorage.getItem('forge.balanceKey')) localStorage.setItem('forge.balanceKey', a);
      if (b && !localStorage.getItem('forge2.balanceKey2')) localStorage.setItem('forge2.balanceKey2', b);
    },
    [first, second],
  );
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { page, errors, close: () => ctx.close() };
}

const pill = (page: Page) => page.textContent('#balanceText');

describe('the home total', () => {
  it('shows one balance in its own unit, as before: dollars, or sats', async () => {
    const { usd } = await balances(150);
    const a = await phone(usd);
    await a.page.goto(`${g.url}/v2/`);
    await expect.poll(() => pill(a.page)).toBe('$1.50');
    expect(a.errors).toEqual([]);
    await a.close();

    // A phone whose only balance is in sats.
    const sat = await api('/v1/wallet/topup', { token: await mintToken(MINT_A, 'sat', 1200), invite: createInvite(g) });
    const b = await phone(sat.body.key);
    await b.page.goto(`${g.url}/v2/`);
    await expect.poll(() => pill(b.page)).toBe('1,200 sat');
    expect(b.errors).toEqual([]);
    await b.close();
  }, 60_000);

  it('shows both in dollars when both hold money: $1.00 and 2,000 sat at $100,000 make $3.00', async () => {
    const k = await balances(100, 2000);
    const { page, errors, close } = await phone(k.usd, k.sat);
    await page.goto(`${g.url}/v2/`);
    await expect.poll(() => pill(page)).toBe('$3.00');
    expect(await page.getAttribute('#ringsBtn', 'aria-label')).toMatch(/^Funds \$3\.00 left\./);
    // Tapping the total opens Funds, as before.
    await page.click('#balancePill');
    await page.waitForSelector('[data-screen=funds]');
    expect(errors).toEqual([]);
    await close();
  }, 60_000);
});

describe('Funds with two balances', () => {
  it('lists each as its own row with its own Take out, and the total in the ring', async () => {
    const k = await balances(100, 2000);
    const { page, errors, close } = await phone(k.usd, k.sat);
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('#fundRows:not([hidden])');
    expect(await page.textContent('#fundsAmount')).toBe('$3.00');
    const rows = await page.$$eval('#fundRows .fund-row', (els) => els.map((e) => ({ unit: (e as HTMLElement).dataset.unit, amount: e.querySelector('.fund-row-amount')?.textContent })));
    expect(rows).toEqual([
      { unit: 'usd', amount: '$1.00' },
      { unit: 'sat', amount: '2,000 sat' },
    ]);
    // Each row's sign is a picture, and its Take out names the amount.
    expect(await page.locator('#fundRows .fund-row .tile-ico svg').count()).toBe(2);
    expect(await page.getAttribute('#takeOut-sat', 'aria-label')).toBe('Take out 2,000 sat');
    // The card's own Take out is not shown: the rows have theirs.
    expect(await page.isVisible('#takeOutBtn')).toBe(false);
    expect(await page.isVisible('#refundable')).toBe(false);
    expect(errors).toEqual([]);
    await close();
  }, 60_000);

  it('shows no rows with one balance: the card as before, with its one Take out', async () => {
    const { usd } = await balances(100);
    const { page, errors, close } = await phone(usd);
    await page.goto(`${g.url}/v2/#/funds`);
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$1.00');
    expect(await page.isHidden('#fundRows')).toBe(true);
    expect(await page.isVisible('#takeOutBtn')).toBe(true);
    expect(await page.textContent('#refundable')).toBe('You can take out $1.00.');
    expect(errors).toEqual([]);
    await close();
  }, 60_000);

  it('takes out of one balance only, as eCash in its own unit', async () => {
    const k = await balances(100, 2000);
    const { page, errors, close } = await phone(k.usd, k.sat);
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('#takeOut-sat');
    await page.click('#takeOut-sat');
    await page.waitForSelector('[data-screen=takeOut] #outAll');
    expect(await page.textContent('#outAll')).toBe('All of it: 2,000 sat');
    expect(await page.isVisible('.amount-unit.after')).toBe(true);
    await page.fill('#outAmount', '500');
    await page.click('#outBtn');
    await page.waitForSelector('[data-token-id]');
    expect(await page.textContent('[data-token-id] b')).toBe('Here is 500 sat as eCash.');
    expect((await api('/v1/wallet', undefined, auth(k.sat!))).body.balance_msub).toBe(1_500_000);
    expect((await api('/v1/wallet', undefined, auth(k.usd))).body.balance_msub).toBe(100_000);
    // The dollar row's Take out gives dollars.
    await page.goto(`${g.url}/v2/#/funds/out/usd`);
    await expect.poll(() => page.textContent('#outAll')).toBe('All of it: $1.00');
    expect(errors).toEqual([]);
    await close();
  }, 60_000);
});

describe('sat eCash on a phone that holds dollars', () => {
  it('opens the sat balance as it is: no price to change it, no invite, and the dollar key stays where it was', async () => {
    const { usd } = await balances(100);
    const token = await mintToken(MINT_A, 'sat', 800);
    const { page, errors, close } = await phone(usd);
    const quotes: string[] = [];
    page.on('request', (r) => r.url().includes('/v1/wallet/fund/foreign/') && quotes.push(r.url()));
    await page.goto(`${g.url}/v2/#/funds/add/ecash`);
    await page.waitForSelector('[data-fund=ecash] #ecashToken');
    // No invite is asked: the phone has a balance.
    expect(await page.isHidden('#invite').catch(() => true)).toBe(true);
    await page.fill('#ecashToken', token);
    await page.click('#ecashAdd');
    await page.waitForSelector('#fundsAdded');
    expect(await page.textContent('#fundsAddedText')).toBe('Added 800 sat.');
    expect(quotes).toEqual([]);
    const keys = await page.evaluate(() => [localStorage.getItem('forge.balanceKey'), localStorage.getItem('forge2.balanceKey2')]);
    expect(keys[0]).toBe(usd);
    expect(keys[1]).toMatch(/^sk-forge-/);
    expect((await api('/v1/wallet', undefined, auth(keys[1]!))).body).toMatchObject({ unit: 'sat', balance_msub: 800_000 });
    // Both now hold money: the ring shows $1.80, the rows the two.
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$1.80');
    await page.waitForSelector('#fundRows:not([hidden])');
    expect(errors).toEqual([]);
    await close();
  }, 60_000);
});
