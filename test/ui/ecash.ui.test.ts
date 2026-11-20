import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, MINT_A, MINT_C, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { FakeReceiver, RECEIVER_TOKEN } from '../support/fakereceiver.ts';
import { fakeNotes } from '../support/fedinotes.ts';
import { cameraArgs, cameraFile } from './camera.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The eCash box (public/v2/modules/fund/ecash/) takes both kinds of eCash through one field and one
// scanner: Cashu tokens and Fedimint notes (core/fedinote.js). The engine is the real gateway with its
// real Fedimint code (src/fedimint.ts); the Fedimint receiver behind it is the stand-in
// (test/support/fakereceiver.ts), so every answer the phone sees is the gateway's own. The notes are
// shaped exactly as a federation writes them (test/support/fedinotes.ts); real notes from a real
// federation go through the same client code in test/fedimint/. Cashu from another mint is priced in
// the box itself, against the local test mints.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = process.env.ECASH_SHOTS ?? join(import.meta.dirname, '../../.tmp/ecash-shots');

let g: Gateway;
let rx: FakeReceiver;
let browser: Browser;
const others: Array<{ close(): Promise<void> }> = [];

const fedId = () => randomBytes(32).toString('hex');
const FED = { island: fedId(), small: fedId(), full: fedId(), old: fedId(), paused: fedId(), gone: fedId(), stranger: fedId() };

/** A federation the gateway takes: joined at the stand-in receiver through the gateway's own join. */
async function joinFed(gateway: Gateway, id: string, name: string, caps: { maxSat?: number; capSat?: number } = {}, receives = ['mint', 'mintv2']) {
  rx.invites.set(`invite-${id}`, { id, name, receives });
  await gateway.deps.fedimint!.join(`invite-${id}`, caps);
}

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  rx = await new FakeReceiver().start();
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_FEDIMINT_URL: rx.url, FORGE_FEDIMINT_TOKEN: RECEIVER_TOKEN },
    // A receive still pending is answered topup_pending at once.
    fedimint: { waitMs: 300, pollMs: 50 },
  });
  await joinFed(g, FED.island, 'Island Fed');
  await joinFed(g, FED.small, 'Small Fed', { maxSat: 50 });
  await joinFed(g, FED.full, 'Full Fed', { capSat: 10 });
  await joinFed(g, FED.old, 'Old Fed', {}, ['mint']);
  await joinFed(g, FED.paused, 'Pause Fed');
  await joinFed(g, FED.gone, 'Gone Fed');
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  for (const o of others) await o.close().catch(() => {});
  await browser?.close();
  await g?.close();
  await rx?.close();
});

async function phone(gateway = g, { codes = null as string[] | null } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[]; topups: () => number; quotes: () => number }> {
  let b = browser;
  if (codes) {
    b = await chromium.launch({ channel: 'chrome', headless: true, args: cameraArgs(cameraFile(codes)) });
    others.push(b);
  }
  const ctx = await b.newContext(PHONE);
  if (codes) await ctx.grantPermissions(['camera'], { origin: gateway.url });
  await pastFirstRun(ctx);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: gateway.url });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Refusals answer 4xx and 5xx on purpose.
  page.on('console', (m) => m.type() === 'error' && !/status of [45]\d\d/.test(m.text()) && errors.push(m.text()));
  let topups = 0;
  let quotes = 0;
  page.on('request', (r) => {
    if (r.url().endsWith('/v1/wallet/topup')) topups++;
    if (r.url().endsWith('/v1/wallet/fund/foreign/quote')) quotes++;
  });
  return { ctx, page, errors, topups: () => topups, quotes: () => quotes };
}

/** The eCash box, opened by its address once the engine's ways are read. */
async function openBox(page: Page, gateway = g) {
  await page.goto(`${gateway.url}/v2/#/funds/add/ecash`);
  await page.waitForSelector('[data-fund=ecash] #ecashToken');
  // The engine's mints (and its federations, when it takes Fedimint notes) in the box's info.
  await page.waitForFunction(() => /Accepted mint/.test(document.querySelector('[data-fund=ecash] .field-info')?.textContent ?? ''));
  await page.waitForFunction(async (base) => {
    const m = await (await fetch(`${base}/v1/wallet/fund/methods`)).json();
    return !m.fedimint?.enabled || /Fedimint/.test(document.querySelector('[data-fund=ecash] .field-info')?.textContent ?? '');
  }, gateway.url);
}

const vaultIn = async (page: Page) => JSON.parse((await page.evaluate(() => localStorage.getItem('forge2.vault'))) ?? '{"in":[]}').in as any[];
const msg = (page: Page) => page.textContent('[data-fund=ecash] .msg');
/** The name of the picture at the start of the box's status line. */
const msgIcon = (page: Page) => page.$eval('[data-fund=ecash] .msg svg', (u) => `#i-${u.getAttribute('data-icon')}`);

async function shot(page: Page, name: string) {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

async function paste(page: Page, text: string) {
  await page.fill('#ecashToken', text);
  await page.click('#ecashAdd');
}

describe('the eCash box with Fedimint notes', () => {
  it('adds Fedimint notes to the sat balance, names their federation, and keeps nothing once credited', async () => {
    const { ctx, page, errors, topups } = await phone();
    await page.goto(`${g.url}/v2/#/funds/add`);
    // Add money explains eCash with Fedimint while the engine takes it.
    await page.waitForSelector('#way-ecash', { state: 'attached' });
    await expect.poll(() => page.textContent('#wayInfo-ecash')).toBe('Cashu or Fedimint eCash from your wallet or a friend. It cannot be linked to you.');
    await openBox(page);
    expect(await page.textContent('[data-fund=ecash] .field-info')).toContain('Fedimint: Island Fed, Small Fed, Full Fed, Old Fed, Pause Fed, Gone Fed');
    const n = await fakeNotes(rx, FED.island, 73_728);
    let held: any[] = [];
    await page.route('**/v1/wallet/topup', async (route) => {
      held = await vaultIn(page);
      await route.continue();
    });
    await paste(page, n.notes);
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 20_000 });
    // The net of the receiver's record: the face value less the federation's fee.
    expect(await page.textContent('#fundsAddedText')).toBe('Added 72.494 sat.');
    // On the phone while it was sent, with its id and kind; gone once credited.
    expect(held).toMatchObject([{ token: n.notes, state: 'pending', kind: 'fedimint', notesId: n.notes_id }]);
    expect(await vaultIn(page)).toEqual([]);
    expect(topups()).toBe(1);
    // The gateway credited the sat balance the app opened, under the notes' own id.
    expect(g.deps.db.prepare('SELECT status FROM incoming WHERE id = ?').get(`fm:${n.notes_id}`)).toEqual({ status: 'done' });
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toMatch(/^sk-forge-/);
    await shot(page, '01-fedimint-added');

    // The same notes again: already added, nothing more.
    await openBox(page);
    await paste(page, n.notes);
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 20_000 });
    expect(await page.textContent('#fundsAddedText')).toBe('This eCash was already added.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('shows the amount and the federation before the answer', async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    const n = await fakeNotes(rx, FED.island, 4096, { outcome: 'pending' });
    // Hold the answer, to see what the box shows while it is on its way.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/v1/wallet/topup', async (route) => {
      await gate;
      await route.continue();
    });
    await paste(page, n.notes);
    await page.waitForSelector('#fmCard');
    expect(await page.textContent('#fmAmount')).toBe('4.096 sat');
    expect(await page.textContent('#fmFrom')).toBe('From Island Fed');
    await expect.poll(() => msg(page)).toBe('Adding your eCash');
    await shot(page, '02-fedimint-sending');
    release();
    await expect.poll(() => msg(page), { timeout: 15_000 }).toMatch(/^Still arriving\./);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('sends nothing while the engine takes no Fedimint notes', async () => {
    const off = await startGateway({ env: { FORGE_INVITE_ONLY: 'false' } });
    others.push(off);
    const { ctx, page, errors, topups } = await phone(off);
    await page.goto(`${off.url}/v2/#/funds/add`);
    await page.waitForSelector('#way-ecash', { state: 'attached' });
    await expect.poll(() => page.textContent('#wayInfo-ecash')).toBe('eCash from your wallet or a friend. It cannot be linked to you.');
    await openBox(page, off);
    expect(await page.textContent('[data-fund=ecash] .field-info')).not.toContain('Fedimint');
    const n = await fakeNotes(rx, FED.island, 2048);
    await paste(page, n.notes);
    await expect.poll(() => msg(page)).toMatch(/^Not taken here yet\./);
    expect(await msg(page)).toContain('Nothing was sent. Your eCash is still yours.');
    expect(await msgIcon(page)).toBe('#i-noMoney');
    expect(topups()).toBe(0);
    expect(await vaultIn(page)).toEqual([]);
    // The notes are still in the box, and Copy gives them back.
    expect(await page.inputValue('#ecashToken')).toBe(n.notes);
    await page.click('#fmCopy');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(n.notes);
    await shot(page, '03-fedimint-off');
    // Junk is not eCash, in the words of an engine without Fedimint.
    await paste(page, 'hello there');
    await expect.poll(() => msg(page)).toBe('Not eCash. An eCash token starts with cashuB.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('sends nothing while the engine’s ways are not read yet, and says so apart', async () => {
    const { ctx, page, errors, topups } = await phone();
    // The ways to pay never arrive (no connection to that route).
    await page.route('**/v1/wallet/fund/methods', (r) => r.abort());
    await page.goto(`${g.url}/v2/#/funds/add/ecash`);
    await page.waitForSelector('[data-fund=ecash] #ecashToken');
    await paste(page, (await fakeNotes(rx, FED.island, 2048)).notes);
    await expect.poll(() => msg(page)).toMatch(/^Cannot check it now\./);
    expect(await msgIcon(page)).toBe('#i-server');
    expect(topups()).toBe(0);
    expect(await vaultIn(page)).toEqual([]);
    expect(errors.filter((e) => !/ERR_FAILED/.test(e))).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('decides on the phone: a federation it does not list, and over the most taken at once', async () => {
    const { ctx, page, errors, topups } = await phone();
    await openBox(page);
    await paste(page, (await fakeNotes(rx, FED.stranger, 2048)).notes);
    await expect.poll(() => msg(page)).toMatch(/^Federation not taken here\./);
    await page.waitForSelector('#fmCopy');
    await shot(page, '04-fedimint-not-taken');
    // Small Fed takes up to 50 sat at once.
    await paste(page, (await fakeNotes(rx, FED.small, 65_536)).notes);
    await expect.poll(() => msg(page)).toBe('Too much at once. This engine takes up to 50 sat at a time. Nothing was taken. Your eCash is still yours.');
    expect(await msgIcon(page)).toBe('#i-gauge');
    expect(await page.textContent('#fmFrom')).toBe('From Small Fed');
    await shot(page, '05-fedimint-too-large');
    expect(topups()).toBe(0);
    expect(await vaultIn(page)).toEqual([]);
    await paste(page, 'hello there');
    await expect.poll(() => msg(page)).toBe('Not eCash. Paste a Cashu token or Fedimint notes.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("says each of the gateway's refusals in its own words, with its picture, and keeps the notes to copy", async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    // After the phone read the engine's ways: one federation paused, one left at the receiver.
    g.deps.fedimint!.setState(FED.paused, 'paused');
    rx.federations.delete(FED.gone);
    const cases: Array<{ name: string; notes: () => Promise<string>; code: string; head: string; icon: string; yours: boolean; before?: () => void; after?: () => void }> = [
      { name: 'paused', notes: async () => (await fakeNotes(rx, FED.paused, 2048)).notes, code: 'federation_paused', head: 'Paused for now.', icon: 'clock', yours: true },
      { name: 'not-joined', notes: async () => (await fakeNotes(rx, FED.gone, 2048)).notes, code: 'federation_not_joined', head: 'Federation not taken here.', icon: 'noMoney', yours: true },
      { name: 'full', notes: async () => (await fakeNotes(rx, FED.full, 16_384)).notes, code: 'federation_full', head: 'Full for now.', icon: 'gauge', yours: true },
      // The receiver says they are worth more than the phone read: the gateway's own cap.
      { name: 'too-large', notes: async () => (await fakeNotes(rx, FED.island, 1024, { claimMsat: 200_000_000 })).notes, code: 'amount_too_large', head: 'Too much at once.', icon: 'gauge', yours: true },
      { name: 'too-small', notes: async () => (await fakeNotes(rx, FED.island, 1024, { fee_msat: 2000 })).notes, code: 'insufficient_amount', head: 'Too small to add.', icon: 'coins', yours: true },
      { name: 'unsupported', notes: async () => (await fakeNotes(rx, FED.old, 2048)).notes, code: 'notes_unsupported', head: 'Kind not taken here.', icon: 'noMoney', yours: true },
      { name: 'invalid', notes: async () => (await fakeNotes(rx, FED.island, 2048, { valid: false })).notes, code: 'invalid_token', head: 'Could not use it.', icon: 'xCircle', yours: true },
      {
        name: 'unavailable',
        notes: async () => (await fakeNotes(rx, FED.island, 2048)).notes,
        code: 'fedimint_unavailable',
        head: 'Cannot reach it now.',
        icon: 'server',
        yours: true,
        before: () => (rx.down = true),
        after: () => (rx.down = false),
      },
      {
        name: 'spent',
        notes: async () => {
          const n = await fakeNotes(rx, FED.island, 2048);
          rx.receivedElsewhere(n);
          return n.notes;
        },
        code: 'token_spent',
        head: 'Already used.',
        icon: 'xCircle',
        yours: false,
      },
    ];
    for (const c of cases) {
      const notes = await c.notes();
      c.before?.();
      await paste(page, notes);
      await expect.poll(() => msg(page), { message: c.name, timeout: 15_000 }).toMatch(new RegExp(`^${c.head.replace('.', '\\.')}`));
      c.after?.();
      expect(await msgIcon(page), c.name).toBe(`#i-${c.icon}`);
      expect(await page.isVisible('[data-fund=ecash] .msg.err'), c.name).toBe(true);
      expect((await msg(page))!.includes('still yours'), c.name).toBe(c.yours && c.code !== 'invalid_token');
      // Copy back where they are still the person's; never for spent notes.
      expect(await page.locator('#fmCopy').isVisible(), c.name).toBe(c.yours);
      // Kept on the phone, marked not added (Funds lists them with Copy and Remove).
      expect((await vaultIn(page)).find((x) => x.token === notes), c.name).toMatchObject({ state: 'refused', code: c.code, kind: 'fedimint' });
      // The box still holds them, and Add can be pressed again.
      expect(await page.inputValue('#ecashToken'), c.name).toBe(notes);
      // Add again where it can change something; spent notes wait for other eCash in the box.
      expect(await page.isVisible('#ecashAdd'), c.name).toBe(c.yours);
      await shot(page, `06-fedimint-${c.name}`);
    }
    g.deps.fedimint!.setState(FED.paused, 'active');
    // Funds lists them as not added, with Copy and Remove.
    await page.goto(`${g.url}/v2/#/funds`);
    await page.waitForSelector('#vaultBox .vault-row.refused');
    expect(await page.locator('#vaultBox .vault-row.refused').count()).toBe(cases.length);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('keeps notes whose outcome is open, says they are still arriving, and adds them once on Check now', async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    const n = await fakeNotes(rx, FED.island, 8192, { outcome: 'pending' });
    await paste(page, n.notes);
    await expect.poll(() => msg(page), { timeout: 15_000 }).toBe('Still arriving. The federation is still working on it. Your eCash is kept on this phone until it is added. You can leave this screen.');
    expect(await msgIcon(page)).toBe('#i-wait');
    expect(await page.isVisible('[data-fund=ecash] .msg.err')).toBe(false);
    expect(await page.isVisible('#ecashAdd')).toBe(false);
    expect(await page.textContent('#fmCheck')).toBe('Check now');
    expect(await vaultIn(page)).toMatchObject([{ token: n.notes, state: 'pending', code: 'topup_pending', kind: 'fedimint' }]);
    await shot(page, '07-fedimint-pending');
    // Still pending on a check: nothing changes.
    await page.click('#fmCheck');
    await expect.poll(() => msg(page), { timeout: 15_000 }).toMatch(/^Still arriving\./);
    // The federation finishes: the next check adds it, once.
    rx.finish(n.notes_id, 'done');
    await page.click('#fmCheck');
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 20_000 });
    expect(await page.textContent('#fundsAddedText')).toBe('Added 6.958 sat.');
    expect(await vaultIn(page)).toEqual([]);
    expect(rx.receiveBodies.filter((b) => b.notes === n.notes).length).toBeGreaterThanOrEqual(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('checks again by itself while the box is open', async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    const n = await fakeNotes(rx, FED.island, 4096, { outcome: 'pending' });
    await paste(page, n.notes);
    await expect.poll(() => msg(page), { timeout: 15_000 }).toMatch(/^Still arriving\./);
    rx.finish(n.notes_id, 'done');
    // The box sends the same notes again every few seconds (RETRY_MS) until the outcome is known.
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 20_000 });
    expect(await page.textContent('#fundsAddedText')).toBe('Added 2.862 sat.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('keeps pending notes through a reload, lists them on Funds, and adds them when the app starts again', async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    const n = await fakeNotes(rx, FED.island, 16_384, { outcome: 'pending' });
    await paste(page, n.notes);
    await expect.poll(() => msg(page), { timeout: 15_000 }).toMatch(/^Still arriving\./);
    await page.goto(`${g.url}/v2/#/funds`);
    await page.reload();
    await page.waitForSelector('[data-screen=funds]');
    // Still on the phone after the reload, and Funds says it is waiting.
    expect(await vaultIn(page)).toMatchObject([{ token: n.notes, state: 'pending', kind: 'fedimint' }]);
    await page.waitForSelector('#vaultBox .vault-row.waiting');
    expect(await page.textContent('#vaultBox .vault-row.waiting b')).toBe('eCash waiting to be added');
    await shot(page, '08-funds-waiting');
    rx.finish(n.notes_id, 'done');
    // The app sends what waits on the phone each time it starts.
    await page.reload();
    await page.waitForSelector('[data-screen=funds]');
    await expect.poll(() => vaultIn(page), { timeout: 20_000 }).toEqual([]);
    const key = (await page.evaluate(() => localStorage.getItem('forge.balanceKey')))!;
    const bal = await (await fetch(`${g.url}/v1/wallet`, { headers: { authorization: `Bearer ${key}` } })).json();
    expect(bal.balance_msub).toBe(16_384 - 1234);
    // Credited once, whatever the number of tries.
    expect(g.deps.db.prepare("SELECT COUNT(*) AS n FROM ledger WHERE ref = ?").get(`fm:${n.notes_id}`)).toEqual({ n: 1 });
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('says help is needed for stuck notes, with their code to copy, and never sends them again', async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    const n = await fakeNotes(rx, FED.island, 4096, { outcome: 'issuance_failed' });
    await paste(page, n.notes);
    await expect.poll(() => msg(page), { timeout: 15_000 }).toMatch(/^Needs help\./);
    expect(await msg(page)).toContain(`give this code: ${n.notes_id.slice(0, 12)}`);
    expect(await msgIcon(page)).toBe('#i-hand');
    expect(await page.locator('#fmCopy').count()).toBe(0);
    // Copy code is the one next step; Add waits for other eCash.
    expect(await page.isVisible('#ecashAdd')).toBe(false);
    expect(await page.getAttribute('#fmCopyCode', 'class')).toContain('primary');
    await page.click('#fmCopyCode');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(n.notes_id);
    expect(await vaultIn(page)).toMatchObject([{ token: n.notes, state: 'stuck', code: 'issuance_failed', notesId: n.notes_id }]);
    await shot(page, '09-fedimint-stuck');
    const sent = rx.receiveBodies.length;
    // On Funds: needs help, Copy code and Remove, and no Copy eCash (the federation has them).
    await page.goto(`${g.url}/v2/#/funds`);
    await page.reload();
    await page.waitForSelector('#vaultBox .vault-row');
    const row = page.locator('#vaultBox .vault-row');
    expect(await row.locator('b').textContent()).toBe('eCash needs help');
    expect(await row.locator('.row-btns button').allTextContents()).toEqual(['Copy code', 'Remove']);
    await shot(page, '10-funds-stuck');
    // The start of the app sent nothing again.
    await page.waitForTimeout(1500);
    expect(rx.receiveBodies.length).toBe(sent);
    page.once('dialog', (d) => d.accept());
    await row.locator('button', { hasText: 'Remove' }).click();
    await expect.poll(() => vaultIn(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('reads Fedimint notes from the camera through the same box', async () => {
    const n = await fakeNotes(rx, FED.island, 32_768);
    const { ctx, page, errors } = await phone(g, { codes: [n.notes.toUpperCase()] });
    await openBox(page);
    await page.click('[data-fund=ecash] .field .btn');
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 30_000 });
    expect(await page.textContent('#fundsAddedText')).toBe('Added 31.534 sat.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('the eCash box with Cashu from another mint', () => {
  it('prices it in the box: the amount added, where it comes from, the fees; Add adds it', async () => {
    const { ctx, page, errors, quotes } = await phone();
    await openBox(page);
    await paste(page, await mintToken(MINT_C, 'sat', 1000));
    await page.waitForSelector('[data-fund=ecash] .price-card #foreignCredit', { timeout: 20_000 });
    expect(quotes()).toBe(1);
    expect(await page.textContent('#foreignWhat')).toMatch(/^From another mint\./);
    expect(await page.textContent('#foreignFrom')).toBe('From 1,000 sat');
    expect(await page.textContent('[data-fund=ecash] .price-card')).toMatch(/Fees, at most: \d+ sat/);
    const credit = (await page.textContent('#foreignCredit'))!;
    expect(await page.textContent('#foreignConfirm')).toBe(`Add ${credit}`);
    expect(await page.textContent('#foreignNo')).toBe('Keep my eCash');
    await shot(page, '11-othermint-price');
    await page.click('#foreignConfirm');
    await page.waitForSelector('#fundAdded', { timeout: 40_000 });
    expect(await page.textContent('#fundAdded .added-words')).toBe(`Added ${credit}.`);
    await shot(page, '12-othermint-added');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a mint off the engine’s list asks first, with Go on the one lit button', async () => {
    const { ctx, page, errors, quotes } = await phone();
    await openBox(page);
    // The gateway's answer for a mint it does not list while it lets the person go on (src/funding.ts vetForeignMint).
    await page.route('**/v1/wallet/fund/foreign/quote', async (r) => {
      if (JSON.parse(r.request().postData() ?? '{}').accept_unlisted) return r.continue();
      await r.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: "This mint is not on Forge's recommended list.", type: 'mint_unlisted', code: 'mint_unlisted' }, unlisted: { mint: MINT_C, max: { sat: 5000, usd: 500 } } }),
      });
    });
    await paste(page, await mintToken(MINT_C, 'sat', 400));
    await expect.poll(() => msg(page)).toMatch(/^Unknown mint\./);
    expect(await msgIcon(page)).toBe('#i-shield');
    expect(await page.textContent('#ecashUnlisted')).toBe(MINT_C);
    expect(await page.isVisible('#ecashAdd')).toBe(false);
    await shot(page, '16-othermint-unlisted');
    await page.click('#ecashGoOn');
    await page.waitForSelector('[data-fund=ecash] #foreignConfirm', { timeout: 20_000 });
    expect(quotes()).toBe(2);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('No keeps the eCash: back to the box with the token, nothing spent', async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    const token = await mintToken(MINT_C, 'sat', 500);
    await paste(page, token);
    await page.waitForSelector('#foreignNo', { timeout: 20_000 });
    await page.click('#foreignNo');
    await expect.poll(() => msg(page)).toBe('Nothing was changed. Your eCash is still yours.');
    expect(await page.inputValue('#ecashToken')).toBe(token);
    expect(await vaultIn(page)).toEqual([]);
    await shot(page, '13-othermint-kept');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('over the cap for other mints: says so, and asks no price', async () => {
    const capped = await startGateway({ env: { FORGE_INVITE_ONLY: 'false', FORGE_FOREIGN_ALLOW_INSECURE: 'true', FORGE_FOREIGN_MAX_SAT: '100' } });
    others.push(capped);
    const { ctx, page, errors, quotes } = await phone(capped);
    await openBox(page, capped);
    await paste(page, await mintToken(MINT_C, 'sat', 500));
    await expect.poll(() => msg(page)).toBe('Too much at once. This engine takes up to 100 sat from another mint at a time. Nothing was spent. Your eCash is still yours.');
    expect(await msgIcon(page)).toBe('#i-gauge');
    expect(quotes()).toBe(0);
    await shot(page, '14-othermint-over-cap');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('a price the engine cannot give is said plainly, and the token stays the person’s', async () => {
    const { ctx, page, errors } = await phone();
    await openBox(page);
    // The gateway's answer when the token's mint cannot pay Lightning invoices (src/funding.ts quoteForeign).
    await page.route('**/v1/wallet/fund/foreign/quote', (r) =>
      r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { message: "the token's mint cannot pay Lightning invoices: timeout", type: 'foreign_mint_error', code: 'foreign_mint_error' } }) }),
    );
    const token = await mintToken(MINT_C, 'sat', 300);
    await paste(page, token);
    await expect.poll(() => msg(page)).toBe("No price now. the token's mint cannot pay Lightning invoices: timeout Nothing was spent. Your eCash is still yours.");
    expect(await page.inputValue('#ecashToken')).toBe(token);
    expect(await vaultIn(page)).toEqual([]);
    await shot(page, '15-othermint-no-price');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("Cashu from the engine's own mint is added as before, with no price", async () => {
    const { ctx, page, errors, quotes } = await phone();
    await openBox(page);
    await paste(page, await mintToken(MINT_A, 'usd', 150));
    await page.waitForSelector('[data-screen=funds] #fundsAdded', { timeout: 20_000 });
    expect(await page.textContent('#fundsAddedText')).toBe('Added $1.50.');
    expect(quotes()).toBe(0);
    expect(await vaultIn(page)).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('an old Other mint address opens the eCash box', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/#/funds/add/othermint`);
    await page.waitForSelector('[data-fund=ecash] #ecashToken');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
