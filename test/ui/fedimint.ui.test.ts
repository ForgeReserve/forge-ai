import { createReadStream, existsSync, mkdtempSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readConfig, writeBundle } from '../../scripts/lib/android-web.ts';
import { type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { FakeFedimintCard, MockTill } from '../support/mocktill.ts';
import { nodeTill } from '../support/tillnode.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay } from './ways.ts';

// Tap a Fedimint card in a phone-sized browser (slice A14). On the website the row says a page cannot
// read cards. In the Android app's bundle, a stand-in for Capacitor's bridge plays ForgeNfc (the card,
// a fake in this test) and ForgeTill (the till's pay routes and card link, sent from Node to a mock
// till that implements fedimintcard-pay's documented routes and states: test/support/mocktill.ts).
// The engine is the local gateway, so the invoice is a real one from the local mint, whose FakeWallet
// marks it paid; the mock till plays the part of the till that pays it.
const ROOT = resolve(import.meta.dirname, '..', '..');
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

let g: Gateway;
let browser: Browser;
let site: Server;
let app: string;
let till: MockTill;

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
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'false' } });
  const assets = mkdtempSync(join(tmpdir(), 'forge-apk-assets-'));
  writeBundle(join(ROOT, 'public'), assets, readConfig(join(ROOT, 'capacitor.config.json')));
  site = await serveBundle(join(assets, 'public'));
  app = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  till = await new MockTill().start();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await till?.close();
  await new Promise((r) => site?.close(r));
  await g?.close();
});

beforeEach(() => {
  Object.assign(till, { next: [], requirePin: true, marginMsat: 0, gatewayFeeMsat: 1000, overpayMsat: 0, onOps: true, dropNextAnswer: false, loseNextPay: false, invoiceExpired: false });
  till.log = [];
});

/**
 * The app with a reader whose card is `card`, and ForgeTill played from Node: the pairing (address and
 * token) is held here, as the plugin holds it in the Keystore, and the page never sees the token.
 */
async function appWithCard(card: FakeFedimintCard) {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  const field = { card };
  await ctx.exposeFunction('__cardTx', async (hex: string) => {
    const answer = await field.card.transceive(Array.from(Buffer.from(hex, 'hex')));
    return Buffer.from(answer).toString('hex');
  });
  // ForgeTill: what the Android plugin does, with the till transport the unit tests use.
  const plugin = nodeTill();
  const links = new Map<number, { close(): void }>();
  const answers = new Map<string, (frame: object) => void>();
  await ctx.exposeBinding('__till', async ({ page }, method: string, opts: any) => {
    try {
      switch (method) {
        case 'status':
          return await plugin.status();
        case 'pair':
          return await plugin.pair(opts.text);
        case 'forget':
          return await plugin.forget();
        case 'request': {
          const r = await plugin.request({ method: opts.method, path: opts.path, link: opts.link, body: opts.body == null ? undefined : JSON.parse(opts.body), timeoutMs: opts.timeoutMs });
          return { status: r.status, body: JSON.stringify(r.body) };
        }
        case 'linkOpen': {
          const sock = opts.sock;
          const link = await plugin.openLink({
            onApdu: ({ id, apdu }) =>
              new Promise((resolveFrame) => {
                answers.set(`${sock}:${id}`, resolveFrame);
                page.evaluate((ev) => (window as any).__tillEvent('apdu', ev), { sock, id, apdu }).catch(() => {});
              }),
          });
          links.set(sock, link);
          return { sock, link: link.id };
        }
        case 'linkSend': {
          const { sock, ...frame } = opts;
          answers.get(`${sock}:${frame.id}`)?.(frame);
          answers.delete(`${sock}:${frame.id}`);
          return undefined;
        }
        case 'linkClose':
          links.get(opts.sock)?.close();
          links.delete(opts.sock);
          return undefined;
      }
    } catch (e: any) {
      return { __error: e?.code ?? 'failed' };
    }
    return undefined;
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
        if (plugin === 'ForgeTill') {
          const r = await w.__till(method, opts);
          if (r && r.__error) throw Object.assign(new Error(r.__error), { code: r.__error });
          return r;
        }
        if (plugin === 'ForgeShareIn' && method === 'waiting') return { waiting: false };
        return undefined;
      },
      addListener: (plugin: string, event: string, fn: (ev: any) => void) => {
        const l = { plugin, event, fn };
        w.__native.listeners.push(l);
        return Promise.resolve({ remove: async () => (w.__native.listeners = w.__native.listeners.filter((x: any) => x !== l)) });
      },
    };
    w.__tillEvent = (event: string, ev: any) => {
      for (const l of w.__native.listeners) if (l.plugin === 'ForgeTill' && l.event === event) l.fn(ev);
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
  await page.goto(`${app}/#/more/engine`);
  await page.waitForSelector('[data-screen=engine]');
  await page.fill('#engineAddress', `${g.url}/`);
  await Promise.all([page.waitForEvent('load'), page.click('#engineUse')]);
  await page.waitForSelector('[data-screen=home]');
  return { ctx, page, errors, field, plugin };
}

const tap = (page: Page) => page.evaluate(() => (window as any).__tap());
const tillPays = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('forge2.tillpays') ?? '{"pays":[]}').pays);

/** Opens Tap a Fedimint card, pairs with the mock till by pasting its pay code, and sees the price. */
async function pairAndPrice(page: Page) {
  await page.goto(`${app}/#/funds/add`);
  await openWay(page, 'fedimint');
  await page.waitForSelector('#fedNeedTill');
  // Nothing pasted or scanned yet (or only spaces): the message line says so, the focus goes to the field,
  // and the field is described by the message for a screen reader. The button stays enabled.
  const noCode = (await page.locator('#fedScan').count()) ? 'No pay code yet. Scan it or paste it.' : 'No pay code yet. Paste it here.';
  for (const text of ['', '  \n ']) {
    await page.fill('#fedPairText', text);
    expect(await page.isEnabled('#fedUseTill')).toBe(true);
    await page.click('#fedUseTill');
    await expect.poll(() => page.textContent('.fedimint-view .msg')).toBe(noCode);
    expect(await page.getAttribute('.fedimint-view .msg', 'class')).toMatch(/\berr\b/);
    expect(await page.getAttribute('.fedimint-view .msg', 'role')).toBe('status');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('fedPairText');
    const described = await page.getAttribute('#fedPairText', 'aria-describedby');
    expect(await page.evaluate((id) => document.getElementById(id!)?.textContent, described)).toBe(noCode);
    expect(await page.getAttribute('#fedPairText', 'aria-invalid')).toBe('true');
  }
  // Typing takes the error mark off the field.
  await page.type('#fedPairText', 'x');
  expect(await page.getAttribute('#fedPairText', 'aria-invalid')).toBeNull();
  // A till's own POS code is refused.
  await page.fill('#fedPairText', `fedimintcard-till:${till.url}?t=${till.posToken}`);
  await page.click('#fedUseTill');
  await expect.poll(() => page.textContent('.fedimint-view .msg')).toBe('Wrong code. This code is for the phones that run the till. Ask for its pay code.');
  await page.fill('#fedPairText', till.pairText());
  await page.click('#fedUseTill');
  await page.waitForSelector('#fedGetPrice');
  expect(await page.textContent('#fedTillUrl')).toBe(till.url);
  // The till pays a Lightning invoice, in sats for the sat balance (docs/PAYMENTS.md, Two balances).
  expect(await page.inputValue('#fedAmount')).toBe('5000');
  await page.click('#fedGetPrice');
  await page.waitForSelector('#fedPrice', { timeout: 20_000 });
  const [rec] = await tillPays(page);
  expect(rec.state).toBe('ready');
  return rec;
}

describe('Tap a Fedimint card', () => {
  it('on the website: beside the Cashu card on one wallet card, and its screen says only the app can do it', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('#tab-cards');
    // As plain as the Cashu card (owner, 2026-11-17): no longer a tile on More, its printed face beside
    // the Cashu card's, its name and its word.
    expect(await page.locator('#more-fedimint').count()).toBe(0);
    await page.click('#tab-cards');
    expect(await page.getAttribute('#pair-fedimint', 'aria-label')).toBe('Tap a Fedimint card');
    expect(await page.textContent('#pair-fedimint > span')).toBe('Fedimint');
    expect(await page.locator('#pair-fedimint .card-face text').first().textContent()).toBe('FEDIMINT ECASH CARD');
    // A tap on a printed card opens its way once its wallet card is the one on show (see card.ui.test.ts).
    await page.waitForSelector('#wayGo[data-way="cards"]', { state: 'attached' });
    await page.click('#pair-fedimint');
    await page.waitForSelector('#fedAppOnly');
    expect(await page.getAttribute('.card-art', 'aria-label')).toBe('A Fedimint card');
    expect(await page.textContent('#fedAppOnly')).toBe('Android app only. Fedimint cards work in the Forge app for Android. A web page cannot talk to a card.');
    expect(await page.getAttribute('#fedGetApp', 'href')).toBe('/download');
    await ctx.close();
  }, 60_000);

  it('in the app: pair by the pay code, the price before the tap, a wrong PIN, then the till pays and the funds rise', async () => {
    const card = new FakeFedimintCard({ balanceMsat: 50_000_000 });
    const { ctx, page, errors } = await appWithCard(card);
    const rec = await pairAndPrice(page);
    // The price: what reaches the funds, the most the card pays, and the till's part, before the tap.
    expect(await page.textContent('#fedYouGet')).toBe('You get 5,000 sat.');
    const most = Math.ceil(rec.mostMsat / 1000).toLocaleString('en-US');
    // A fresh pairing: the till's margin is not known yet, so the price says it may come on top.
    expect(await page.textContent('#fedCardPays')).toBe(`Card pays ${most} sat, plus margin. The card pays ${most} sat, plus the till's margin if its owner set one.`);
    expect(await page.textContent('#fedSplit')).toBe(`${Math.ceil(rec.invoiceMsat / 1000).toLocaleString('en-US')} sat pays your funds. Up to ${Math.ceil(rec.tillMsat / 1000).toLocaleString('en-US')} sat goes to the till for Lightning fees. Its margin is added if it has one.`);
    expect(await page.textContent('#fedPay')).toBe(`Pay ${most} sat with the card`);
    expect(await page.textContent('.fedimint-view')).not.toMatch(/null|undefined|NaN/);

    await page.fill('#fedPin', '1111');
    await page.click('#fedPay');
    await page.waitForSelector('#fedHold');
    expect(await page.textContent('#fedHold')).toBe('Hold the card to the phone. Hold it to the back of your phone.');
    await tap(page);
    await expect.poll(() => page.textContent('.fedimint-view .msg'), { timeout: 20_000 }).toBe('Wrong PIN, 2 tries left.');
    expect(card.balanceMsat).toBe(50_000_000);
    // The card is still on the phone: the next PIN goes with the same payment.
    await page.fill('#fedPin', '1234');
    await page.click('#fedPay');
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsAmount'), { timeout: 20_000 }).toBe('5,000 sat');
    // Funds says it in the success panel, with Ask now under it.
    expect(await page.textContent('#fundsAdded .added-amount')).toBe('+5,000 sat');
    expect(await page.textContent('#fundsAddedText')).toBe('Added 5,000 sat.');
    expect(await page.isVisible('#fundsAsk')).toBe(true);
    expect(card.balanceMsat).toBe(50_000_000 - (rec.invoiceMsat + rec.maxFeeMsat));
    // Both tries carried the same client_ref and the PIN typed for them, with the card link.
    const posts = till.log.filter((l) => l.path === '/v1/pay');
    expect(posts.map((p) => [p.body.client_ref, p.body.pin, p.scope])).toEqual([
      [rec.clientRef, '1111', 'pay'],
      [rec.clientRef, '1234', 'pay'],
    ]);
    expect(posts.every((p) => /^[0-9a-f]{16}$/.test(p.link ?? ''))).toBe(true);
    // Done: nothing is left on the phone, and no PIN was ever stored.
    expect(await tillPays(page)).toEqual([]);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toMatch(/1111|1234|"t=/);
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage }))).not.toContain(till.token);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: undecided, the phone asks the till until it settles, and the funds rise without another tap', async () => {
    till.next = ['undecided'];
    const card = new FakeFedimintCard({ balanceMsat: 50_000_000 });
    const { ctx, page, errors } = await appWithCard(card);
    const rec = await pairAndPrice(page);
    // The local mint's FakeWallet marks the engine's invoice paid at once. Here the engine says it is
    // still waiting until the till has paid, as it would with a real invoice.
    let settled = false;
    await page.route(`**/v1/wallet/fund/${rec.fundingId}`, async (route) => {
      if (settled) return route.continue();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...(await res.json()), state: 'pending', credited: null } });
    });
    await page.fill('#fedPin', '1234');
    await page.click('#fedPay');
    await page.waitForSelector('#fedHold');
    await tap(page);
    await expect.poll(() => page.textContent('#fedStatus'), { timeout: 20_000 }).toBe('The card paid. The till is finishing the payment. You can leave this screen.');
    const [held] = await tillPays(page);
    expect(held).toMatchObject({ state: 'undecided', payId: expect.any(Number) });
    // The phone asks the till where the pay stands, and never taps again.
    await expect.poll(() => till.log.filter((l) => l.method === 'GET').length, { timeout: 20_000 }).toBeGreaterThan(0);
    await till.settle(held.payId, 'paid');
    settled = true;
    await page.waitForSelector('[data-screen=funds]', { timeout: 30_000 });
    await expect.poll(() => page.textContent('#fundsAmount'), { timeout: 20_000 }).toBe('5,000 sat');
    // One charge, one POST; the rest was asked with GET and the pay's own client_ref.
    expect(till.log.filter((l) => l.path === '/v1/pay')).toHaveLength(1);
    expect(till.log.filter((l) => l.method === 'GET').every((l) => l.path === `/v1/pay/${held.payId}?client_ref=${rec.clientRef}`)).toBe(true);
    expect(card.balanceMsat).toBe(50_000_000 - (rec.invoiceMsat + rec.maxFeeMsat));
    expect(await tillPays(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: the price says "up to" only once the till margin is saved, and an unfinished payment holds the till', async () => {
    till.dropNextAnswer = true;
    const card = new FakeFedimintCard({ balanceMsat: 50_000_000 });
    const { ctx, page, errors } = await appWithCard(card);
    await pairAndPrice(page);
    expect(await page.textContent('#fedCardPays')).toMatch(/plus the till's margin if its owner set one\.$/);
    // Back to the amount, the margin as the till's owner set it, and the price again.
    await page.click('#fedChangeAmount');
    await page.waitForSelector('#fedTill');
    await page.click('.till-margin summary');
    await page.fill('#fedMarginSats', '0');
    await page.fill('#fedMarginPercent', '0');
    await page.click('#fedMarginSave');
    await page.click('#fedGetPrice');
    await page.waitForSelector('#fedPrice', { timeout: 20_000 });
    const [rec] = await tillPays(page);
    const most = Math.ceil(rec.mostMsat / 1000).toLocaleString('en-US');
    expect(await page.textContent('#fedCardPays')).toBe(`The card pays up to ${most} sat.`);
    expect(await page.textContent('#fedSplit')).toMatch(/goes to the till, for Lightning fees and its margin\.$/);
    // The answer is lost on the way: the payment is kept as sent, and the till cannot be changed or forgotten.
    await page.fill('#fedPin', '1234');
    await page.click('#fedPay');
    await page.waitForSelector('#fedHold');
    await tap(page);
    await page.waitForSelector('#fedTillBusy', { timeout: 20_000 });
    expect(await page.textContent('#fedTillBusy')).toBe('Finish the last payment. A card payment through this till is not finished. Finish it first.');
    expect(await page.isDisabled('#fedChangeTill')).toBe(true);
    expect(await page.isDisabled('#fedForgetTill')).toBe(true);
    expect((await tillPays(page))[0]).toMatchObject({ state: 'sent', till: till.url });
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: an unanswered payment whose invoice ran out is let go once the till cannot still be on it', async () => {
    till.loseNextPay = true;
    const card = new FakeFedimintCard({ balanceMsat: 50_000_000 });
    const { ctx, page, errors } = await appWithCard(card);
    await pairAndPrice(page);
    // The card stays on the phone after the first tap, so a later Pay goes on with it.
    const payWithCard = async (first = false) => {
      await page.fill('#fedPin', '1234');
      await page.click('#fedPay');
      if (!first) return;
      await page.waitForSelector('#fedHold');
      await tap(page);
    };
    // The request is lost on the way: kept as sent, and the till is held.
    await payWithCard(true);
    await page.waitForSelector('#fedTillBusy', { timeout: 20_000 });
    const [rec] = await tillPays(page);
    expect(rec.state).toBe('sent');
    // The invoice runs out. Straight after, the till could still be on the first request: kept.
    till.invoiceExpired = true;
    await page.click(`[data-finish="${rec.id}"]`);
    await payWithCard();
    await expect.poll(() => page.textContent('.fedimint-view .msg'), { timeout: 20_000 }).toBe('Wait two minutes. The till may still be working on the last try. Wait two minutes, then hold the card to the phone again.');
    expect((await tillPays(page))[0]).toMatchObject({ state: 'sent', clientRef: rec.clientRef });
    expect(await page.isDisabled('#fedChangeTill')).toBe(true);
    // Two minutes on (the first request was sent that long ago): the refusal now proves the till holds
    // no charge, so the payment goes, and with it the hold on the till.
    await page.evaluate(() => {
      const v = JSON.parse(localStorage.getItem('forge2.tillpays')!);
      v.pays[0].openSince -= 200_000;
      localStorage.setItem('forge2.tillpays', JSON.stringify(v));
    });
    await page.click(`[data-finish="${rec.id}"]`);
    await payWithCard();
    await expect.poll(() => page.textContent('.fedimint-view .msg'), { timeout: 20_000 }).toBe('Price expired. The price ran out of time. See the price again.');
    expect(await tillPays(page)).toEqual([]);
    expect(await page.$('#fedTillBusy')).toBeNull();
    expect(await page.isDisabled('#fedChangeTill')).toBe(false);
    expect(card.balanceMsat).toBe(50_000_000);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('in the app: Erase everything forgets the till, its address and token included', async () => {
    const { ctx, page, errors, plugin } = await appWithCard(new FakeFedimintCard());
    await page.goto(`${app}/#/funds/add/fedimint`);
    await page.waitForSelector('#fedPairText');
    await page.fill('#fedPairText', till.pairText());
    await page.click('#fedUseTill');
    await page.waitForSelector('#fedTillUrl');
    expect(await plugin.status()).toEqual({ paired: true, url: till.url });
    await page.goto(`${app}/#/more/erase`);
    await page.waitForSelector('#eraseHold');
    await page.focus('#eraseHold');
    await page.keyboard.down(' ');
    await page.waitForTimeout(2_300);
    await page.keyboard.up(' ');
    await page.waitForSelector('[data-screen=erased]');
    expect(await page.evaluate(() => (window as any).__native.calls.some((c: any) => c.plugin === 'ForgeTill' && c.method === 'forget'))).toBe(true);
    expect(await plugin.status()).toEqual({ paired: false, url: null });
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('in the app: the till cannot pay, keeps it for the card, and gives it back on the next tap; Erase warns until then', async () => {
    till.next = ['pay_failed'];
    const card = new FakeFedimintCard({ balanceMsat: 50_000_000 });
    const { ctx, page, errors } = await appWithCard(card);
    const rec = await pairAndPrice(page);
    await page.fill('#fedPin', '1234');
    await page.click('#fedPay');
    await page.waitForSelector('#fedHold');
    await tap(page);
    await page.waitForSelector('#fedFailed', { timeout: 20_000 });
    const paid = rec.invoiceMsat + rec.maxFeeMsat;
    expect(card.balanceMsat).toBe(50_000_000 - paid);
    expect(await page.textContent('#fedFailedLine')).toBe(`The till holds ${Math.ceil(paid / 1000).toLocaleString('en-US')} sat. It holds it for the card that paid. Hold that card to the phone to get it back.`);
    expect((await tillPays(page))[0].state).toBe('pay_failed');

    // Erase everything says a Fedimint card payment is not finished, and leads back to it.
    await page.goto(`${app}/#/more/erase`);
    await page.waitForSelector('#eraseTill');
    await page.click('#eraseSaveFirst');
    await page.waitForSelector('[data-fund=fedimint]');
    await page.waitForSelector('[data-get-back]', { timeout: 20_000 });
    await page.click('[data-get-back]');
    await page.waitForSelector('#fedHold');
    await tap(page);
    await expect.poll(() => page.textContent('#toast'), { timeout: 20_000 }).toBe(`${Math.ceil(paid / 1000).toLocaleString('en-US')} sat is back on the card.`);
    expect(card.balanceMsat).toBe(50_000_000);
    expect(await tillPays(page)).toEqual([]);
    expect(till.log.filter((l) => l.path.endsWith('/refund')).map((l) => l.scope)).toEqual(['pay']);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});
