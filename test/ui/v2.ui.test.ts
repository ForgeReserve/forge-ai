import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, MINT_C, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { startOnchainMock } from '../e2e/onchain-mock.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay } from './ways.ts';

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
  await pastFirstRun(ctx);
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
    await expect.poll(() => page.textContent('#balanceText')).toBe('Add money');
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
    // With no money it carries the Add money mark: the choice opens Add money in place of the list.
    expect(await page.locator('[data-model="mock-slow"][data-poor]').count()).toBe(1);
    await page.click('[data-model="mock-slow"]');
    await page.waitForSelector('[data-screen=addFunds]');
    await page.goto(`${g.url}/v2/#/more/model`);
    expect(await page.getAttribute('[data-model="mock-slow"]', 'aria-checked')).toBe('true');
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    expect(await page.textContent('#privacyPill')).toContain('Standard');

    // Tap the rings: Funds and memory. Add funds, eCash, with the invite code.
    await tapRing(page);
    await page.waitForSelector('[data-screen=funds]');
    await page.click('#addFundsBtn');
    await openWay(page, 'ecash');
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
    // Markdown loads with the first answer screen and the answer shows as plain text until it is in
    // (screens/answer.js), so the text is read once it is drawn as Markdown, here and after the reload.
    const MARKDOWN = '#answerText:not(:has(> p.plain))';
    await page.waitForSelector(MARKDOWN);
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
    await page.waitForSelector(MARKDOWN);
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
    expect(await page.textContent('#answerError')).toContain('No answer, not charged. The model did not answer, so you were not charged.');
    expect(await page.textContent('#nextStep')).toBe('Try again');
    await ctx.close();
  }, 60_000);

  it("shows the engine's funds hold exactly, and says before sending when the funds do not cover it", async () => {
    const { ctx, page } = await phone();
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), await fundedKey(200));
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await chooseModel(page, 'mock-echo');
    await page.click('#btn-type');
    await page.fill('#question', 'What should I bring on Saturday?');
    const shown = Number(await page.getAttribute('#priceLine', 'data-msub'));
    expect(shown).toBeGreaterThan(0);
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    let row: any;
    await expect
      .poll(() => (row = g.deps.db.prepare("SELECT reserved_msub FROM requests WHERE model = 'mock-echo' ORDER BY created_at DESC, rowid DESC LIMIT 1").get()))
      .toBeTruthy();
    expect(row.reserved_msub).toBe(shown);

    // 20 cents does not cover this model's hold (256 output tokens at $1000 per million is 25.6 cents).
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), await fundedKey(20));
    await page.goto(`${g.url}/v2/#/`);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).toBe('$0.20');
    await page.click('#btn-type');
    await page.fill('#question', 'And on Sunday?');
    await expect.poll(() => page.textContent('#typeNotice')).toContain('Not enough funds. This question costs more than your funds can hold for it.');
    expect(await page.isDisabled('#sendBtn')).toBe(true);
    await page.click('#noticeBtn');
    await page.waitForSelector('[data-screen=addFunds]');
    await ctx.close();
  }, 60_000);

  it('carries a v1 balance over, and adds a file to the next question', async () => {
    const { ctx, page } = await phone();
    const key = await fundedKey();
    // v1 (the Classic page at /classic/) stores the key; v2 on the same origin reads the same one.
    await page.goto(`${g.url}/classic/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    // v1's worker has the whole origin until v2's own takes /v2/ over. That first takeover is not a new
    // build of v2, so the page must not reload under the person's finger (it once did, when v1's worker
    // was ready in time: a tap on Add was lost on a slow machine).
    await page.evaluate(() => navigator.serviceWorker.ready.then(() => null));
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    await page.evaluate(() => ((window as any).__sameLoad = true));
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? '').catch(() => ''), { timeout: 15_000 }).toMatch(/\/v2\/sw\.js$/);
    await page.waitForTimeout(500); // a window for a reload not to happen
    expect(await page.evaluate(() => (window as any).__sameLoad === true)).toBe(true);
    await expect.poll(() => page.textContent('#balanceText')).toBe('$2.00');

    await page.click('#btn-add');
    await page.waitForSelector('#addSheet');
    expect(await page.locator('#addSheet .row').count()).toBe(2); // Photo and File only
    await page.setInputFiles('#fileInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Bring water and a paper map.') });
    await page.waitForSelector('#heldLine:not([hidden])');
    expect(await page.textContent('#heldLine')).toBe('1 added to your question');
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
    await openWay(page, 'lightning');
    await page.waitForSelector('[data-fund=lightning]');
    await page.fill('#invite', createInvite(g));
    // Lightning lands in the sat balance (docs/PAYMENTS.md, Two balances): the amount is in sats.
    expect(await page.isVisible('.amount-unit.after')).toBe(true);
    await page.fill('#lnAmount', '1000');
    await page.click('#lnCreate');
    await page.waitForSelector('.qr svg');
    // The local mint's fake Lightning backend pays at once; polling sees it and credits the balance.
    await expect.poll(() => page.textContent('#lnStatus'), { timeout: 20_000 }).toBe('Paid. Added 1,000 sat.');
    await page.click('#fundDone');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('1,000 sat');
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

describe('v2 money paths in a phone-sized browser', () => {
  /** An SSE body as the gateway sends it. */
  const sseBody = (...events: string[]) => events.join('');
  const errorEvent = `data: ${JSON.stringify({ error: { message: 'upstream stream failed: reset', type: 'upstream_error' } })}\n\n`;
  const forgeEvent = (charged: number) => `event: forge\ndata: ${JSON.stringify({ request_id: 'r', unit: 'usd', charged_msub: charged, balance_msub: 200_000 - charged, partial: true })}\n\n`;

  it('says what a broken answer cost, and claims "not charged" only when the engine said so', async () => {
    const { ctx, page, errors } = await phone();
    const key = await fundedKey();
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    await chooseModel(page, 'mock-echo');
    // The answer stream is replaced by what the gateway sends when the model fails midway.
    let reply = sseBody(errorEvent, forgeEvent(1234));
    await page.route('**/v1/chat/completions', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: reply }));
    const ask = async (q: string) => {
      await page.goto(`${g.url}/v2/#/type`);
      await page.waitForSelector('[data-screen=type]');
      await page.fill('#question', q);
      await page.click('#sendBtn');
      await page.waitForSelector('#answerError:not([hidden])');
      return (await page.textContent('#answerError')) ?? '';
    };
    // Charged: the engine's final event came after the error.
    let words = await ask('First?');
    expect(words).toMatch(/^Stopped early, cost 1\.23 cents\. The model stopped before the answer was done\./);
    expect(words).not.toContain('not charged');
    // Not charged: the engine said 0.
    reply = sseBody(errorEvent, forgeEvent(0));
    words = await ask('Second?');
    expect(words).toContain('No answer, not charged. The model did not answer, so you were not charged.');
    // No final event at all: no claim either way.
    reply = sseBody(errorEvent);
    words = await ask('Third?');
    expect(words).toContain('No answer. The model did not answer. Check your funds.');
    expect(words).not.toContain('not charged');
    // An empty answer the engine charged for (a reasoning model that spent it all on reasoning).
    reply = sseBody(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { reasoning_content: 'thinking' } }] })}\n\n`, 'data: [DONE]\n\n', forgeEvent(500).replace(',"partial":true', ''));
    words = await ask('Fourth?');
    expect(words).toMatch(/^Stopped early, cost 0\.500 cents\. /);

    // The answer screen's button reads Hold to talk, with the same hint as the home button.
    expect(await page.textContent('#replyBtn')).toContain('Hold to talk');
    const hint = await page.getAttribute('#replyBtn', 'aria-describedby');
    expect(await page.textContent(`#${hint}`)).toBe('Voice comes soon. Type your question for now.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('collects a refund the engine issued later (202), even when the first refunds list failed', async () => {
    const { ctx, page } = await phone();
    const key = await fundedKey();
    let refunds: 'fail' | 'owed' | 'done' = 'fail';
    await page.route('**/v1/wallet/refunds', (route) =>
      refunds === 'fail'
        ? route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: { code: 'internal', message: 'boom' } }) })
        : route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: [{ id: 'out_later', status: refunds, token: refunds === 'done' ? 'cashuBlaterrefund' : null, amount: 100, unit: 'usd' }] }) }),
    );
    await page.route('**/v1/wallet/refund', (route) => route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ id: 'out_later', token: null, amount: 100, unit: 'usd', status: 'owed' }) }));
    await page.goto(`${g.url}/v2/`);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
    await page.goto(`${g.url}/v2/#/funds/out`);
    await page.waitForSelector('[data-screen=takeOut]');
    await expect.poll(() => page.inputValue('#outAmount')).toBe('2.00');
    await page.fill('#outAmount', '1.00');
    await page.click('#outBtn');
    await expect.poll(() => page.textContent('[role=status].msg')).toContain('Open this screen again in a minute');
    // Still owed: nothing to show yet.
    refunds = 'owed';
    await page.goto(`${g.url}/v2/#/funds`);
    await page.goto(`${g.url}/v2/#/funds/out`);
    await page.waitForSelector('[data-screen=takeOut]');
    await page.waitForTimeout(500);
    expect(await page.locator('.token-card').count()).toBe(0);
    // Issued: offered on the next visit.
    refunds = 'done';
    await page.goto(`${g.url}/v2/#/funds`);
    await page.goto(`${g.url}/v2/#/funds/out`);
    await page.waitForSelector('.token-card[data-token-id=out_later]');
    expect(await page.textContent('.token-card b')).toBe('Here is $1.00 as eCash.');
    await ctx.close();
  }, 60_000);

  it('adds eCash from another mint; the outcome lands even after leaving the screen mid-way', async () => {
    const up = await fetch(`${MINT_C}/v1/info`).then((r) => r.ok).catch(() => false);
    if (!up) throw new Error('The local test mint C is not running. Start the mints with pnpm mint:up.');
    const gf = await startGateway({ env: { FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_INVITE_ONLY: 'false' } });
    const { ctx, page, errors } = await phone();
    try {
      await page.goto(`${gf.url}/v2/#/funds/add`);
      await openWay(page, 'othermint');
      await page.waitForSelector('[data-fund=othermint]');
      await page.fill('#foreignToken', await mintToken(MINT_C, 'sat', 1000));
      await page.click('#foreignCheck');
      await page.waitForSelector('#foreignConfirm');
      // The engine takes the token, but the phone hears "in_flight" (being processed): the token must
      // stay pending, not be marked as not taken.
      await page.route('**/v1/wallet/fund/foreign/confirm', async (route) => {
        await route.fetch();
        await route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: { code: 'in_flight', message: 'this funding is being processed' } }) });
      });
      await page.click('#foreignConfirm');
      await expect
        .poll(async () => JSON.parse((await page.evaluate(() => localStorage.getItem('forge2.vault')))!).in, { timeout: 20_000 })
        .toMatchObject([{ via: 'othermint', state: 'pending', code: 'in_flight', fundingId: expect.stringMatching(/.+/), engine: '' }]);
      // Leave at once: the fund screen's poller stops. Funds looks the funding up and settles it.
      await page.goto(`${gf.url}/v2/#/funds`);
      await page.waitForSelector('[data-screen=funds]');
      await expect
        .poll(
          async () => {
            const v = JSON.parse((await page.evaluate(() => localStorage.getItem('forge2.vault')))!);
            if (v.in.length) await page.reload(); // not settled yet: open Funds again
            return v;
          },
          { timeout: 30_000, interval: 1000 },
        )
        .toMatchObject({ in: [], out: [{ amount: null, token: expect.stringMatching(/^cashuB/) }] });
      // The change is only the unused fee: shown with no amount, never as the token's 1,000 sat.
      await page.reload();
      await page.waitForSelector('[data-screen=funds]');
      await expect.poll(() => page.textContent('#vaultBox')).toContain('eCash that came back');
      expect(await page.textContent('#vaultBox')).not.toMatch(/1,?000/);
      // The balance was credited.
      const key = await page.evaluate(() => localStorage.getItem('forge.balanceKey'));
      const w: any = await (await fetch(`${gf.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
      expect(w.balance_msub).toBeGreaterThan(0);
      await page.goto(`${gf.url}/v2/#/funds/out`);
      await page.waitForSelector('.token-card');
      expect(await page.textContent('.token-card b')).toBe('eCash that came back.');
      // The only console error is the browser logging the stubbed 409.
      expect(errors.filter((e) => !e.includes('status of 409'))).toEqual([]);
    } finally {
      await ctx.close();
      await gf.close();
    }
  }, 90_000);

  it('adds funds on-chain: address, confirmed deposit, balance; a usd balance is told to use another way', async () => {
    const mock = await startOnchainMock(MINT_A);
    const go = await startGateway({ env: { FORGE_TRUSTED_MINTS: mock.url, FORGE_ONCHAIN_ENABLED: 'true', FORGE_INVITE_ONLY: 'false' } });
    try {
      const { ctx, page, errors } = await phone();
      await page.goto(`${go.url}/v2/#/funds/add`);
      // Bitcoin waits on the More card, as a tile (a screenshot for the owner: .tmp/addfunds-c/).
      await page.waitForSelector('#more-onchain', { state: 'attached' });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.click('#tab-more');
      mkdirSync(join(import.meta.dirname, '../../.tmp/addfunds-c'), { recursive: true });
      await page.waitForTimeout(400);
      await page.screenshot({ path: join(import.meta.dirname, '../../.tmp/addfunds-c/card-7-more-with-bitcoin.png') });
      await openWay(page, 'onchain');
      await page.waitForSelector('#onchainGet');
      const created = page.waitForResponse((r) => r.url().endsWith('/v1/wallet/fund/onchain') && r.request().method() === 'POST');
      await page.click('#onchainGet');
      const f: any = await (await created).json();
      await page.waitForSelector('.qr svg');
      expect(await page.textContent('.keyline')).toBe(f.request.match(/.{1,4}/g).join(' '));
      expect(await page.textContent('[data-fund=onchain] .status-line')).toBe('Watching the address');
      // The deposit confirms at the mint; the engine mints and credits it.
      const quote = go.deps.funding.get(f.id)!.quote!;
      await go.deps.funding.advance(f.id);
      mock.pay(quote, 20_000);
      await go.deps.funding.advance(f.id);
      // The screen polls every 15 seconds.
      await expect.poll(() => page.textContent('[data-fund=onchain] .status-line'), { timeout: 30_000 }).toBe('Added 20,000 sat. More sent to this address is added too.');
      // The success panel, with the address and its Copy under it (it takes more), Ask now and Done.
      expect(await page.textContent('#fundAdded .added-amount')).toBe('+20,000 sat');
      await expect.poll(() => page.textContent('#fundAdded .added-bal')).toBe('20,000 sat');
      expect(await page.textContent('[data-fund=onchain] .keyline')).toBe(f.request.match(/.{1,4}/g).join(' '));
      expect(await page.isVisible('#fundAsk')).toBe(true);
      await page.goto(`${go.url}/v2/#/funds`);
      await expect.poll(() => page.textContent('#fundsAmount')).toBe('20,000 sat');
      expect(errors).toEqual([]);
      await ctx.close();

      // A balance in US dollars cannot take an on-chain deposit on an engine that cannot open the sat
      // balance beside it: invite-only, with no `sibling` among its ways to pay (docs/PAYMENTS.md, Two
      // balances). An engine that opens it, or one that needs no invite, takes the deposit on sats.
      const usd = await phone();
      await usd.page.route('**/v1/wallet/fund/methods', async (route) => {
        const res = await route.fetch();
        const { sibling: _, ...methods } = await res.json();
        await route.fulfill({ response: res, json: { ...methods, invite_only: true } });
      });
      await usd.page.route('**/v1/models', async (route) => {
        const res = await route.fetch();
        await route.fulfill({ response: res, json: { ...(await res.json()), invite_only: true } });
      });
      await usd.page.route('**/v1/wallet', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ unit: 'usd', balance_msub: 100_000, available_msub: 100_000 }) }));
      await usd.page.goto(`${go.url}/v2/`);
      await usd.page.evaluate(() => localStorage.setItem('forge.balanceKey', 'sk-forge-usd-test'));
      await usd.page.goto(`${go.url}/v2/#/`);
      await expect.poll(() => usd.page.textContent('#balanceText')).toBe('$1.00');
      await usd.page.goto(`${go.url}/v2/#/funds/add`);
      await openWay(usd.page, 'onchain');
      await usd.page.waitForSelector('[data-fund=onchain]');
      expect(await usd.page.textContent('[data-fund=onchain] .fund-body')).toBe('Not for dollar funds. On-chain deposits add to a sat balance. Your funds are in US dollars, so use Lightning or eCash.');
      expect(await usd.page.locator('#onchainGet').count()).toBe(0);
      // Never a dead end (owner, 2026-11-17: "the on-chain bitcoin option doesn't seem to have any
      // functionality"): the one way forward is a button, and it opens Lightning.
      await usd.page.click('#onchainUseLightning');
      await usd.page.waitForSelector('[data-fund=lightning]');
      expect(usd.errors).toEqual([]);
      await usd.ctx.close();
    } finally {
      await go.close();
      await mock.close();
    }
  }, 90_000);
});

/** A balance key funded with $2.00 through the API, as v1 would have. */
async function fundedKey(cents = 200): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', cents);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}
