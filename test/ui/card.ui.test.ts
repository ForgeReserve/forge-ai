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
import { openWay, wayOrder } from './ways.ts';

// Tap a card in a phone-sized browser (slice A13). On the website the row says a page cannot read
// cards. In the app's bundle (served from its own origin as Capacitor serves it), a stand-in for
// Capacitor's bridge plays the ForgeNfc plugin, as Android's NfcPlugin.kt or as the iPhone's
// NfcPlugin.swift (one NFC sheet, opened by start and closed by close or stop), and every command it is
// given goes to a simulated card in this test (test/support/cardsim.ts) loaded with pieces minted at the
// local mint. The engine is the local gateway, so the card's swap really goes through the engine's relay
// to the mint.
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

/**
 * The app with a reader whose cards are `card`, on the local engine. iphone: the iPhone app, whose
 * ForgeNfc reads only while its sheet is up (__native.sheet: {words, card} or null); available: what
 * the reader's status says.
 */
async function appWithCard(card: CardSim, gw: Gateway = g, { iphone = false, available = true } = {}) {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  // The card in the field: a test can hand the phone another one (field.card = other).
  const field = { card };
  await ctx.exposeFunction('__cardTx', async (hex: string) => {
    const answer = await field.card.transceive(Array.from(Buffer.from(hex, 'hex')));
    return Buffer.from(answer).toString('hex');
  });
  await ctx.addInitScript(({ iphone, available }) => {
    const w = window as any;
    w.__native = { calls: [] as any[], listeners: [] as any[], cardId: 0, sheet: null as any };
    w.Capacitor = {
      isNativePlatform: () => true,
      ...(iphone ? { getPlatform: () => 'ios', Plugins: { ForgeBars: {}, ForgeNfc: {} } } : {}),
      nativePromise: async (plugin: string, method: string, opts: any) => {
        w.__native.calls.push({ plugin, method, opts });
        if (plugin === 'ForgeNfc' && method === 'status') return { available, enabled: available };
        if (iphone && plugin === 'ForgeNfc' && method === 'start') {
          // One sheet at a time: a second start keeps the sheet that is up.
          w.__native.sheet ??= { words: opts, card: 0 };
          return undefined;
        }
        if (iphone && plugin === 'ForgeNfc' && method === 'close') {
          if (w.__native.sheet?.card && w.__native.sheet.card === opts.id) w.__native.sheet = null;
          return undefined;
        }
        if (iphone && plugin === 'ForgeNfc' && method === 'stop') {
          w.__native.sheet = null;
          return undefined;
        }
        if (plugin === 'ForgeNfc' && method === 'transceive') {
          if (opts.id !== w.__native.cardId || (iphone && w.__native.sheet?.card !== opts.id)) throw Object.assign(new Error('The card is gone.'), { code: 'tag_gone' });
          try {
            return { data: await w.__cardTx(opts.apdu) };
          } catch {
            // The card left: on the iPhone its sheet ends, saying so.
            if (iphone) w.__native.sheet = null;
            throw Object.assign(new Error('The card left the phone.'), { code: 'tag_lost' });
          }
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
    // A card comes into the field. On the iPhone only while the sheet is up, and one card per sheet.
    w.__tap = () => {
      if (iphone && (!w.__native.sheet || w.__native.sheet.card)) return false;
      w.__native.cardId += 1;
      if (iphone) w.__native.sheet.card = w.__native.cardId;
      for (const l of w.__native.listeners) if (l.plugin === 'ForgeNfc' && l.event === 'card') l.fn({ id: w.__native.cardId, isoDep: true });
      return true;
    };
  }, { iphone, available });
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

/** The card is held to the phone. Resolves false when the iPhone has no sheet up to read it. */
async function tap(page: Page, card: CardSim) {
  card.tap();
  return page.evaluate(() => (window as any).__tap());
}

/** The iPhone's NFC sheet: {words, card} while it is up, else null. */
const sheet = (page: Page) => page.evaluate(() => (window as any).__native.sheet);
/** The ForgeNfc calls the page made, by method. */
const nfcCalls = (page: Page, method: string) => page.evaluate((m) => (window as any).__native.calls.filter((c: any) => c.plugin === 'ForgeNfc' && c.method === m).map((c: any) => c.opts), method);

const cardStore = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.cards') ?? '{"jobs":[]}').jobs);
const vault = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.vault') ?? '{"in":[],"out":[]}'));

async function openCard(page: Page) {
  await page.goto(`${app}/#/funds/add`);
  await openWay(page, 'card');
  await page.waitForSelector('#cardHold');
}

describe('Tap a Cashu card', () => {
  it('on the website: the Cashu card beside the Fedimint card, a wallet card that says the app reads cards, and its screen says so too', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-cards');
    // Named as plainly as the Fedimint card, and beside it (owner, 2026-11-17): the two printed cards on one
    // wallet card, each its own button with its word.
    expect(await wayOrder(page)).toEqual(['note', 'lightning', 'cards', 'ecash', 'more']);
    expect(await page.getAttribute('#tab-cards', 'aria-label')).toBe('Tap a card: Cashu or Fedimint');
    expect(await page.getAttribute('#way-cards .way-badge', 'aria-label')).toBe('Forge app');
    expect(await page.textContent('#way-cards .way-word')).toBe('Cards');
    expect(await page.getAttribute('#pair-card', 'aria-label')).toBe('Tap a Cashu card');
    expect(await page.textContent('#pair-card > span')).toBe('Cashu');
    expect(await page.locator('#pair-card .card-face text').first().textContent()).toBe('CASHU ECASH CARD');
    expect(await page.getAttribute('#pair-fedimint', 'aria-label')).toBe('Tap a Fedimint card');
    expect(await page.textContent('#pair-fedimint > span')).toBe('Fedimint');
    await page.click('#tab-cards');
    await page.click('#wayInfoBtn-cards');
    expect(await page.locator('#wayInfo-cards p').allTextContents()).toEqual([
      'Tap a Cashu card',
      'Hold the card to the back of the phone. It cannot be linked to you.',
      'Tap a Fedimint card',
      'A till takes the payment from the card and pays your funds.',
      'Cards work in the Forge app, Android or iPhone.',
    ]);
    await page.click('#pair-card');
    await page.waitForSelector('#cardAppOnly');
    expect(await page.textContent('[data-screen=fund] h1')).toBe('Tap a Cashu card');
    expect(await page.getAttribute('.card-art', 'aria-label')).toBe('A Cashu card');
    expect(await page.textContent('#cardAppOnly')).toBe('App only. Cashu cards work in the Forge app, Android or iPhone. A web page cannot talk to a card.');
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
    expect(await page.textContent('#cardHold')).toBe('Hold the card to the phone. Hold it to the back of your phone.');
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
    await expect.poll(() => page.textContent('.card-view .msg')).toBe('Wrong PIN, 2 tries left.');
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
    expect(await page.textContent('#eraseCards')).toBe('A Cashu card payment is open. A Cashu card payment is not finished on this phone. Finish it in Tap a Cashu card first, or that money is lost.');
    await page.click('#eraseSaveFirst');
    await page.waitForSelector('[data-fund=card] #cardHold');

    await tap(page, card);
    // A new screen does not have the PIN: the card's payment waits for it.
    await page.waitForSelector('#cardFinish', { timeout: 20_000 });
    expect(await page.textContent('#cardToFinish')).toBe('A payment to finish.');
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
    expect(await page.textContent('#cardFee')).toBe('Fee: 1 sat. The card mint takes 1 sat to move it.');
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
    expect(await page.textContent('#cardResult')).toBe('Card mint refused it. The card mint refused this payment. Its details are kept on this phone.');
    expect((await cardStore(page))[0]).toMatchObject({ state: 'failed', error: 'Witness is missing or invalid' });
    // Erase counts it, and its button leads to the card screen, which lists it.
    await page.goto(`${app}/#/more/erase`);
    await page.waitForSelector('#eraseCards');
    await page.click('#eraseSaveFirst');
    await page.waitForSelector('[data-fund=card] #cardFailed');
    expect(await page.textContent('#cardFailedHead')).toBe('Card payments not done');
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
      expect(await page.textContent('#cardPreview')).toBe('Use a whole number up to 50 sat.');
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
  it('in the iPhone app: press, then tap. The sheet opens with the screen and closes once the card is read; Move opens it again, and all of it moves to the funds', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [64, 32, 4]);
    const { ctx, page, errors } = await appWithCard(card, g, { iphone: true });
    await page.goto(`${app}/#/funds/add`);
    await page.waitForSelector('#tab-card');
    // Listed and usable here: no badge or line that sends the person to an app.
    expect(await page.locator('#way-card .badge-app').count()).toBe(0);
    await openWay(page, 'card');
    await page.waitForSelector('#cardHold');
    // Opening Tap a card was the press: the sheet is up, with the page's own words.
    expect(await sheet(page)).toMatchObject({ words: { hold: 'Hold the card to the top of the back of your iPhone.', keep: 'Keep the card there.', done: 'Done. You can take the card away.', lost: 'The card moved away. Scan it again in Forge.', notCard: 'Not an eCash card.', one: 'Hold one card at a time.' } });
    expect(await page.textContent('#cardScan')).toBe('Scan the card');
    expect(await tap(page, card)).toBe(true);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    expect(await page.textContent('.card-art-amount')).toBe('100 sat');
    // Read: the card is let go and its sheet closes, so the PIN can be typed.
    await expect.poll(() => sheet(page)).toBeNull();
    expect(await nfcCalls(page, 'close')).toEqual([{ id: 1 }]);
    card.lift();
    expect(await tap(page, card)).toBe(false);

    await page.fill('#cardPin', '1234');
    await page.click('#cardMove');
    // Move is the press: the sheet opens for the tap that pays.
    await page.waitForSelector('#cardHold');
    expect(await page.textContent('#cardHoldLine')).toBe('Tap the card again.');
    await expect.poll(() => sheet(page)).not.toBeNull();
    expect(card.balance()).toBe(100);
    expect(await tap(page, card)).toBe(true);
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('100 sat');
    expect(card.balance()).toBe(0);
    await expect.poll(() => sheet(page)).toBeNull();
    expect(await cardStore(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the iPhone app: the card lifted as it signs closes the sheet; Scan opens it again and the next tap finishes it with no second PIN', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    await provision(card, await mintSigner(MINT_A), [32, 8]);
    const { ctx, page, errors } = await appWithCard(card, g, { iphone: true });
    await openCard(page);
    await tap(page, card);
    await page.waitForSelector('#cardMove', { timeout: 20_000 });
    await expect.poll(() => sheet(page)).toBeNull();
    card.lift();
    await page.fill('#cardPin', '1234');
    await page.click('#cardMove');
    await expect.poll(() => sheet(page)).not.toBeNull();
    card.breaks.push({ ins: 0x24, when: 'after' });
    await tap(page, card);
    await page.waitForSelector('#cardHoldLine:has-text("before you use it anywhere else")', { timeout: 20_000 });
    // The card left mid-tap: its sheet is gone, and no sheet opens until the person asks.
    await expect.poll(() => sheet(page)).toBeNull();
    const starts = (await nfcCalls(page, 'start')).length;
    expect(await tap(page, card)).toBe(false);
    await page.click('#cardScan');
    await expect.poll(() => sheet(page)).not.toBeNull();
    expect(await nfcCalls(page, 'start')).toHaveLength(starts + 1);
    const verifies = card.log.filter((l) => l.apdu.startsWith('b040')).length;
    await tap(page, card);
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsAmount')).toBe('40 sat');
    expect(card.balance()).toBe(0);
    // The PIN typed on this screen was used for the same card; nothing was typed again.
    expect(card.log.filter((l) => l.apdu.startsWith('b040')).length).toBe(verifies + 1);
    expect(await cardStore(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the iPhone app on a phone that cannot read cards (the Simulator): the screen says so, opens no sheet, and nothing fails', async () => {
    const card = new CardSim({ pin: '1234', mint: MINT_A });
    const { ctx, page, errors } = await appWithCard(card, g, { iphone: true, available: false });
    await page.goto(`${app}/#/funds/add`);
    await openWay(page, 'card');
    await page.waitForSelector('#cardNoNfc');
    expect(await page.textContent('#cardNoNfc')).toBe('This phone cannot read cards.');
    expect(await nfcCalls(page, 'start')).toEqual([]);
    expect(await sheet(page)).toBeNull();
    // Tap a Fedimint card needs a till, which the iPhone app has not: it is never offered there.
    await page.goto(`${app}/#/funds/add`);
    await page.waitForSelector('#tab-card');
    await page.waitForSelector('#more-othermint', { state: 'attached' });
    expect(await page.locator('#tab-fedimint, #more-fedimint').count()).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
