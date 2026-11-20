import { createHash } from 'node:crypto';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createInvite, type Gateway, startGateway } from '../e2e/helpers.ts';
import { FakeReceiver, RECEIVER_TOKEN } from '../support/fakereceiver.ts';

// The Fedimint section of the operator page (/admin/#fedimint, public/admin/admin.js) in a real browser,
// against the gateway and a stand-in receiver over HTTP (test/support/fakereceiver.ts): join a federation
// by its invite, pause and resume it, change its holdings cap, read the reconciliation and the take out
// warning, Check now and Resolve the top-ups that need the operator, and the receiver going down. On a
// 360 px phone the page never scrolls sideways.
const TOKEN = 'ui-admin-token-0123456789abcdef';
const FED = createHash('sha256').update('ui federation').digest('hex');
const INVITE = 'fed11' + 'u'.repeat(150);

let g: Gateway;
let rx: FakeReceiver;
let browser: Browser;

beforeAll(async () => {
  rx = await new FakeReceiver().start();
  rx.invites.set(INVITE, { id: FED, name: 'Island Fed' });
  g = await startGateway({
    env: {
      FORGE_ADMIN_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'),
      FORGE_ADMIN_RATE_LIMIT_RPM: '100000',
      FORGE_FEDIMINT_URL: rx.url,
      FORGE_FEDIMINT_TOKEN: RECEIVER_TOKEN,
    },
    fedimint: { waitMs: 0, pollMs: 10 },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
  await rx?.close();
});

async function open(viewport = { width: 1280, height: 900 }, mobile = false): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('dialog', (d) => void d.accept());
  await page.goto(`${g.url}/admin/#fedimint`);
  await page.locator('#token').fill(TOKEN);
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('.section-head h1', { hasText: 'Fedimint' }).waitFor();
  return { page, errors };
}

const topup = async (token: string, key?: string) => {
  const r = await fetch(`${g.url}/v1/wallet/topup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify({ token, invite: key ? undefined : createInvite(g) }),
  });
  return (await r.json()) as any;
};
const text = (page: Page, sel: string) => page.locator(sel).innerText();
/** The page's Refresh: it shows Loading at once, then the section again from a new read. */
const refresh = async (page: Page) => {
  await page.locator('#refresh').click();
  await page.locator('#fm-feds').waitFor();
};

describe('the Fedimint section of the admin page', () => {
  it('joins a federation by invite, pauses, resumes and changes its holdings cap', async () => {
    const { page, errors } = await open();
    expect(await text(page, '#fm-feds')).toContain('No federation joined yet');
    await page.locator('#fjoin textarea[name=invite]').fill(INVITE);
    await page.locator('#fjoin input[name=cap_sat]').fill('2000');
    await page.locator('#fjoin button[type=submit]').click();
    await expect.poll(() => text(page, '#toast')).toContain('Joined Island Fed');
    await expect.poll(() => text(page, '#fm-feds')).toContain('Island Fed');
    const feds = await text(page, '#fm-feds');
    expect(feds).toContain('active');
    expect(feds).toContain('100,000 sat · 2,000 sat');
    expect(feds).toContain('held (own)');
    // The invite is never shown back.
    expect(await page.content()).not.toContain(INVITE);
    expect(g.deps.fedimint!.federation(FED)).toMatchObject({ state: 'active', cap_sat: 2000 });

    await page.locator(`[data-fpause="${FED}"]`).click();
    await expect.poll(() => text(page, '#fm-feds')).toContain('paused');
    expect(g.deps.fedimint!.federation(FED)!.state).toBe('paused');
    await page.locator(`[data-fresume="${FED}"]`).click();
    await expect.poll(() => page.locator(`[data-fpause="${FED}"]`).count()).toBe(1);
    expect(g.deps.fedimint!.federation(FED)!.state).toBe('active');

    await page.locator(`[data-fcap="${FED}"]`).click();
    await page.locator('#fcapf input[name=cap]').fill('777');
    await page.locator('#fcapf button[type=submit]').click();
    await expect.poll(() => text(page, '#toast')).toContain('Holdings cap 777 sat');
    await expect.poll(() => text(page, '#fm-feds')).toContain('777 sat');
    expect(g.deps.fedimint!.federation(FED)!.cap_sat).toBe(777);
    expect(await page.locator('#fcapf').count()).toBe(0);
    await page.locator(`[data-fcap="${FED}"]`).click();
    await page.locator('#fcapdef').click();
    await expect.poll(() => text(page, '#toast')).toContain('(default)');
    expect(g.deps.fedimint!.federation(FED)!.cap_sat).toBeNull();
    await expect.poll(() => text(page, '#fm-feds')).toContain('1,000,000 sat');
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('reconciles, warns that take out may fail, and Check now and Resolve settle the top-ups that need the operator', async () => {
    const done = rx.makeNotes(FED, 40_000, { fee_msat: 400 });
    const first = await topup(done.notes);
    expect(first.credited_msub).toBe(39_600);
    const pending = rx.makeNotes(FED, 5_000, { outcome: 'pending', fee_msat: 50 });
    expect((await topup(pending.notes, first.key)).error.code).toBe('topup_pending');
    const stuck = rx.makeNotes(FED, 7_000, { outcome: 'issuance_failed' });
    expect((await topup(stuck.notes, first.key)).error.code).toBe('issuance_failed');

    const { page, errors } = await open();
    // Tiles: the receiver holds what was credited; the fee is face value less credited.
    const tiles = await text(page, '.tiles');
    expect(tiles).toContain('39.600 sat');
    expect(tiles).toContain('0.400 sat kept by the federations as fees');
    expect(await text(page, '#fm-recon')).toContain('Agrees');
    // Every sat balance is backed by notes and the gateway holds no Cashu sat.
    expect(await text(page, '#fm-cover')).toContain('wallet_insufficient');
    expect(await text(page, '#fm-rebalance')).toContain('move 39 sat from Island Fed');
    expect(await text(page, '#fm-rebalance')).toContain('cannot pay a Lightning invoice');
    const rec = await text(page, '#fm-receipts');
    expect(rec).toContain('on its way');
    expect(rec).toContain('stuck');

    // The pending one finishes at the receiver: the reading says it is explained, never a flag.
    rx.finish(pending.notes_id, 'done');
    await refresh(page);
    await expect.poll(() => text(page, '#fm-recon')).toContain('Agrees once top-ups finish');
    expect(await page.locator('#fm-flag').count()).toBe(0);
    await page.locator(`[data-rcheck="${pending.notes_id}"]`).click();
    await expect.poll(() => text(page, '#toast')).toBe('Credited');
    await expect.poll(() => page.locator(`[data-rcheck="${pending.notes_id}"]`).count()).toBe(0);
    expect(g.deps.ledger.findByKey(first.key)!.balance_msub).toBe(39_600 + 4_950);
    await expect.poll(() => text(page, '#fm-recon')).toContain('Agrees');

    // Check now on the stuck one: the receiver still says it failed.
    await page.locator(`[data-rcheck="${stuck.notes_id}"]`).click();
    await expect.poll(() => text(page, '#toast')).toContain('the receiver says failed (issuance_failed)');
    await page.locator(`[data-rresolve="${stuck.notes_id}"]`).click();
    await page.locator('#fresolvef input[name=note]').fill('refunded by hand');
    await page.locator('#fresolvef button[type=submit]').click();
    await expect.poll(() => text(page, '#toast')).toBe('Resolved');
    await expect.poll(() => text(page, '#fm-receipts')).toContain('Nothing needs you');
    expect(g.deps.db.prepare('SELECT status FROM incoming WHERE id = ?').get(`fm:${stuck.notes_id}`)).toEqual({ status: 'rejected' });

    // A flag: the receiver holding less than was credited.
    rx.federations.get(FED)!.balance_msat -= 1000;
    await refresh(page);
    await expect.poll(() => text(page, '#fm-flag')).toContain('1 federation does not reconcile');
    expect(await text(page, '#fm-recon')).toContain('Receiver holds less');
    rx.federations.get(FED)!.balance_msat += 1000;

    // The receiver down: said at the top, the balances unknown.
    rx.down = true;
    await refresh(page);
    await expect.poll(() => page.locator('#fm-receiver-down').count()).toBe(1);
    expect(await text(page, '#fm-recon')).toContain('Unknown');
    rx.down = false;
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('fits a 360 px phone with no sideways scroll', async () => {
    const { page, errors } = await open({ width: 360, height: 740 }, true);
    await page.locator('#fm-receipts').waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
