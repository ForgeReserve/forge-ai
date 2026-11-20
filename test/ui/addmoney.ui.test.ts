import { getEncodedToken } from '@cashu/cashu-ts';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { creditMintUp, type Gateway, MINT_A, MINT_B, MINT_C, MINT_CREDIT, mintProofs, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { cameraArgs, cameraFile } from './camera.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay } from './ways.ts';

// The add money flow as one family (rehearsal of 2026-11-17, screenshots under .tmp/polish-shots/): each
// way's screen has its card's picture at the top and one lit button, fields a phone does not zoom into,
// nothing that scrolls sideways on a 360 px phone, and one success panel with the amount, the funds now
// and Ask now. Then the faults the rehearsal found: a way's screen opened by its address, the way on from
// a refusal, and a refused payment said as an error.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;
const cameras: Browser[] = [];

beforeAll(async () => {
  if (!(await mintsUp()) || !(await creditMintUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_CREDIT_MINT: MINT_CREDIT, FORGE_FAUCET_ENABLED: 'true', FORGE_FAUCET_POW_BITS: '10', FORGE_FAUCET_POW_MAX_BITS: '12', FORGE_FAUCET_PER_ADDRESS: '0' },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  for (const b of cameras) await b.close().catch(() => {});
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

/** A phone that has seen the first run, with these funds on it (or none); codes: what its camera shows. */
async function phone(key: string | null = null, { viewport = PHONE.viewport, codes = null as string[] | null } = {}) {
  let b = browser;
  if (codes) {
    b = await chromium.launch({ channel: 'chrome', headless: true, args: cameraArgs(cameraFile(codes)) });
    cameras.push(b);
  }
  const ctx = await b.newContext({ ...PHONE, viewport });
  if (codes) await ctx.grantPermissions(['camera'], { origin: g.url });
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

/**
 * How the screen holds together: what scrolls sideways, the lit buttons in view, the fields under 16px
 * (an iPhone zooms into them) and the targets under 48 px. Runs in the page.
 */
const look = (page: Page) =>
  page.evaluate(() => {
    const main = document.querySelector('main')!;
    const shown = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden' && !e.closest('[hidden]');
    };
    const wide = (e: Element) => e.scrollWidth > e.clientWidth + 1 && ['auto', 'scroll'].includes(getComputedStyle(e).overflowX);
    return {
      sideways: document.documentElement.scrollWidth > innerWidth + 1 || [...main.querySelectorAll('*')].some(wide),
      lit: [...main.querySelectorAll('.btn.primary')].filter(shown).map((b) => b.id || b.textContent!.trim()),
      smallFields: [...main.querySelectorAll('input, textarea')].filter(shown).filter((f) => parseFloat(getComputedStyle(f).fontSize) < 16).map((f) => f.id),
      small: [...main.querySelectorAll('button, a.btn')].filter(shown).filter((b) => {
        const r = b.getBoundingClientRect();
        return r.width < 47.5 || r.height < 47.5;
      }).map((b) => b.id || b.className),
    };
  });

/** The success panel on a way's screen: the amount, its words, the funds now, Ask now lit and Done. */
async function panelHere(page: Page, amount: string, funds: string) {
  await page.waitForSelector('#fundAdded', { timeout: 40_000 });
  expect(await page.textContent('#fundAdded .added-amount')).toBe(`+${amount}`);
  expect(await page.textContent('#fundAdded .added-words')).toContain(`Added ${amount}.`);
  await expect.poll(() => page.textContent('#fundAdded .added-bal')).toBe(funds);
  expect((await look(page)).lit).toEqual(['fundAsk']);
  expect(await page.textContent('#fundAsk')).toBe('Ask now');
  expect(await page.isVisible('#fundDone')).toBe(true);
}

/** The success panel at the top of Funds, after a way went back there: the amount, its words, and Ask now under it. */
async function panelOnFunds(page: Page, amount: string, words: string) {
  await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 30_000 });
  expect(await page.textContent('#fundsAdded .added-amount')).toBe(amount);
  expect(await page.textContent('#fundsAddedText')).toBe(words);
  expect(await page.isVisible('#fundsAsk')).toBe(true);
  // Ask now is right under the panel: the next step, before the ring.
  const panel = (await page.locator('#fundsAdded').boundingBox())!;
  const ask = (await page.locator('#fundsAsk').boundingBox())!;
  expect(ask.y).toBeGreaterThan(panel.y + panel.height - 1);
  expect(ask.y - (panel.y + panel.height)).toBeLessThan(40);
  // No toast says it a second time.
  expect(await page.locator('#toast.show').count()).toBe(0);
}

describe('Add money: one family', () => {
  it.each([
    { width: 360, height: 640 },
    { width: 390, height: 844 },
  ])('each way at $width by $height: its picture on top, one lit button, fields of 16px, nothing sideways, 48 px targets', async (viewport) => {
    const { ctx, page, errors } = await phone(await dollarKey(), { viewport });
    for (const id of ['note', 'lightning', 'card', 'fedimint', 'ecash', 'free']) {
      await page.goto(`${g.url}/v2/#/funds/add`);
      await openWay(page, id);
      await page.waitForSelector(`[data-fund=${id}]`);
      // The card ways draw the printed card; on the website the camera does not start, so the note
      // offers the paste box.
      await page.waitForSelector(['card', 'fedimint'].includes(id) ? '.card-art' : '.way-hero', { state: 'visible' });
      if (id === 'note') await page.waitForSelector('#noteRead');
      const m = await look(page);
      expect(m.sideways, id).toBe(false);
      expect(m.lit, id).toHaveLength(1);
      expect(m.smallFields, id).toEqual([]);
      expect(m.small, id).toEqual([]);
    }
    await page.goto(`${g.url}/v2/#/funds/out`);
    await page.waitForSelector('#outAmount');
    await page.waitForSelector('.take-out .way-hero', { state: 'visible' });
    expect(await look(page)).toEqual({ sideways: false, lit: ['outBtn'], smallFields: [], small: [] });
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it("Lightning: the success panel takes the paid invoice's place, with the funds now, Ask now and Done", async () => {
    const { ctx, page, errors } = await phone(await dollarKey());
    await openFund(page, 'lightning');
    // Lightning lands in sats, on the sat balance opened beside the dollars; the funds now are the total.
    await page.fill('#lnAmount', '1000');
    await page.click('#lnCreate');
    await panelHere(page, '1,000 sat', '$3.00');
    expect(await page.textContent('#lnStatus')).toBe('Paid. Added 1,000 sat.');
    // The paid invoice is gone.
    expect(await page.locator('[data-fund=lightning] .qr').count()).toBe(0);
    expect((await look(page)).sideways).toBe(false);
    // Ask now opens the home.
    await page.click('#fundAsk');
    await page.waitForSelector('[data-screen=home]');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('eCash from another mint: the price as one card in the eCash box, then the success panel; sats from the engine go on as they are', async () => {
    const { ctx, page, errors } = await phone(await dollarKey());
    await openFund(page, 'ecash');
    // Sats from another mint go to the sat balance (docs/PAYMENTS.md, Two balances), opened beside the dollars.
    await page.fill('#ecashToken', await mintToken(MINT_C, 'sat', 1000));
    await page.click('#ecashAdd');
    await page.waitForSelector('.price-card #foreignCredit', { timeout: 20_000 });
    expect((await look(page)).lit).toEqual(['foreignConfirm']);
    expect((await look(page)).sideways).toBe(false);
    const credit = (await page.textContent('#foreignCredit'))!;
    expect(credit).toMatch(/^\d+ sat$/);
    await page.click('#foreignConfirm');
    // The funds now are the total in dollars: $2.00 and the sats at $100,000 a bitcoin (0.1 cent a sat).
    const total = 200_000 + Number(credit.split(' ')[0]) * 100;
    await panelHere(page, credit, `$${(total / 100_000).toFixed(total % 1000 === 0 ? 2 : 3)}`);
    expect(await page.textContent('#foreignStatus')).toBe(`Added ${credit}.`);

    // eCash in sats from the engine's own mint on dollar funds: added to the sat balance as it is, no
    // price to change it, and Funds says so in the same panel.
    await openFund(page, 'ecash');
    await page.fill('#ecashToken', await mintToken(MINT_A, 'sat', 1000));
    await page.click('#ecashAdd');
    await panelOnFunds(page, '+1,000 sat', 'Added 1,000 sat.');
    expect(await page.locator('.price-card').count()).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('eCash, a note and free questions go back to Funds, where the same panel says what was added', async () => {
    const key = await dollarKey();
    const { ctx, page, errors } = await phone(key);
    await openFund(page, 'ecash');
    await page.fill('#ecashToken', await mintToken(MINT_A, 'usd', 100));
    await page.click('#ecashAdd');
    await panelOnFunds(page, '+$1.00', 'Added $1.00.');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$3.00');
    // Once: back on Funds later, the panel is gone.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    expect(await page.locator('#fundsAdded').count()).toBe(0);
    await ctx.close();

    const scan = await phone(key, { codes: [getEncodedToken({ mint: MINT_A, unit: 'usd', proofs: await mintProofs(MINT_A, 'usd', 150) }, { removeDleq: true })] });
    await openFund(scan.page, 'note');
    await scan.page.waitForSelector('#noteAdd', { timeout: 20_000 });
    expect((await look(scan.page)).lit).toEqual(['noteAdd']);
    await scan.page.click('#noteAdd');
    await panelOnFunds(scan.page, '+$1.50', 'Added $1.50.');
    expect(scan.errors).toEqual([]);
    await scan.ctx.close();

    const free = await phone(key);
    await openFund(free.page, 'free');
    await free.page.waitForSelector('#freeGet:not([disabled])');
    await free.page.click('#freeGet');
    // Free questions are not money: no plus.
    await panelOnFunds(free.page, '3 free questions', 'Added 3 free questions.');
    expect(free.errors).toEqual([]);
    expect(errors).toEqual([]);
    await free.ctx.close();
  }, 120_000);
});

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

  it("eCash from another mint is priced in the eCash box; the engine's own eCash is added at once", async () => {
    const { ctx, page, errors } = await phone(await dollarKey());
    await openFund(page, 'ecash');
    await page.fill('#ecashToken', await mintToken(MINT_B, 'usd', 20));
    await page.click('#ecashAdd');
    // The price, in the same box: no other screen.
    await page.waitForSelector('[data-fund=ecash] #foreignConfirm', { timeout: 20_000 });
    expect(await page.locator('#ecashOtherMint').count()).toBe(0);
    await page.click('#foreignNo');

    await openFund(page, 'ecash');
    await page.fill('#ecashToken', await mintToken(MINT_A, 'usd', 30));
    await page.click('#ecashAdd');
    // Added at once: back on Funds with the 30 cents.
    await page.waitForSelector('[data-screen=funds]', { timeout: 20_000 });
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$2.30');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a refused other-mint payment is said as an error', async () => {
    const { ctx, page, errors } = await phone(await dollarKey());
    await openFund(page, 'ecash');
    await page.fill('#ecashToken', await mintToken(MINT_C, 'sat', 500));
    await page.click('#ecashAdd');
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
