import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readConfig, writeBundle } from '../../scripts/lib/android-web.ts';
import { type Gateway, MINT_A, MINT_C, mintsUp, startGateway } from '../e2e/helpers.ts';
import { mintSigner, provision } from '../support/cards.ts';
import { CardSim } from '../support/cardsim.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Tap a card in a phone-sized browser (slice A13). On the website the row says a page cannot read
// cards. In the Android app's bundle (served from its own origin as Capacitor serves it), a stand-in for
// Capacitor's bridge plays the ForgeNfc plugin, and every command it is given goes to a simulated card
// in this test (test/support/cardsim.ts) loaded with pieces minted at the local mint. The engine is the
// local gateway, so the card's swap really goes through the engine's relay to the mint.
const ROOT = resolve(import.meta.dirname, '..', '..');
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let g: Gateway;
let browser: Browser;
let site: Server;
let app: string;

function serveBundle(dir: string): Promise<Server> {
  const s = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    let file = normalize(join(dir, path));
    if (!file.startsWith(dir) || !existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => s.listen(0, '127.0.0.1', () => r(s)));
}

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true' } });
  const assets = mkdtempSync(join(tmpdir(), 'forge-apk-assets-'));
  writeBundle(join(ROOT, 'public'), assets, readConfig(join(ROOT, 'capacitor.config.json')));
  site = await serveBundle(join(assets, 'public'));
  app = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await new Promise((r) => site?.close(r));
  await g?.close();
});

/** The app with a reader whose cards are `card`, on the local engine. */
async function appWithCard(card: CardSim, gw: Gateway = g) {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  // The card in the field: a test can hand the phone another one (field.card = other).
  const field = { card };
  await ctx.exposeFunction('__cardTx', async (hex: string) => {
    const answer = await field.card.transceive(Array.from(Buffer.from(hex, 'hex')));
    return Buffer.from(answer).toString('hex');
  });
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__native = { calls: [] as any[], listeners: [] as any[], cardId: 0 };
    w.Capacitor = {
      isNativePlatform: () => true,
      nativePromise: async (plugin: string, method: string, opts: any) => {
        w.__native.calls.push({ plugin, method, opts });
        if (plugin === 'ForgeNfc' && method === 'status') return { available: true, enabled: true };
        if (plugin === 'ForgeNfc' && method === 'transceive') {
          if (opts.id !== w.__native.cardId) throw Object.assign(new Error('The card is gone.'), { code: 'tag_gone' });
          return { data: await w.__cardTx(opts.apdu) };
        }
        if (plugin === 'ForgeShareIn' && method === 'waiting') return { waiting: false };
        return undefined;
      },
      addListener: (plugin: string, event: string, fn: (ev: any) => void) => {
        const l = { plugin, event, fn };
        w.__native.listeners.push(l);
        return { remove: async () => (w.__native.listeners = w.__native.listeners.filter((x: any) => x !== l)) };
      },
    };
    // A card comes into the field.
    w.__tap = () => {
      w.__native.cardId += 1;
      for (const l of w.__native.listeners) if (l.plugin === 'ForgeNfc' && l.event === 'card') l.fn({ id: w.__native.cardId, isoDep: true });
    };
  });
  // Nothing leaves this computer: Forge's own engine (the app's default) is answered with a refusal.
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (route) => route.abort('blockedbyclient'));
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|ERR_BLOCKED_BY_CLIENT/.test(m.text()) && errors.push(m.text()));
  // Use the local engine, as a person would in More, Engine.
  await page.goto(`${app}/#/more/engine`);
  await page.waitForSelector('[data-screen=engine]');
  await page.fill('#engineAddress', `${gw.url}/`);
  await Promise.all([page.waitForEvent('load'), page.click('#engineUse')]);
  await page.waitForSelector('[data-screen=home]');
  return { ctx, page, errors, field };
}

/** The card is held to the phone. */
async function tap(page: Page, card: CardSim) {
  card.tap();
  await page.evaluate(() => (window as any).__tap());
}

const cardStore = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.cards') ?? '{"jobs":[]}').jobs);
const vault = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.vault') ?? '{"in":[],"out":[]}'));

async function openCard(page: Page) {
  await page.goto(`${app}/#/funds/add`);
  await page.waitForSelector('[data-screen=addFunds]');
  await page.click('#fund-card');
  await page.waitForSelector('#cardHold');
}

describe('Tap a card', () => {
  it('on the website: listed after Scan a note, and says only the app can read cards', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('[data-screen=addFunds]');
    const ids = await page.locator('.fund-groups .row').evaluateAll((rows) => rows.map((r) => r.id));
    expect(ids.indexOf('fund-card')).toBe(ids.indexOf('fund-note') + 1);
    expect(await page.textContent('#fund-card')).toContain('Tap a card');
    await page.click('#fund-card');
    await page.waitForSelector('#cardAppOnly');
    expect(await page.textContent('#cardAppOnly')).toBe('Cards work in the Forge app for Android. A web page cannot talk to a card.');
    expect(await page.getAttribute('#cardGetApp', 'href')).toBe('/download');
    // The page did not fetch the curve library: nothing is loaded for cards on the website.
    expect(await page.evaluate(() => performance.getEntriesByType('resource').some((r) => r.name.includes('/vendor/noble.js')))).toBe(false);
    await ctx.close();
  }, 60_000);

  it('in the app: tap, the card shows what it holds, a wrong PIN shows the tries left, then all of it moves to the funds', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [64, 32, 4]);
    const { ctx, page, errors } = await appWithCard(card);
    await openCard(page);
    expect(await page.textContent('#cardHold')).toBe('Hold the card to the back of your phone');
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    expect(await page.textContent('.card-art-amount')).toBe('100 sat');
    expect(await page.textContent('#cardMint')).toBe('From 127.0.0.1:3338');
    expect(await page.getAttribute('#cardAll', 'aria-checked')).toBe('true');
    expect(await page.textContent('#cardGet')).toBe('You get 100 sat.');
    expect(await page.textContent('#cardMove')).toBe('Move 100 sat');
    expect(await page.textContent('.card-view')).not.toMatch(/null|undefined/);
    // Nothing is held on the phone before the card is asked to sign.
    expect(await cardStore(page)).toEqual([]);

    await page.fill('#cardPin', '1111');
    await page.click('#cardMove');
    await expect.poll(() => page.textContent('.card-view .msg')).toBe('Wrong PIN. 2 tries left.');
    expect(card.balance()).toBe(100);
    // The card is lifted and held again before a new PIN is typed: the card is only read, and the
    // wrong PIN is never sent again on its own.
    const verifies = () => card.log.filter((l) => l.apdu.startsWith('b040')).length;
    const sent = verifies();
    card.lift();
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await expect.poll(() => page.textContent('#cardTries')).toBe('2 tries left.');
    expect(card.tries).toBe(2);
    expect(verifies()).toBe(sent);
    expect(await page.inputValue('#cardPin')).toBe('');

    let heldWhileSending: any = null;
    await page.route('**/v1/wallet/topup', async (route) => {
      heldWhileSending = await vault(page);
      await route.continue();
    });
    await page.fill('#cardPin', '1234');
    await page.click('#cardMove');
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('100 sat');
    expect(card.balance()).toBe(0);
    // The card's eCash was in the vault while it was sent, and nothing is left once credited.
    expect(heldWhileSending.in).toHaveLength(1);
    expect(heldWhileSending.in[0].token).toMatch(/^cashuB/);
    expect((await vault(page)).in).toEqual([]);
    expect(await cardStore(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: part of it, and a card lifted after it signed loses nothing; Erase warns, and the next tap finishes it with the PIN', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [16, 8, 4, 2]);
    const { ctx, page, errors } = await appWithCard(card);
    await openCard(page);
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await page.click('#cardSome');
    await page.fill('#cardAmount', '21');
    expect(await page.textContent('#cardGet')).toBe('You get 21 sat.');
    expect(await page.textContent('#cardBack')).toBe('1 sat goes back onto the card.');
    expect(await page.textContent('.card-view')).not.toMatch(/null|undefined/);
    await page.fill('#cardPin', '1234');
    // The card leaves the field right after it signed: its answer never arrives.
    card.breaks.push({ ins: 0x24, when: 'after' });
    await page.click('#cardMove');
    await page.waitForSelector('#cardHoldLine:has-text("before you use it anywhere else")', { timeout: 20_000 });
    expect(await page.textContent('#cardHoldLine')).toBe('The card left before it finished. Hold the same card to the phone again before you use it anywhere else.');
    // The pieces are burned on the card and the payment is held on the phone.
    expect(card.balance()).toBe(8);
    expect((await cardStore(page))[0].state).toBe('ready');
    // Erase everything warns that a card payment is not finished; its button leads back to the card.
    await page.goto(`${app}/#/more/erase`);
    await page.waitForSelector('#eraseCards');
    expect(await page.textContent('#eraseCards')).toBe('A card payment is not finished on this phone. Finish it in Tap a card first, or that money is lost.');
    await page.click('#eraseSaveFirst');
    await page.waitForSelector('[data-fund=card] #cardHold');

    await tap(page, card);
    // A new screen does not have the PIN: the card's payment waits for it.
    await page.waitForSelector('#cardFinish', { timeout: 20_000 });
    expect(await page.textContent('#cardToFinish')).toBe('This card has a payment to finish.');
    await page.fill('#cardFinishPin', '1234');
    await page.click('#cardFinish');
    // The card is still there: it gives its signature again, the swap is made, the change goes back on it.
    await page.waitForSelector('#cardMove', { timeout: 30_000 });
    await expect.poll(() => card.balance()).toBe(9);
    await page.goto(`${app}/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('21 sat');
    expect(await cardStore(page)).toEqual([]);
    expect((await vault(page)).in).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: the card is lifted as it signs and held again on the same screen: no second PIN, the money arrives', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [32, 8]);
    const { ctx, page, errors } = await appWithCard(card);
    await openCard(page);
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await page.fill('#cardPin', '1234');
    card.breaks.push({ ins: 0x24, when: 'after' });
    await page.click('#cardMove');
    await page.waitForSelector('#cardHoldLine:has-text("before you use it anywhere else")', { timeout: 20_000 });
    await tap(page, card);
    // All of it moved, so the card is empty: the screen goes back to Funds with the balance.
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('40 sat');
    expect(card.balance()).toBe(0);
    expect(await cardStore(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: a card from another mint pays its input fee and goes on to Other mint with the eCash', async () => {
    const card = new CardSim({ pin: null, mint: MINT_C });
    await provision(card, await mintSigner(MINT_C), [64, 32]);
    const { ctx, page, errors } = await appWithCard(card);
    await openCard(page);
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    // No PIN on this card: no PIN field.
    expect(await page.locator('#cardPin').count()).toBe(0);
    expect(await page.textContent('#cardFee')).toBe('The card mint takes 1 sat to move it.');
    // Other mint charges its own price after this: the card screen says only what comes to the phone.
    expect(await page.textContent('#cardGet')).toBe('Comes to this phone: 95 sat. Other mint shows its price next.');
    await page.click('#cardMove');
    // Other mint opens with the eCash and asks the engine for its price at once.
    await page.waitForSelector('[data-fund=othermint] #foreignConfirm', { timeout: 30_000 });
    expect(card.balance()).toBe(0);
    // Until it is added, the eCash is kept on the phone, listed as not added.
    const held = (await vault(page)).in;
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ via: 'card', state: 'refused', code: 'card_other_mint' });
    await page.click('#foreignConfirm');
    await page.waitForSelector('#fundDone', { timeout: 30_000 });
    await expect.poll(async () => (await vault(page)).in).toEqual([]);
    expect(await cardStore(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: a payment the card mint refuses is listed with Try again, and Try again brings the money', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [32, 16]);
    const { ctx, page, errors } = await appWithCard(card);
    await openCard(page);
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await page.fill('#cardPin', '1234');
    // The first swap goes through at the mint, but the answer the phone gets is a refusal.
    let refuse = true;
    await page.route('**/v1/wallet/fund/card/swap', async (route) => {
      if (!refuse || route.request().method() !== 'POST') return route.continue();
      refuse = false;
      const response = await route.fetch();
      await route.fulfill({ response, status: 400, contentType: 'application/json', body: JSON.stringify({ error: { code: 'mint_refused', message: 'Witness is missing or invalid' }, mint_code: 20008 }) });
    });
    await page.click('#cardMove');
    await page.waitForSelector('#cardResult', { timeout: 30_000 });
    expect(await page.textContent('#cardResult')).toBe('The card mint refused this payment. Its details are kept on this phone.');
    expect((await cardStore(page))[0]).toMatchObject({ state: 'failed', error: 'Witness is missing or invalid' });
    // Erase counts it, and its button leads to the card screen, which lists it.
    await page.goto(`${app}/#/more/erase`);
    await page.waitForSelector('#eraseCards');
    await page.click('#eraseSaveFirst');
    await page.waitForSelector('[data-fund=card] #cardFailed');
    expect(await page.textContent('#cardFailedHead')).toBe('Card payments that did not go through');
    expect(await page.textContent('#cardFailed .card-failed p')).toBe('48 sat from 127.0.0.1:3338');
    expect(await page.textContent('#cardFailed')).toContain('Reason: Witness is missing or invalid');
    await page.click('#cardFailed .card-failed button');
    // The mint did the swap already: its signatures are asked for again (restore) and the eCash is added.
    await expect.poll(() => cardStore(page), { timeout: 30_000 }).toEqual([]);
    await page.waitForSelector('#cardHold');
    expect(await page.locator('#cardFailed').count()).toBe(0);
    await page.goto(`${app}/#/funds`);
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('48 sat');
    expect((await vault(page)).in).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it("in the app: a card from another mint never gives more in one tap than the engine takes from that mint", async () => {
    const capped = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_FOREIGN_MAX_SAT: '50' } });
    try {
      const card = new CardSim({ pin: null, mint: MINT_C });
      await provision(card, await mintSigner(MINT_C), [64, 32]);
      const { ctx, page, errors } = await appWithCard(card, capped);
      await openCard(page);
      await tap(page, card);
      await page.waitForSelector('#cardMove', { timeout: 20_000 });
      expect(await page.textContent('.card-art-amount')).toBe('96 sat');
      expect(await page.textContent('#cardPart')).toBe('One tap moves up to 50 sat. Tap again for the rest.');
      expect(await page.textContent('#cardMove')).toBe('Move 50 sat');
      expect(await page.textContent('#cardGet')).toBe('Comes to this phone: 49 sat. Other mint shows its price next.');
      await page.click('#cardSome');
      await page.fill('#cardAmount', '60');
      expect(await page.textContent('#cardPreview')).toBe('Enter a whole number of sats, up to 50 sat.');
      expect(await page.isDisabled('#cardMove')).toBe(true);
      expect(card.balance()).toBe(96);
      expect(errors).toEqual([]);
      await ctx.close();
    } finally {
      await capped.close();
    }
  }, 120_000);

  it('in the app: a PIN typed for one card is never sent to another card that has a payment to finish', async () => {
    const a = new CardSim({ pin: '5678', mint: MINT_A });
    const b = new CardSim({ pin: '1234', mint: MINT_A });
    const signer = await mintSigner(MINT_A);
    await provision(a, signer, [16]);
    await provision(b, signer, [8]);
    const { ctx, page, errors, field } = await appWithCard(b);
    await openCard(page);
    // Card B signs and leaves before its answer: its payment waits on this phone.
    await tap(page, b);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await page.fill('#cardPin', '1234');
    b.breaks.push({ ins: 0x24, when: 'after' });
    await page.click('#cardMove');
    await page.waitForSelector('#cardHoldLine:has-text("before you use it anywhere else")', { timeout: 20_000 });
    // Card A, with its own PIN, does the same.
    field.card = a;
    await tap(page, a);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await page.fill('#cardPin', '5678');
    a.breaks.push({ ins: 0x24, when: 'after' });
    await page.click('#cardMove');
    await page.waitForSelector('#cardHoldLine:has-text("before you use it anywhere else")', { timeout: 20_000 });
    // Card B comes back: A's PIN is not tried on it. B's own PIN is asked for.
    field.card = b;
    const verifies = b.log.filter((l) => l.apdu.startsWith('b040')).length;
    await tap(page, b);
    await page.waitForSelector('#cardFinish', { timeout: 20_000 });
    expect(b.log.filter((l) => l.apdu.startsWith('b040')).length).toBe(verifies);
    expect(b.tries).toBe(3);
    await page.fill('#cardFinishPin', '1234');
    await page.click('#cardFinish');
    await expect.poll(async () => (await cardStore(page)).filter((j: any) => j.state === 'ready').length, { timeout: 30_000 }).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
