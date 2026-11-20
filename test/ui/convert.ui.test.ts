import { getEncodedToken } from '@cashu/cashu-ts';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, MINT_A, mintProofs, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { cameraArgs, cameraFile } from './camera.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { boxState, DOTS, seenAt } from './held.ts';

// eCash from the engine's own mint in the unit the funds do not hold (sats on dollar funds), on an engine
// that cannot open the sat balance beside the dollar one (no `sibling` among its funding methods, and
// invite-only): the eCash screen shows the price to change it, a yes adds what the price said, a no
// leaves the token as it was (docs/PAYMENTS.md, Changing units). An engine that opens the second balance
// takes such eCash as it is (two-balances.ui.test.ts). The local mints pay every invoice without moving money.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let plain: Browser;
const open: Browser[] = [];

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway();
  plain = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  for (const b of open) await b.close().catch(() => {});
  await plain?.close();
  await g?.close();
});

async function api(path: string, body?: object, key?: string) {
  const res = await fetch(`${g.url}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: (await res.json()) as any };
}

/** Dollar funds with $2.00 on them, opened through the API. */
async function dollarKey(): Promise<string> {
  const r = await api('/v1/wallet/topup', { token: await mintToken(MINT_A, 'usd', 200), invite: createInvite(g) });
  if (!r.body.key) throw new Error(`topup failed: ${JSON.stringify(r.body)}`);
  return r.body.key;
}

/** A phone with these dollar funds on it (and, for a scan, a camera that shows these codes). */
async function phone(key: string, codes: string[] = []) {
  const b = codes.length ? await chromium.launch({ channel: 'chrome', headless: true, args: cameraArgs(cameraFile(codes)) }) : plain;
  if (codes.length) open.push(b);
  const ctx = await b.newContext(PHONE);
  await pastFirstRun(ctx);
  if (codes.length) await ctx.grantPermissions(['camera'], { origin: g.url });
  await ctx.addInitScript((k) => localStorage.setItem('forge.balanceKey', k), key);
  // An engine from before two balances: its funding methods do not offer to open the second one.
  await ctx.route('**/v1/wallet/fund/methods', async (route) => {
    const res = await route.fetch();
    const { sibling: _, ...methods } = await res.json();
    await route.fulfill({ response: res, json: methods });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const confirms: string[] = [];
  page.on('request', (r) => r.url().endsWith('/v1/wallet/fund/foreign/confirm') && confirms.push(r.url()));
  return { page, errors, confirms };
}

const vault = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.vault') ?? '{"in":[],"out":[]}'));

/** Pastes the token on the eCash screen and presses Add; resolves on the price. */
async function pasteForPrice(page: Page, token: string) {
  await page.goto(`${g.url}/v2/#/funds/add/ecash`);
  await page.waitForSelector('[data-fund=ecash] #ecashToken');
  await page.fill('#ecashToken', token);
  await page.click('#ecashAdd');
  await page.waitForSelector('#foreignConfirm');
}

describe('eCash in the other currency', () => {
  it('pasted sats on dollar funds: the price first, then Add changes them and names what was added', async () => {
    const key = await dollarKey();
    const token = await mintToken(MINT_A, 'sat', 1000);
    const { page, errors } = await phone(key);
    await pasteForPrice(page, token);
    // What is changed into what, the amount added in big type, where it comes from, the most the fees take.
    expect(await page.textContent('#convertWhat')).toMatch(/^Change to US dollars\./);
    const credit = (await page.textContent('#foreignCredit'))!;
    expect(credit).toMatch(/^\$0\.\d\d$/);
    expect(await page.textContent('#convertFrom')).toBe('From 1,000 sat');
    expect(await page.textContent('[data-fund=ecash] .fund-body')).toMatch(/Fees, at most: \d+ sat/);
    expect(await page.textContent('#foreignConfirm')).toBe(`Add ${credit}`);
    expect(await page.isVisible('#foreignNo')).toBe(true);
    // Nothing is held or sent before the yes.
    expect((await vault(page)).in).toEqual([]);

    await page.click('#foreignConfirm');
    await expect.poll(() => page.textContent('#foreignStatus'), { timeout: 40_000 }).toBe(`Added ${credit}.`);
    const cents = Math.round(Number(credit.slice(1)) * 100);
    expect((await api('/v1/wallet', undefined, key)).body.balance_msub).toBe((200 + cents) * 1000);
    // The token was taken (the vault let it go) and what the fees did not use is kept to save.
    expect((await vault(page)).in).toEqual([]);
    expect((await vault(page)).out.length).toBe(1);
    expect((await api('/v1/wallet/topup', { token, invite: createInvite(g) })).body.error.code).toBe('token_spent');
    await page.click('#fundDone');
    await page.waitForSelector('[data-screen=funds]');
    expect(errors).toEqual([]);
  }, 90_000);

  it('Keep my eCash: nothing is sent or kept, the token stays in the box, and it still adds elsewhere', async () => {
    const key = await dollarKey();
    const token = await mintToken(MINT_A, 'sat', 700);
    const { page, errors, confirms } = await phone(key);
    await pasteForPrice(page, token);
    await page.click('#foreignNo');
    await page.waitForSelector('#ecashAdd');
    // Pasted by the person: still shown as pasted.
    expect(await boxState(page)).toEqual({ value: token, held: false });
    expect(await page.textContent('[data-fund=ecash] .msg')).toMatch(/^Nothing was changed\./);
    expect(confirms).toEqual([]);
    expect((await vault(page)).in).toEqual([]);
    expect((await api('/v1/wallet', undefined, key)).body.balance_msub).toBe(200_000);
    // Unspent and usable: it opens sat funds of its own, all of it.
    const sat = await api('/v1/wallet/topup', { token, invite: createInvite(g) });
    expect(sat.status).toBe(200);
    expect(sat.body).toMatchObject({ unit: 'sat', credited: 700 });
    expect(errors).toEqual([]);
  }, 60_000);

  it('a scanned note in sats on dollar funds offers See the price, which opens the price on the eCash screen', async () => {
    const key = await dollarKey();
    const token = getEncodedToken({ mint: MINT_A, unit: 'sat', proofs: await mintProofs(MINT_A, 'sat', 500) }, { removeDleq: true });
    const { page, errors } = await phone(key, [token]);
    const priced: string[] = [];
    page.on('request', (r) => r.url().endsWith('/v1/wallet/fund/foreign/quote') && priced.push(JSON.parse(r.postData() ?? '{}').token));
    await page.goto(`${g.url}/v2/#/funds/add/note`);
    await page.waitForSelector('#noteConvert', { timeout: 20_000 });
    expect(await page.textContent('#noteResult')).toMatch(/^Other currency\. This note is in sats\./);
    expect(await seenAt(page, token)).toEqual([]);
    await page.click('#noteConvert');
    await page.waitForSelector('[data-fund=ecash] #foreignConfirm');
    expect(await page.textContent('#convertFrom')).toBe('From 500 sat');
    expect(await seenAt(page, token)).toEqual([]);
    // Keep my eCash: back to the box, which holds the handed-over note as dots, never as its text.
    await page.click('#foreignNo');
    await page.waitForSelector('#ecashAdd');
    expect(await boxState(page)).toEqual({ value: DOTS, held: true });
    expect(await seenAt(page, token)).toEqual([]);
    // Add prices the same note again.
    await page.click('#ecashAdd');
    await page.waitForSelector('[data-fund=ecash] #foreignConfirm');
    expect(priced).toEqual([token, token]);
    const credit = (await page.textContent('#foreignCredit'))!;
    await page.click('#foreignConfirm');
    await expect.poll(() => page.textContent('#foreignStatus'), { timeout: 40_000 }).toBe(`Added ${credit}.`);
    expect(errors).toEqual([]);
  }, 90_000);
});
