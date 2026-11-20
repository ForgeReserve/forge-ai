import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { getEncodedToken } from '@cashu/cashu-ts';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, MINT_A, MINT_B, MINT_C, mintsUp, redeem, startGateway } from '../e2e/helpers.ts';
import { type BnNote, codes, fakeProofs, mintNote, secretAt, validationHash } from '../support/bitnotes.ts';
import { cameraArgs, cameraFile } from './camera.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { boxState, DOTS, seenAt } from './held.ts';

// BitNotes paper notes in the eCash box (public/v2/core/bitnote.js, modules/fund/ecash/). Each note is
// made as BitNotes makes one (test/support/bitnotes.ts): its proofs minted at the local test mints with
// the note's own secrets and blinding factors, then written into both of its codes. The engine is the
// real gateway, so every answer the phone sees is the gateway's and the mint's own.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = process.env.BITNOTE_SHOTS ?? join(import.meta.dirname, '../../.tmp/bitnote-shots');

let g: Gateway;
let browser: Browser;
const others: Browser[] = [];

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true' } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  for (const b of others) await b.close().catch(() => {});
  await browser?.close();
  await g?.close();
});

async function phone({ camera = null as string | null, width = 640, height = 480 } = {}) {
  let b = browser;
  if (camera) {
    // A BitNotes code is printed at error correction M.
    b = await chromium.launch({ channel: 'chrome', headless: true, args: cameraArgs(cameraFile([camera], { level: 'M', width, height })) });
    others.push(b);
  }
  const ctx = await b.newContext(PHONE);
  if (camera) await ctx.grantPermissions(['camera'], { origin: g.url });
  await pastFirstRun(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Refusals answer 4xx on purpose.
  page.on('console', (m) => m.type() === 'error' && !/status of [45]\d\d/.test(m.text()) && errors.push(m.text()));
  let topups = 0;
  let quotes = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/wallet/topup')) topups++;
    if (r.url().endsWith('/v1/wallet/fund/foreign/quote')) quotes++;
  });
  return { ctx, page, errors, topups: () => topups, quotes: () => quotes };
}

async function openBox(page: Page) {
  await page.goto(`${g.url}/v2/#/funds/add/ecash`);
  await page.waitForSelector('[data-fund=ecash] #ecashToken');
  await page.waitForFunction(() => /Accepted mint/.test(document.querySelector('[data-fund=ecash] .field-info')?.textContent ?? ''));
}

async function paste(page: Page, text: string) {
  await page.fill('#ecashToken', text);
  await page.click('#ecashAdd');
}

const msg = (page: Page) => page.textContent('[data-fund=ecash] .msg');
const msgIcon = (page: Page) => page.$eval('[data-fund=ecash] .msg svg', (u) => `#i-${u.getAttribute('data-icon')}`);
const vaultIn = async (page: Page) => JSON.parse((await page.evaluate(() => localStorage.getItem('forge2.vault'))) ?? '{"in":[]}').in as any[];

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

/** The note's proofs as a Cashu token, to spend them at the mint as someone else would. */
const tokenOf = (n: BnNote) => getEncodedToken({ mint: n.mints[0]!.mint, unit: 'sat', proofs: n.mints[0]!.proofs.map((p) => ({ id: p.id, amount: p.amount, secret: secretAt(n.secret!.seed, p.index), C: p.C })) as any });

describe('BitNotes paper notes in the eCash box', () => {
  it("adds a note from the engine's own mint: the printed amount and its mint first, then all its proofs", async () => {
    const n = await mintNote(100, [MINT_A]);
    const { ctx, page, errors, topups } = await phone();
    await openBox(page);
    // Held until the box is seen with the note's card in it.
    let release!: () => void;
    const seen = new Promise<void>((r) => (release = r));
    let held: any[] = [];
    await page.route('**/v1/wallet/topup', async (route) => {
      held = await vaultIn(page);
      await seen;
      await route.continue();
    });
    // The code exactly as a phone's scanner reads it off the paper, spaces and all.
    await paste(page, codes(n).private);
    await page.waitForSelector('#bnCard #bnAmount');
    expect(await page.textContent('#bnAmount')).toBe('100 sat');
    expect(await page.textContent('#bnFrom')).toBe(`From ${new URL(MINT_A).host}`);
    await expect.poll(() => msg(page)).toBe('Adding your eCash');
    await shot(page, '01-bitnote-card');
    release();
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 20_000 });
    // The proofs hold the face value and the reserve for fees: all of it is added.
    expect(await page.textContent('#fundsAddedText')).toBe('Added 110 sat.');
    await shot(page, '02-bitnote-added');
    // On the phone as a Cashu token of the note's proofs while it was sent; gone once credited.
    expect(held).toHaveLength(1);
    expect(held[0].token).toMatch(/^cashuB/);
    expect(await vaultIn(page)).toEqual([]);
    expect(topups()).toBe(1);
    // The proofs are spent: the engine took them.
    await expect(redeem(tokenOf(n), MINT_A, 'sat')).rejects.toThrow();
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('the code that only shows the note says to scan the other one, and sends nothing', async () => {
    const n = await mintNote(50, [MINT_A]);
    const { ctx, page, errors, topups, quotes } = await phone();
    await openBox(page);
    await paste(page, codes(n).public);
    await expect.poll(() => msg(page)).toBe('Scan the other code. This code only shows the note. Scan the code that says do not share. Nothing was sent.');
    expect(await msgIcon(page)).toBe('#i-scan');
    await shot(page, '03-bitnote-public');
    expect(topups() + quotes()).toBe(0);
    expect(await vaultIn(page)).toEqual([]);
    // Still unspent at its mint.
    expect(await redeem(tokenOf(n), MINT_A, 'sat')).toBe(60);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a code that does not match its note, or cannot be read, is refused before anything is sent', async () => {
    const n = await mintNote(30, [MINT_A]);
    const { ctx, page, errors, topups } = await phone();
    await openBox(page);
    // One proof's C changed, the printed hash kept.
    const proofs = n.mints[0]!.proofs.map((p, i) => (i === 0 ? { ...p, C: fakeProofs(n.secret!.seed, [p.amount])[0]!.C } : p));
    await paste(page, codes({ ...n, hash: validationHash(n.mints), mints: [{ mint: MINT_A, proofs }] }).private);
    await expect.poll(() => msg(page)).toBe('Does not check out. This code does not match its note. Nothing was sent. Keep the note.');
    expect(await msgIcon(page)).toBe('#i-xCircle');
    await shot(page, '04-bitnote-mismatch');
    // A code cut short on the way.
    await paste(page, codes(n).private.slice(0, 200));
    await expect.poll(() => msg(page)).toBe('Could not read it. This code could not be read as a note. Try again.');
    expect(topups()).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a note already used says so', async () => {
    const n = await mintNote(20, [MINT_A]);
    await redeem(tokenOf(n), MINT_A, 'sat');
    const { ctx, page, errors } = await phone();
    await openBox(page);
    await paste(page, codes(n).private);
    await expect.poll(() => msg(page), { timeout: 20_000 }).toBe('Already used. This eCash has already been used.');
    expect(await page.textContent('#bnAmount')).toBe('20 sat');
    await shot(page, '05-bitnote-spent');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a note of two mints is refused, and nothing is sent', async () => {
    const n = await mintNote(40, [MINT_A, MINT_B]);
    const { ctx, page, errors, topups, quotes } = await phone();
    await openBox(page);
    await paste(page, codes(n).private);
    await expect.poll(() => msg(page)).toBe('Too many mints. This note holds eCash from 2 mints. Only a note from one mint can be added here. Nothing was sent. Keep the note.');
    expect(await msgIcon(page)).toBe('#i-noMoney');
    await shot(page, '06-bitnote-two-mints');
    expect(topups() + quotes()).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a note from another mint is priced in the box, and Add adds what the price said', async () => {
    const n = await mintNote(1000, [MINT_C]);
    const { ctx, page, errors, quotes } = await phone();
    await openBox(page);
    await paste(page, codes(n).private);
    await page.waitForSelector('[data-fund=ecash] .price-card #foreignCredit', { timeout: 20_000 });
    expect(quotes()).toBe(1);
    // The note's proofs: its face value and its reserve.
    expect(await page.textContent('#foreignFrom')).toBe('From 1,030 sat');
    const credit = (await page.textContent('#foreignCredit'))!;
    await shot(page, '07-bitnote-othermint-price');
    await page.click('#foreignConfirm');
    await page.waitForSelector('#fundAdded', { timeout: 40_000 });
    expect(await page.textContent('#fundAdded .added-words')).toBe(`Added ${credit}.`);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("reads the note's code from the camera, in the box and through Scan a note, and never writes it into the page", async () => {
    for (const via of ['box', 'note']) {
      const n = await mintNote(64, [MINT_A]);
      const code = codes(n).private;
      const { ctx, page, errors } = await phone({ camera: code });
      // Held until the page is read while the note's eCash is on its way.
      let release!: () => void;
      const seen = new Promise<void>((r) => (release = r));
      let held: any[] = [];
      await page.route('**/v1/wallet/topup', async (route) => {
        held = await vaultIn(page);
        await seen;
        await route.continue();
      });
      if (via === 'box') {
        await openBox(page);
        await page.click('[data-fund=ecash] .field .btn');
      } else await page.goto(`${g.url}/v2/#/funds/add/note`);
      await page.waitForSelector('#bnCard #bnAmount', { timeout: 30_000 });
      await expect.poll(() => msg(page), { message: via }).toBe('Adding your eCash');
      // Dots in the box, marked held: neither the private code nor the token read from it is on the page.
      expect(await boxState(page), via).toEqual({ value: DOTS, held: true });
      expect(await seenAt(page, 'ECASHZ:'), via).toEqual([]);
      expect(await seenAt(page, code), via).toEqual([]);
      expect(held, via).toHaveLength(1);
      expect(await seenAt(page, held[0].token), via).toEqual([]);
      release();
      await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 30_000 });
      expect(await page.textContent('#fundsAddedText')).toBe('Added 74 sat.');
      expect(errors).toEqual([]);
      await ctx.close();
    }
  }, 90_000);

  it('reads the dense code of a note of many proofs from a large camera picture', async () => {
    // 245 sat and its reserve, 255: eight proofs, a code of about 2,700 characters. In a 1920 by 1080
    // picture it is 5 pixels a module, under 2 once the whole picture is made 720 wide.
    const n = await mintNote(245, [MINT_A]);
    expect(n.mints[0]!.proofs).toHaveLength(8);
    const { ctx, page, errors } = await phone({ camera: codes(n).private, width: 1920, height: 1080 });
    await openBox(page);
    await page.click('[data-fund=ecash] .field .btn');
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 30_000 });
    expect(await page.textContent('#fundsAddedText')).toBe('Added 255 sat.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});
