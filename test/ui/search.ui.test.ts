import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Search the web (F6) in a phone-sized Chrome: the switch on Type and on the home for a model that can
// search, off by default, the honest line while it is on, the search fee in the price line, and off
// again once a question is sent. The request itself (options in the encrypted body, the header, the
// hold) is covered by test/unit/v2/engine.test.ts and test/e2e/web-search.e2e.test.ts.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const FEE_MSUB = 5000; // 0.05 USD at markup 1, in usd msub

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    editCatalog: (cat) => {
      cat.suppliers.tinfoil.web_search = { request_usd: 0.05, extra_input_tokens: 0, output_factor: 1 };
      cat.models.find((x: any) => x.id === 'tinfoil/enc-model').web_search = true;
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

describe('Search the web', () => {
  it('is off by default, says where the search goes while on, adds the fee to the price, and is off again after a question', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    const token = await mintToken(MINT_A, 'usd', 200);
    const key = (await (await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) })).json()).key;
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');

    // The home has it too, for a question asked by voice (once there are funds to pay for a search).
    await page.waitForSelector('#searchHome:visible');
    expect(await page.getAttribute('#searchHome', 'aria-checked')).toBe('false');

    await page.click('#btn-type');
    await page.fill('#question', 'What is on in town tonight?');
    expect(await page.getAttribute('#searchSwitch', 'aria-checked')).toBe('false');
    expect(await page.isVisible('#searchSwitchNote')).toBe(false);
    const off = Number(await page.getAttribute('#priceLine', 'data-msub'));
    await page.click('#searchSwitch');
    expect(await page.getAttribute('#searchSwitch', 'aria-checked')).toBe('true');
    expect(await page.textContent('#searchSwitchNote')).toBe('The sealed machine sends the search to a search service, which sees the search but not who asked.');
    const on = Number(await page.getAttribute('#priceLine', 'data-msub'));
    // The fee, plus the bytes the search options add to the question (82 bytes, 41 input tokens at the
    // test catalog's 100 USD per million, 10 msub each).
    expect(on - off).toBe(FEE_MSUB + 41 * 10);

    // Sent (here the private model cannot be reached: no sealed machine in the test), and it is off again.
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    expect(await page.getAttribute('#searchSwitch', 'aria-checked')).toBe('false');
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(412);
    await ctx.close();
  }, 60_000);

  it('is not on an empty home: a search is paid from the balance', async () => {
    const ctx = await browser.newContext({ ...PHONE, viewport: { width: 360, height: 640 } });
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.waitForTimeout(500);
    expect(await page.isVisible('#searchHome')).toBe(false);
    await ctx.close();
  }, 60_000);

  it('is not offered for a model that cannot search', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.click('#btn-more');
    await page.click('#moreModel');
    await page.click('#privateOnly');
    await page.click('[data-model="mock-echo"]');
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('[data-screen=type]');
    await page.waitForTimeout(300);
    expect(await page.isVisible('#searchSwitch')).toBe(false);
    await ctx.close();
  }, 60_000);
});
