import { createHash, randomUUID } from 'node:crypto';
import { type Browser, chromium, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chatBody, createInvite, type Gateway, MINT_A, mintToken, startGateway } from '../e2e/helpers.ts';

// The operator page's Overview and Costs (/admin/, public/admin/admin.js) at FORGE_MARKUP=1, the hosted
// gateway's setting (docs/PAYMENTS.md, What a request costs), in a real browser against the gateway and
// the local mints: real requests paid from a balance, then every margin figure reads zero, and nothing on
// the page reads NaN, Infinity or a negative zero.
const TOKEN = 'ui-admin-overview-token-0123456789';

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  g = await startGateway({
    env: { FORGE_ADMIN_TOKEN_HASH: createHash('sha256').update(TOKEN).digest('hex'), FORGE_ADMIN_RATE_LIMIT_RPM: '100000', FORGE_MARKUP: '1' },
  });
  const t = await fetch(`${g.url}/v1/wallet/topup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: await mintToken(MINT_A, 'usd', 100), invite: createInvite(g) }),
  });
  const { key } = (await t.json()) as any;
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${g.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(chatBody('mock-echo')),
    });
    expect(r.status).toBe(200);
    await r.text();
  }
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function open(section: string, heading: string): Promise<{ page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(`${g.url}/admin/#${section}`);
  await page.locator('#token').fill(TOKEN);
  await page.locator('#login-form button[type=submit]').click();
  await page.locator('.section-head h1', { hasText: heading }).waitFor();
  return { page, errors };
}

/** A figure gone wrong: NaN, Infinity, or a zero with a minus sign (-0, -0.0%, −$0.00). */
const BROKEN = /NaN|Infinity|[-−]\$?0(\.0+)?(?![\d.])/;
const stat = (page: Page, label: string) => page.locator('.stat', { has: page.locator('.stat-label', { hasText: label }) }).locator('.stat-value').innerText();
const tile = (page: Page, label: string) => page.locator('.tile', { has: page.locator('.tile-label', { hasText: label }) }).innerText();

describe('the admin page at markup 1', () => {
  it('reads the estimated margin as zero on the overview', async () => {
    const { page, errors } = await open('overview', 'Overview');
    expect(await page.locator('.section-head').innerText()).toContain('Markup ×1');
    const revenue = await stat(page, 'Revenue');
    expect(revenue).toMatch(/^\$\d/);
    expect(revenue).not.toBe('$0.00');
    expect(await stat(page, 'Est. margin')).toBe('$0.00');
    expect(await tile(page, 'Margin, 30 days')).toContain('$0.00');
    expect(await tile(page, 'Margin, 30 days')).toContain('0.0% of');
    expect(await page.locator('#view').innerText()).not.toMatch(BROKEN);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('reads a zero margin and a 0.0% share on Costs, never -0.0% for a tiny loss', async () => {
    let { page, errors } = await open('costs', 'Costs');
    expect(await tile(page, 'Margin')).toContain('$0.00');
    expect(await tile(page, 'Margin')).toContain('0.0% of what customers paid');
    expect(await tile(page, 'Markup')).toContain('×1');
    expect(await tile(page, 'Markup')).toContain('0.0% margin at catalog cost');
    expect(await page.locator('#view').innerText()).not.toMatch(BROKEN);
    expect(errors).toEqual([]);
    await page.context().close();

    // A supplier that reports a cost a hair above the price: a loss of a millionth of what was paid.
    g.deps.db
      .prepare(
        "INSERT INTO requests (id, payment, unit, model, supplier, status, input_tokens, output_tokens, charged_msub, price_nusd, supplier_cost_nusd, cost_source, created_at) VALUES (?, 'nut24', 'usd', 'mock-echo', 'mock', 'settled', 10, 10, 100, 1000000000, 1000001000, 'supplier', ?)",
      )
      .run(randomUUID(), Date.now());
    ({ page, errors } = await open('costs', 'Costs'));
    expect(await tile(page, 'Margin')).toContain('−$0.000001');
    expect(await tile(page, 'Margin')).toContain('0.0% of what customers paid');
    expect(await page.locator('#view').innerText()).not.toMatch(BROKEN);
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
