import { getEncodedToken } from '@cashu/cashu-ts';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, MINT_A, MINT_B, mintProofs, mintsUp, startGateway } from '../e2e/helpers.ts';
import { cameraArgs, cameraFile } from './camera.ts';

// Paper notes in a phone-sized browser. The camera is Chrome's fake camera playing a video of the
// note's QR code, so the app's own camera adapter and v1's scanner read it as they would on a phone.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

/** A second address of the local mint, as mint.forge-reserve.com is of the Forge mint. */
const ALIAS_A = MINT_A.replace('127.0.0.1', 'localhost');

let g: Gateway;
let plain: Browser;
const open: Browser[] = [];

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_MINT_ALIASES: `${ALIAS_A}=${MINT_A}` } });
  plain = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  for (const b of open) await b.close().catch(() => {});
  await plain?.close();
  await g?.close();
});

/** A paper note as print-notes makes it: a token without DLEQ proofs. */
const note = async (mint: string, amount: number) => getEncodedToken({ mint, unit: 'usd', proofs: await mintProofs(mint, 'usd', amount) }, { removeDleq: true });

/** A phone whose camera shows these codes (one: a still code; several: an animated one). */
async function phoneWithCamera(codes: string[], viewport = PHONE.viewport) {
  const b = await chromium.launch({ channel: 'chrome', headless: true, args: cameraArgs(cameraFile(codes)) });
  open.push(b);
  const ctx = await b.newContext({ ...PHONE, viewport });
  await ctx.grantPermissions(['camera'], { origin: g.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { b, page, errors };
}

const foot = (page: Page) => page.textContent('.note-view .foot');

const vault = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.vault') ?? '{"in":[],"out":[]}'));
const ringFill = (page: Page) => page.locator('.home-rings .rings-svg').getAttribute('data-funds').then(Number);

describe('paper notes in a phone-sized browser', () => {
  it('with no funds the gold ring invites a scan; the note shows its amount and mint and adds on one tap', async () => {
    const token = await note(MINT_A, 300);
    const { page, errors } = await phoneWithCamera([token]);
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    // The ring invites a scan.
    await page.waitForSelector('#scanNote:not([hidden])');
    expect(await page.textContent('#scanNote')).toBe('Scan a note to add funds');
    expect(await page.getAttribute('.home-rings', 'class')).toContain('invite');
    // Right under the ring, so it is the next thing the eye and thumb reach.
    const ring = (await page.locator('.home-rings').boundingBox())!;
    const chip = (await page.locator('#scanNote').boundingBox())!;
    expect(chip.y - (ring.y + ring.height)).toBeLessThan(40);
    // The ring itself opens Funds and memory, where Scan a note comes first while there are no funds.
    const box = (await page.locator('#ringsBtn').boundingBox())!;
    await page.locator('#ringsBtn').click({ position: { x: 16, y: box.height / 2 } });
    await page.waitForSelector('[data-screen=funds]');
    await page.waitForSelector('#fundsScanNote:not([hidden])');
    await page.click('.back-head .round');
    await page.waitForSelector('[data-screen=home]');

    await page.click('#scanNote');
    await page.waitForSelector('[data-fund=note]');
    // The camera reads the note: amount and mint, before anything is sent.
    await page.waitForSelector('#noteAmount', { timeout: 20_000 });
    expect(await page.textContent('#noteAmount')).toBe('$3.00');
    expect(await page.textContent('#noteMint')).toBe('From 127.0.0.1:3338');
    expect(await page.textContent('#noteAdd')).toBe('Add $3.00');
    expect((await vault(page)).in).toEqual([]); // nothing held or sent yet

    let heldWhileSending: unknown = null;
    await page.route('**/v1/wallet/topup', async (route) => {
      heldWhileSending = await vault(page);
      await route.continue();
    });
    await page.click('#noteAdd');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$3.00');
    // The note's eCash was stored on the phone while it was sent, and removed once credited.
    expect(JSON.stringify(heldWhileSending)).toContain(token);
    expect((await vault(page)).in).toEqual([]);

    // Home: the gold ring is full and no longer invites a scan.
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => ringFill(page)).toBe(942);
    expect(await page.isHidden('#scanNote')).toBe(true);
    expect(await page.getAttribute('.home-rings', 'class')).not.toContain('invite');
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    expect(await page.isHidden('#fundsScanNote')).toBe(true);
    expect(errors).toEqual([]);
  }, 90_000);

  it('reads an animated code; Scan a note is first in Add funds', async () => {
    const token = await note(MINT_A, 200);
    // The parts of an animated code, made by the same encoder the app uses to show one.
    const p = await plain.newPage();
    await p.goto(`${g.url}/v2/`);
    const parts: string[] = await p.evaluate(async (tok) => {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = '/vendor/bcur.js';
        s.onload = res;
        s.onerror = rej;
        document.head.append(s);
      });
      const enc = (window as any).BCUR.encoder(tok, 120);
      return Array.from({ length: enc.count() * 2 }, () => enc.next());
    }, token);
    await p.close();
    expect(parts.length).toBeGreaterThan(4);
    expect(parts[0]).toMatch(/^ur:/i);

    const { page, errors } = await phoneWithCamera(parts);
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('[data-screen=addFunds]');
    expect(await page.locator('.fund-groups .row').first().getAttribute('id')).toBe('fund-note');
    expect(await page.textContent('#fund-note')).toContain('Scan a note');
    await page.click('#fund-note');
    await page.waitForSelector('#noteAmount', { timeout: 30_000 });
    expect(await page.textContent('#noteAmount')).toBe('$2.00');
    await page.click('#noteAdd');
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('$2.00');
    expect(errors).toEqual([]);
  }, 90_000);

  it('a note that was already used says so, and is kept on the phone marked not added', async () => {
    const token = await note(MINT_A, 100);
    const used = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
    expect(used.status).toBe(200);
    const { page, errors } = await phoneWithCamera([token]);
    await page.goto(`${g.url}/v2/#/funds/add/note`);
    await page.waitForSelector('#noteAdd', { timeout: 20_000 });
    expect(await page.textContent('#noteAmount')).toBe('$1.00');
    await page.click('#noteAdd');
    await page.waitForSelector('#noteResult');
    expect(await page.textContent('#noteResult')).toBe('This note has already been used. It cannot be added.');
    expect(await page.isVisible('#noteScanAgain')).toBe(true);
    expect(await foot(page)).toBe('Scan another'); // one button, and no stray text beside it
    expect(await foot(page)).not.toContain('null');
    expect((await vault(page)).in).toMatchObject([{ token, state: 'refused', code: 'token_spent' }]);
    // The only console error is the browser logging the refused request.
    expect(errors.filter((e) => !/status of 4\d\d/.test(e))).toEqual([]);
  }, 90_000);

  it('a note from a mint the engine does not take says so and offers Other mint, with the note handed over', async () => {
    const token = await note(MINT_B, 100);
    const { page, errors } = await phoneWithCamera([token]);
    await page.goto(`${g.url}/v2/#/funds/add/note`);
    await page.waitForSelector('#noteResult', { timeout: 20_000 });
    expect(await page.textContent('#noteAmount')).toBe('$1.00');
    expect(await page.textContent('#noteMint')).toBe('From 127.0.0.1:3339');
    expect(await page.textContent('#noteResult')).toBe('This note is from a mint this engine does not take. It can be added through Other mint.');
    expect(await page.locator('#noteAdd').count()).toBe(0); // never sent to the engine as a top-up
    await page.click('#noteOtherMint');
    await page.waitForSelector('[data-fund=othermint]');
    // The note is in the box and its price is asked for at once.
    await page.waitForSelector('#foreignConfirm', { timeout: 20_000 });
    expect(await page.textContent('#foreignConfirm')).toMatch(/^Add /);
    expect((await vault(page)).in).toEqual([]);
    // Back goes to Add funds, not to the scanner.
    await page.click('.back-head .round');
    await page.waitForSelector('[data-screen=addFunds]');
    expect(errors).toEqual([]);
  }, 90_000);

  it('a code that is not a note is passed over; the note can be pasted instead, and pasted text that is not a note says so', async () => {
    const { page, errors } = await phoneWithCamera(['https://example.com/not-a-note']);
    await page.goto(`${g.url}/v2/#/funds/add/note`);
    await page.waitForSelector('[data-fund=note] video');
    // v1's scanner reads only eCash codes: another code is passed over and the camera keeps looking.
    await page.waitForTimeout(2000);
    expect(await page.locator('#noteResult, #noteAmount').count()).toBe(0);
    expect(await page.textContent('.note-hint')).toBe('Point the camera at the code on the note.');
    // Paste instead: the camera stops.
    await page.click('#notePaste');
    await expect.poll(() => page.evaluate(() => document.querySelector('video') === null)).toBe(true);
    await page.fill('#noteText', 'https://example.com/not-a-note');
    await page.click('#noteRead');
    await page.waitForSelector('#noteResult');
    expect(await page.textContent('#noteResult')).toBe('This code is not an eCash note.');
    expect(await foot(page)).not.toContain('null');
    await page.click('#noteScanAgain');
    await page.click('#notePaste');
    await page.fill('#noteText', await note(MINT_A, 50));
    await page.click('#noteRead');
    await page.waitForSelector('#noteAdd');
    expect(await page.textContent('#noteAmount')).toBe('$0.50');
    expect(errors).toEqual([]);
  }, 90_000);

  it('without a camera: paste only, no stray text; a note in msat shows no amount; a note under an alias of the engine mint is added', async () => {
    const ctx = await plain.newContext(PHONE);
    // A phone or laptop with no camera at all.
    await ctx.addInitScript(() => Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true }));
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    try {
      await page.goto(`${g.url}/v2/#/funds/add/note`);
      await page.waitForSelector('#noteNoCamera');
      await page.waitForSelector('#noteText');
      expect(await foot(page)).toBe('Read the code');
      expect(await page.locator('#noteScanAgain').count()).toBe(0);
      // The engine lists the other address of its mint, and the phone keeps it.
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.models') ?? '{}').mint_aliases)).toEqual([ALIAS_A]);

      // 1000 msat is 1 sat: the phone shows no amount it cannot state exactly, and says the unit is not held.
      const msat = getEncodedToken({ mint: MINT_A, unit: 'msat', proofs: [{ id: '009a1f293253e41e', amount: 1000, secret: 'msat-note', C: '02' + 'ab'.repeat(32) }] as any });
      await page.fill('#noteText', msat);
      await page.click('#noteRead');
      await page.waitForSelector('#noteResult');
      expect(await page.textContent('#noteResult')).toBe('This note is in another unit. These funds cannot hold it. Keep the note.');
      expect(await page.locator('#noteAmount, #noteAdd').count()).toBe(0);
      expect(await page.textContent('#noteMint')).toBe('From 127.0.0.1:3338');
      expect(await foot(page)).toBe('Paste another');

      // A note made under the alias is from the engine's own mint: it is added, not sent to Other mint.
      await page.click('#noteScanAgain');
      await page.waitForSelector('#noteText');
      const token = getEncodedToken({ mint: ALIAS_A, unit: 'usd', proofs: await mintProofs(MINT_A, 'usd', 150) }, { removeDleq: true });
      await page.fill('#noteText', token);
      await page.click('#noteRead');
      await page.waitForSelector('#noteAdd');
      expect(await page.textContent('#noteMint')).toBe(`From ${new URL(ALIAS_A).host}`);
      expect(await page.textContent('#noteAdd')).toBe('Add $1.50');
      expect(await foot(page)).not.toContain('null');
      await page.click('#noteAdd');
      await page.waitForSelector('[data-screen=funds]');
      await expect.poll(() => page.textContent('#fundsAmount')).toBe('$1.50');
      expect(errors).toEqual([]);
    } finally {
      await ctx.close();
    }
  }, 90_000);

  it('the scanner works at 360 px wide, with large touch targets', async () => {
    const { page } = await phoneWithCamera(['not a note'], { width: 360, height: 740 });
    for (const route of ['', 'funds/add', 'funds/add/note']) {
      await page.goto(`${g.url}/v2/#/${route}`);
      await page.waitForSelector('[data-screen]');
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(360);
      const small = await page.locator('main button:visible').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 44 || r.height < 44)).length);
      expect(small, `touch targets on ${route}`).toBe(0);
    }
  }, 60_000);
});
