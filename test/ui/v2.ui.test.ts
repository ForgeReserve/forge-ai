import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';

// The v2 app driven in a phone-sized browser: the installed Chrome (channel 'chrome', no browser
// download), a local gateway with the mock supplier, and the local test mints (pnpm mint:up).
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

async function phone(opts: object = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ ...PHONE, ...opts });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page, errors };
}

/** Taps the gold ring itself (the talk button sits in the middle of the ring area). */
async function tapRing(page: Page) {
  const box = (await page.locator('#ringsBtn').boundingBox())!;
  await page.locator('#ringsBtn').click({ position: { x: 16, y: box.height / 2 } });
}

const ringFill = (page: Page) => page.locator('.home-rings .rings-svg').getAttribute('data-funds').then(Number);

async function chooseModel(page: Page, id: string) {
  await page.click('#btn-more');
  await page.click('#moreModel');
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click(`[data-model="${id}"]`);
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
}

describe('v2 in a phone-sized browser', () => {
  it('funds with a test token, asks a typed question, streams the answer and moves the gold ring', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).toBe('Add funds');
    await expect.poll(() => page.textContent('#privacyPill')).toContain('Private');
    expect(await page.textContent('#talkBtn')).toContain('Hold to talk');

    // Private only is on by default: only the private (enclave) model is listed.
    await page.click('#btn-more');
    expect(await page.textContent('#btn-more')).toContain('Close');
    await page.click('#moreModel');
    await page.waitForSelector('[data-screen=model]');
    expect(await page.getAttribute('#privateOnly', 'aria-checked')).toBe('true');
    expect(await page.locator('[data-model]').evaluateAll((n) => n.map((x) => x.getAttribute('data-model')))).toEqual(['tinfoil/enc-model']);
    expect(await page.isVisible('#hiddenNote')).toBe(true);
    await page.click('#privateOnly');
    await page.click('[data-model="mock-slow"]');
    expect(await page.getAttribute('[data-model="mock-slow"]', 'aria-checked')).toBe('true');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    expect(await page.textContent('#privacyPill')).toContain('Standard');

    // Tap the rings: Funds and memory. Add funds, eCash, with the invite code.
    await tapRing(page);
    await page.waitForSelector('[data-screen=funds]');
    await page.click('#addFundsBtn');
    await page.waitForSelector('[data-screen=addFunds]');
    expect(await page.locator('#fund-ecash').isVisible()).toBe(true);
    await page.click('#fund-ecash');
    const token = await mintToken(MINT_A, 'usd', 500);
    let vaultInFlight: string | null = null;
    await page.route('**/v1/wallet/topup', async (route) => {
      vaultInFlight = await page.evaluate(() => localStorage.getItem('forge2.vault'));
      await route.continue();
    });
    await page.fill('#ecashToken', token);
    await page.click('#ecashAdd');
    expect(await page.textContent('[role=status].msg')).toContain('invite');
    await page.fill('#invite', invite);
    await page.click('#ecashAdd');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$5.00');
    // The token was on the phone while it was being sent, and is gone once credited.
    expect(vaultInFlight).toContain(token);
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('forge2.vault')))!).in).toEqual([]);
    // The balance key is stored where v1 keeps it.
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toMatch(/^sk-forge-/);

    await page.click('.back-head .round');
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).toBe('$5.00');
    await expect.poll(() => ringFill(page)).toBe(942);

    // Type, with the price shown before sending.
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', 'What should I bring on Saturday?');
    expect(await page.textContent('#priceLine')).toMatch(/Price(Under|Up to) \$\d+\.\d\d/);
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    expect(await page.textContent('.asked')).toBe('What should I bring on Saturday?');
    // It streams: Stop shows while the answer grows.
    await page.waitForSelector('#stopBtn');
    await expect.poll(async () => ((await page.textContent('#answerText')) ?? '').length).toBeGreaterThan(20);
    const mid = ((await page.textContent('#answerText')) ?? '').length;
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    const text = (await page.textContent('#answerText')) ?? '';
    expect(text.length).toBeGreaterThan(mid);
    expect(text.startsWith('Forge word word')).toBe(true);
    expect(await page.textContent('#answerNote')).toMatch(/^That cost /);
    expect(await page.isVisible('#againBtn')).toBe(true);

    // Copy puts the answer on the clipboard.
    await page.click('#copyBtn');
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.trim()).toBe(text.trim());

    // The gold ring moved and the balance went down.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => ringFill(page)).toBeLessThan(942);
    expect(await page.textContent('#balanceText')).not.toBe('$5.00');

    // Reloaded (as after the tab was killed), the answer is still there.
    await page.goto(`${g.url}/v2/#/answer`);
    await page.reload();
    await page.waitForSelector('[data-screen=answer]');
    expect(await page.textContent('#answerText')).toBe(text);

    // The v2 worker controls /v2/ only.
    expect(await page.evaluate(() => navigator.serviceWorker.ready.then((r) => r.scope))).toBe(`${g.url}/v2/`);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('shows an error in plain words with one next step', async () => {
    const { ctx, page } = await phone();
    const key = await fundedKey();
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await chooseModel(page, 'mock-fail');
    await page.click('#btn-type');
    await page.fill('#question', 'Will this work?');
    await page.click('#sendBtn');
    await page.waitForSelector('#answerError:not([hidden])');
    expect(await page.textContent('#answerError')).toContain('The model did not answer. You were not charged.');
    expect(await page.textContent('#nextStep')).toBe('Try again');
    await ctx.close();
  }, 60_000);

  it('carries a v1 balance over, and adds a file to the next question', async () => {
    const { ctx, page } = await phone();
    const key = await fundedKey();
    // v1 stores the key; v2 on the same origin reads the same one.
    await page.goto(`${g.url}/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).toBe('$2.00');

    await page.click('#btn-add');
    await page.waitForSelector('#addSheet');
    expect(await page.locator('#addSheet .row').count()).toBe(2); // Photo and File only
    await page.setInputFiles('#fileInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Bring water and a paper map.') });
    await page.waitForSelector('#heldLine:not([hidden])');
    expect(await page.textContent('#heldLine')).toBe('1 added for the next question');
    await tapRing(page);
    await page.waitForSelector('[data-screen=funds]');
    expect(await page.textContent('#heldItems')).toContain('notes.txt');
    await page.click('#heldItems button');
    await expect.poll(() => page.textContent('#memoryNote')).toBe('Nothing is held yet.');
    await ctx.close();
  }, 60_000);

  it('adds funds with Lightning: invoice, payment seen, credited', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('[data-screen=addFunds]');
    await page.click('#fund-lightning');
    await page.waitForSelector('[data-fund=lightning]');
    await page.fill('#invite', createInvite(g));
    await page.fill('#lnAmount', '1.00');
    await page.click('#lnCreate');
    await page.waitForSelector('.qr svg');
    // The local mint's fake Lightning backend pays at once; polling sees it and credits the balance.
    await expect.poll(() => page.textContent('#lnStatus'), { timeout: 20_000 }).toBe('Paid. Added $1.00.');
    await page.click('#fundDone');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$1.00');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('takes funds out as eCash and keeps the token until the person saved it', async () => {
    const { ctx, page } = await phone();
    const key = await fundedKey();
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.goto(`${g.url}/v2/#/funds/out`);
    await page.waitForSelector('[data-screen=takeOut]');
    await expect.poll(() => page.inputValue('#outAmount')).toBe('2.00');
    await page.fill('#outAmount', '1.00');
    await page.click('#outBtn');
    await page.waitForSelector('.token-card');
    expect(await page.textContent('.token-card b')).toBe('Here is $1.00 as eCash.');
    const kept = JSON.parse((await page.evaluate(() => localStorage.getItem('forge2.vault')))!).out;
    expect(kept).toHaveLength(1);
    expect(kept[0].token).toMatch(/^cashuB/);
    expect(await page.inputValue('.token-card textarea')).toBe(kept[0].token);
    // Still there after a reload, until the person taps I saved it.
    await page.reload();
    await page.waitForSelector('.token-card');
    await page.click('[data-saved]');
    await page.waitForSelector('.token-card', { state: 'detached' });
    expect(JSON.parse((await page.evaluate(() => localStorage.getItem('forge2.vault')))!).out).toEqual([]);
    await page.goto(`${g.url}/v2/#/funds`);
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$1.00');
    await ctx.close();
  }, 60_000);

  it('works at 360 px wide with no sideways scrolling, and switches looks', async () => {
    const { ctx, page } = await phone({ viewport: { width: 360, height: 740 } });
    for (const route of ['', 'type', 'funds', 'funds/add', 'more', 'more/look', 'more/model']) {
      await page.goto(`${g.url}/v2/#/${route}`);
      await page.waitForSelector('[data-screen]');
      expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(360);
      const small = await page.locator('main button:visible').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 44 || r.height < 44)).length);
      expect(small, `touch targets on ${route}`).toBe(0);
    }
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.click('#look-midnight');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(11, 13, 16)');
    await page.waitForTimeout(300); // the choice is written to IndexedDB
    await page.reload();
    await page.waitForSelector('[data-screen=look]');
    expect(await page.getAttribute('#look-midnight', 'aria-checked')).toBe('true');
    await page.click('#look-light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 245, 241)');
    await ctx.close();
  }, 60_000);
});

/** A balance key funded with $2.00 through the API, as v1 would have. */
async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 200);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}
