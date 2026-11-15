import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintCredits } from '../../src/credits.ts';
import { creditMintUp, type Gateway, MINT_A, MINT_CREDIT, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { cameraArgs, cameraFile } from './camera.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Free questions in a phone-sized browser (docs/FREE-TIER.md): the Free questions row first in Add funds,
// the puzzle and the voucher, the lighter segment of the gold ring, "Free, 2 of 3 left", the ways
// forward when they run out, the /free page and a scanned voucher. The faucet's puzzle is set easy here.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;
const open: Browser[] = [];

beforeAll(async () => {
  if (!(await mintsUp()) || !(await creditMintUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: {
      FORGE_INVITE_ONLY: 'true',
      FORGE_CREDIT_MINT: MINT_CREDIT,
      FORGE_FREE_MODELS: 'mock-echo',
      FORGE_FAUCET_ENABLED: 'true',
      FORGE_FAUCET_POW_BITS: '10',
      FORGE_FAUCET_POW_MAX_BITS: '12',
      FORGE_FAUCET_PER_ADDRESS: '0',
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  for (const b of open) await b.close().catch(() => {});
  await browser?.close();
  await g?.close();
});

async function phone(b = browser): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await b.newContext(PHONE);
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page, errors };
}

/** The free model in the tests is a standard (mock) one, so Private only is turned off for it. */
async function chooseFreeModel(page: Page) {
  await page.click('#btn-more');
  await page.click('#moreModel');
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click('[data-model="mock-echo"]');
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
}

const vault = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.vault') ?? '{"in":[],"out":[]}'));
const ring = (page: Page, attr: string) => page.locator('.home-rings .rings-svg').getAttribute(attr).then(Number);

async function ask(page: Page, text: string) {
  await page.goto(`${g.url}/v2/#/type`);
  await page.waitForSelector('[data-screen=type]');
  await page.fill('#question', text);
  const price = await page.textContent('#priceLine');
  await page.click('#sendBtn');
  await page.waitForSelector('[data-screen=answer]');
  await page.waitForSelector('#copyBtn', { timeout: 20_000 });
  await expect.poll(() => page.textContent('#answerNote')).not.toBe('');
  return { price, note: await page.textContent('#answerNote') };
}

describe('free questions in a phone-sized browser', () => {
  it('Free questions is a tile on the More card of Add money; the puzzle gives 3 free questions, used first, then the ways forward', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await chooseFreeModel(page);

    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#more-free', { state: 'attached' });
    await page.click('#tab-more');
    expect(await page.locator('#way-more .way-tile').first().getAttribute('id')).toBe('more-free');
    expect(await page.getAttribute('#more-free', 'aria-label')).toBe('Free questions');

    let vaultInFlight: any = null;
    await page.route('**/v1/wallet/topup', async (route) => {
      vaultInFlight = await vault(page);
      await route.continue();
    });
    await page.click('#more-free');
    await page.waitForSelector('[data-fund=free]');
    await expect.poll(() => page.textContent('#freeToday')).toMatch(/^Free questions today: [\d,]+ left\.$/);
    expect(await page.textContent('#freeGet')).toBe('Get 3 free questions');
    await page.click('#freeGet');
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsFree')).toBe('3 free questions left.');
    // The voucher was kept on the phone while it was sent, on its way to the free balance.
    expect(vaultInFlight.in.map((x: any) => x.via)).toEqual(['free']);
    expect((await vault(page)).in).toEqual([]);
    // A free balance key of its own; no paid balance was opened, and no invite was needed.
    expect(await page.evaluate(() => localStorage.getItem('forge2.freeKey'))).toMatch(/^sk-forge-/);
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toBeNull();

    // Home: the pill counts free questions; the gold ring shows them as the lighter segment.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).toBe('3 free questions');
    await expect.poll(() => ring(page, 'data-free')).toBe(942);
    expect(await ring(page, 'data-funds')).toBe(0);
    const freeStroke = await page.locator('.home-rings .ring-free').evaluate((n) => getComputedStyle(n).stroke);
    const paidStroke = await page.locator('.home-rings .ring-fill:not(.ring-free)').first().evaluate((n) => getComputedStyle(n).stroke);
    expect(freeStroke).not.toBe(paidStroke);

    // Each question is free, and says how many are left.
    let r = await ask(page, 'What should I bring on Saturday?');
    expect(r.price).toBe('PriceFree, 3 of 3 left');
    expect(r.note).toBe('That was a free question. 2 left.');
    r = await ask(page, 'And on Sunday?');
    expect(r.price).toBe('PriceFree, 2 of 3 left');
    r = await ask(page, 'And on Monday?');
    expect(r.price).toBe('PriceFree, 1 of 3 left');
    expect(r.note).toBe('That was your last free question.');

    // Used up: the home and Type point to the three ways forward.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await page.waitForSelector('#otherWays:not([hidden])');
    expect(await page.textContent('#otherWays')).toBe('Free questions used up. See the ways forward');
    expect(await ring(page, 'data-free')).toBe(0);
    await page.goto(`${g.url}/v2/#/type`);
    await page.waitForSelector('#typeNotice:not([hidden])');
    expect(await page.textContent('#typeNotice')).toContain('Your free questions are used up.');
    expect(await page.isDisabled('#sendBtn')).toBe(true);
    await page.click('#noticeBtn');
    await page.waitForSelector('[data-screen=freeOut]');
    expect(await page.locator('#freeOutWays .row').evaluateAll((n) => n.map((x) => x.id))).toEqual(['freeOutWait', 'freeOutNote', 'freeOutMoney']);
    await expect.poll(() => page.textContent('#freeOutWait')).toContain('Get more free questions');
    await expect.poll(() => page.textContent('#freeOutWait')).toMatch(/Free questions today: [\d,]+ left\./);
    await page.click('#freeOutMoney');
    await page.waitForSelector('[data-screen=addFunds]');
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('the /free page gives a voucher as a QR code, and Add to Forge adds it in the app', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/free`);
    await page.waitForSelector('[data-screen=free]');
    await expect.poll(() => page.textContent('#freeToday')).toMatch(/^Free questions today: [\d,]+ left\.$/);
    await page.click('#freeGet');
    await page.waitForSelector('#voucher', { timeout: 30_000 });
    expect(await page.textContent('#voucher b')).toBe('3 free questions');
    expect(await page.getAttribute('#voucher', 'data-token')).toMatch(/^cashuB/);
    expect(await page.locator('#voucher .qr svg, #voucher .qr canvas, #voucher .qr img').count()).toBeGreaterThan(0);
    expect(await page.textContent('#voucher')).toContain('Free questions only, not money.');
    await page.click('#voucherAdd');
    await page.waitForURL('**/v2/#/funds');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsFree')).toBe('3 free questions left.');
    expect((await vault(page)).in).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('a pasted voucher goes on the free balance, and a paid balance keeps its money apart', async () => {
    const { ctx, page, errors } = await phone();
    const [voucher] = await mintCredits({ issueUrl: MINT_CREDIT, publicUrl: MINT_CREDIT, unit: 'usd', amounts: [2] });
    await page.goto(`${g.url}/v2/#/funds/add/ecash`);
    await page.waitForSelector('[data-fund=ecash]');
    // A voucher needs no invite, even on an invite-only engine.
    await page.fill('#ecashToken', voucher!);
    await page.click('#ecashAdd');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsFree')).toBe('2 free questions left.');
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toBeNull();

    // Paid money next to it: its own balance, and the paid amount is what the pill shows.
    await page.goto(`${g.url}/v2/#/funds/add/ecash`);
    await page.waitForSelector('[data-fund=ecash]');
    await page.fill('#ecashToken', await mintToken(MINT_A, 'usd', 200));
    await page.fill('#invite', g.deps.invites.create('ui').code);
    await page.click('#ecashAdd');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$2.00');
    expect(await page.textContent('#fundsFree')).toBe('2 free questions left.');
    const keys = await page.evaluate(() => [localStorage.getItem('forge.balanceKey'), localStorage.getItem('forge2.freeKey')]);
    expect(keys[0]).toMatch(/^sk-forge-/);
    expect(keys[1]).toMatch(/^sk-forge-/);
    expect(keys[0]).not.toBe(keys[1]);
    // With both, the gold ring shows the free segment and the paid one after it.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => ring(page, 'data-free')).toBeGreaterThan(0);
    expect(await ring(page, 'data-funds')).toBeGreaterThan(0);
    expect(errors).toEqual([]);
    await ctx.close();
  });

  it('a scanned voucher shows free questions, not an amount of money', async () => {
    const [voucher] = await mintCredits({ issueUrl: MINT_CREDIT, publicUrl: MINT_CREDIT, unit: 'usd', amounts: [3] });
    const b = await chromium.launch({ channel: 'chrome', headless: true, args: cameraArgs(cameraFile([voucher!])) });
    open.push(b);
    const ctx = await b.newContext(PHONE);
    await pastFirstRun(ctx);
    await ctx.grantPermissions(['camera'], { origin: g.url });
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.goto(`${g.url}/v2/#/funds/add/note`);
    await page.waitForSelector('#noteAmount', { timeout: 20_000 });
    expect(await page.textContent('#noteAmount')).toBe('3 free questions');
    expect(await page.textContent('#noteMint')).toBe('Free questions. Not money.');
    expect(await page.isVisible('#invite')).toBe(false);
    await page.click('#noteAdd');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsFree')).toBe('3 free questions left.');
    expect(errors).toEqual([]);
  });
});
