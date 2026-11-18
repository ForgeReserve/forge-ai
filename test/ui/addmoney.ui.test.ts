import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, MINT_A, MINT_B, MINT_C, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The add money flow from the rehearsal of 2026-11-17: a way's screen opened by its address, the way on
// from a refusal, and a refused payment said as an error.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true' } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

/** Dollar funds with this many cents on them, opened through the API. */
async function dollarKey(cents = 200): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', cents) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

/** A phone that has seen the first run, with these funds on it (or none). */
async function phone(key: string | null = null) {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  if (key) await ctx.addInitScript((k) => localStorage.setItem('forge.balanceKey', k), key);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/status of 40[0-9]/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

/** Opens a way's screen from Funds, once the balance is read (as a person reaches it). */
async function openFund(page: Page, id: string) {
  await page.goto(`${g.url}/v2/#/funds`);
  await page.waitForSelector('[data-screen=funds]');
  await page.waitForFunction(() => /\d/.test(document.querySelector('#fundsAmount')?.textContent ?? ''));
  await page.goto(`${g.url}/v2/#/funds/add/${id}`);
  await page.waitForSelector(`[data-fund=${id}]`);
}

describe('Add money: faults from the rehearsal', () => {
  it('a way opened by its address before the engine said its ways shows the way once they arrive', async () => {
    const { ctx, page, errors } = await phone();
    // The engine's ways arrive late: the screen is drawn before them.
    await page.route('**/v1/wallet/fund/methods', async (r) => {
      await new Promise((x) => setTimeout(x, 1500));
      await r.continue();
    });
    await page.goto(`${g.url}/v2/#/funds/add/lightning`);
    await page.waitForSelector('[data-fund=lightning] #lnAmount', { timeout: 15_000 });
    expect(await page.locator('text=Not available on this engine right now.').count()).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('eCash from another mint goes on to Other mint with the token; Other mint sends the engine its own eCash to eCash', async () => {
    const { ctx, page, errors } = await phone(await dollarKey());
    await openFund(page, 'ecash');
    await page.fill('#ecashToken', await mintToken(MINT_B, 'usd', 20));
    await page.click('#ecashAdd');
    await expect.poll(() => page.textContent('[data-fund=ecash] .msg')).toMatch(/^From another mint\./);
    expect(await page.textContent('#ecashOtherMint')).toBe('Other mint');
    await page.click('#ecashOtherMint');
    // Other mint has the token and shows its price at once.
    await page.waitForSelector('[data-fund=othermint] #foreignConfirm', { timeout: 20_000 });

    await openFund(page, 'othermint');
    const own = await mintToken(MINT_A, 'usd', 30);
    await page.fill('#foreignToken', own);
    await page.click('#foreignCheck');
    await expect.poll(() => page.textContent('[data-fund=othermint] .msg')).toMatch(/^Use eCash instead\./);
    expect(await page.textContent('#foreignUseEcash')).toBe('eCash');
    await page.click('#foreignUseEcash');
    // eCash adds it at once: back on Funds with the 30 cents.
    await page.waitForSelector('[data-screen=funds]', { timeout: 20_000 });
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$2.30');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a refused other-mint payment is said as an error', async () => {
    const { ctx, page, errors } = await phone(await dollarKey());
    await openFund(page, 'othermint');
    await page.fill('#foreignToken', await mintToken(MINT_C, 'sat', 500));
    await page.click('#foreignCheck');
    await page.waitForSelector('#foreignConfirm', { timeout: 20_000 });
    await page.route('**/v1/wallet/fund/foreign/confirm', (r) => r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'quote_expired', message: 'The price ran out.' } }) }));
    await page.click('#foreignConfirm');
    await page.waitForSelector('#foreignStatus.err');
    expect(await page.textContent('#foreignStatus')).toBe('That did not work. The price ran out.');
    // The eCash stays on the phone, marked not added, and Add can be pressed again.
    expect(await page.isEnabled('#foreignConfirm')).toBe(true);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
