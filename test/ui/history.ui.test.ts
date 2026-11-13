import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';

// Slice A4 in a phone-sized Chrome: History, Burn on the answer screen, Burn all, auto-delete and Erase
// everything. Every deletion path is checked against what the browser really keeps for the site: each
// IndexedDB database and store, each Cache Storage entry, localStorage and sessionStorage.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'true' } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function phone(opts: object = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ ...PHONE, ...opts });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page, errors };
}

/** A balance key funded with $2.00 through the API. */
async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 200);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

/** Opens v2 with a funded balance and the mock model that answers with a fixed sentence. */
async function ready(page: Page) {
  const key = await fundedKey();
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await page.reload();
  await page.waitForSelector('[data-screen=home]');
  await page.click('#btn-more');
  await page.click('#moreModel');
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click('[data-model="mock-echo"]');
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
  await expect.poll(() => page.textContent('#balanceText')).toBe('$2.00');
}

/** Asks a typed question and waits for the whole answer. */
async function ask(page: Page, q: string) {
  await page.goto(`${g.url}/v2/#/type`);
  await page.waitForSelector('[data-screen=type]');
  await page.fill('#question', q);
  await page.click('#sendBtn');
  await page.waitForSelector('[data-screen=answer]');
  await page.waitForSelector('#burnBtn', { timeout: 20_000 });
}

/** Starts a new conversation (the old one stays in History). */
async function startFresh(page: Page) {
  await page.goto(`${g.url}/v2/#/funds`);
  await page.waitForSelector('[data-screen=funds]');
  await page.click('#startFresh');
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
}

async function openHistory(page: Page) {
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
  await page.click('#btn-more');
  await page.click('#moreHistory');
  await page.waitForSelector('[data-screen=history]');
}

const historyWords = (page: Page) => page.locator('.hist-card .hist-text b').allTextContents();

/** Everything the site keeps in IndexedDB, Cache Storage, localStorage and sessionStorage, as one text. */
function dump(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const out: string[] = [];
    for (const s of [localStorage, sessionStorage]) for (let i = 0; i < s.length; i++) out.push(s.key(i)!, s.getItem(s.key(i)!) ?? '');
    for (const { name } of await indexedDB.databases()) {
      const db = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open(name!);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      for (const store of Array.from(db.objectStoreNames)) {
        const read = (what: 'getAll' | 'getAllKeys') =>
          new Promise<unknown[]>((res, rej) => {
            const r = db.transaction(store).objectStore(store)[what]();
            r.onsuccess = () => res(r.result as unknown[]);
            r.onerror = () => rej(r.error);
          });
        out.push(`${name}/${store}`, JSON.stringify(await read('getAllKeys')), JSON.stringify(await read('getAll')));
      }
      db.close();
    }
    for (const n of await caches.keys()) {
      const c = await caches.open(n);
      for (const req of await c.keys()) out.push(req.url, (await (await c.match(req))?.text()) ?? '');
    }
    return out.join('\n');
  });
}

/** What the site still keeps: counts and names only (opening a cache or database would create it). */
const leftovers = (page: Page) =>
  page.evaluate(async () => ({
    localStorage: localStorage.length,
    sessionStorage: sessionStorage.length,
    databases: (await indexedDB.databases()).map((d) => d.name),
    caches: await caches.keys(),
    workers: (await navigator.serviceWorker.getRegistrations()).length,
  }));

describe('History and burn', () => {
  it('burns one conversation from the answer screen and one from History, leaving nothing of either behind', async () => {
    const { ctx, page, errors } = await phone();
    await ready(page);
    await ask(page, 'Where is the clinic? marker-alpha-71');
    await startFresh(page);
    await ask(page, 'What should I bring? marker-bravo-72');
    expect(await page.getAttribute('#burnBtn', 'aria-label')).toBe('Burn this conversation. It is removed from this phone at once.');
    // Both are on the phone before burning (this also proves the dump sees them).
    let all = await dump(page);
    expect(all).toContain('marker-alpha-71');
    expect(all).toContain('marker-bravo-72');

    // Burn on the answer screen: this conversation is gone at once, the other stays.
    await page.click('#burnBtn');
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#toast')).toBe('Burned. It is gone from this phone.');
    all = await dump(page);
    expect(all).not.toContain('marker-bravo-72');
    expect(all).toContain('marker-alpha-71');
    await page.goto(`${g.url}/v2/#/answer`);
    await expect.poll(() => page.textContent('#answerText')).toBe('No answer yet. Type a question to start.');

    // History: newest first, first words and time; open one, then burn it with its flame.
    await openHistory(page);
    await expect.poll(() => historyWords(page)).toEqual(['Where is the clinic? marker-alpha-71']);
    expect(await page.textContent('.hist-card .hist-time')).toBe('Just now');
    // One day by default: the timer row shows the time left.
    expect(await page.getAttribute('#auto-day', 'aria-checked')).toBe('true');
    expect(await page.textContent('.burn-timer')).toMatch(/^2[34]h left$/);
    expect(await page.textContent('#burnWhat')).toContain('The engine keeps no copy of conversations with private models.');
    await page.waitForSelector('.hist-open');
    await page.click('.hist-open');
    await page.waitForSelector('[data-screen=answer]');
    expect(await page.textContent('.asked')).toBe('Where is the clinic? marker-alpha-71');
    // Continue it: a follow-up joins the same conversation.
    await page.click('#btn-type');
    await page.waitForSelector('#followLine:not([hidden])');
    await page.fill('#question', 'And when does it open? marker-charlie-73');
    await page.click('#sendBtn');
    await page.waitForSelector('#burnBtn', { timeout: 20_000 });
    await openHistory(page);
    await expect.poll(() => page.locator('.hist-card').count()).toBe(1);
    expect(await page.textContent('.hist-card .tag')).toBe('Open now');
    await page.click('[data-burn]');
    await page.waitForSelector('#historyEmpty');
    all = await dump(page);
    for (const m of ['marker-alpha-71', 'marker-bravo-72', 'marker-charlie-73']) expect(all).not.toContain(m);

    // Nothing comes back after a reload.
    await page.reload();
    await page.waitForSelector('[data-screen=history]');
    await page.waitForSelector('#historyEmpty');
    all = await dump(page);
    for (const m of ['marker-alpha-71', 'marker-charlie-73']) expect(all).not.toContain(m);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('Burn all asks first, then removes every conversation and what waits for the next question', async () => {
    const { ctx, page, errors } = await phone();
    await ready(page);
    await ask(page, 'First question marker-delta-81');
    await startFresh(page);
    await ask(page, 'Second question marker-echo-82');
    // A file waits for the next question, and a question is half typed.
    await page.goto(`${g.url}/v2/#/add`);
    await page.waitForSelector('#addSheet');
    await page.setInputFiles('#fileInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('Bring water marker-foxtrot-83') });
    await page.waitForSelector('#heldLine:not([hidden])');
    await page.goto(`${g.url}/v2/#/type`);
    await page.fill('#question', 'Half typed marker-golf-84');
    await page.waitForTimeout(300);
    let all = await dump(page);
    for (const m of ['marker-delta-81', 'marker-echo-82', 'marker-foxtrot-83', 'marker-golf-84']) expect(all).toContain(m);

    await openHistory(page);
    await expect.poll(() => historyWords(page)).toEqual(['Second question marker-echo-82', 'First question marker-delta-81']);
    // Keep them: nothing happens.
    await page.click('#burnAll');
    expect(await page.textContent('#burnAllConfirm')).toContain('Burn every conversation? This cannot be undone.');
    await page.click('#burnAllNo');
    expect(await page.locator('.hist-card').count()).toBe(2);
    await page.click('#burnAll');
    await page.click('#burnAllYes');
    await page.waitForSelector('#historyEmpty');
    expect(await page.isVisible('#burnAll')).toBe(false);
    all = await dump(page);
    for (const m of ['marker-delta-81', 'marker-echo-82', 'marker-foxtrot-83', 'marker-golf-84']) expect(all).not.toContain(m);
    // The balance is untouched: burn removes conversations, never money.
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toMatch(/^sk-forge-/);
    await page.goto(`${g.url}/v2/#/type`);
    expect(await page.inputValue('#question')).toBe('');
    expect(await page.locator('#attached .chip').count()).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);
});

describe('Auto-delete', () => {
  /** Writes conversations straight into the app's database, as if they were asked earlier. */
  const seed = (page: Page, convs: Array<{ id: string; q: string; ago: number }>, autoDelete: string) =>
    page.evaluate(
      async ({ convs, autoDelete }) => {
        const db = await new Promise<IDBDatabase>((res, rej) => {
          const r = indexedDB.open('forge2');
          r.onsuccess = () => res(r.result);
          r.onerror = () => rej(r.error);
        });
        await new Promise<void>((res, rej) => {
          const tx = db.transaction(['chats', 'kv'], 'readwrite');
          for (const c of convs) {
            const at = Date.now() - c.ago;
            tx.objectStore('chats').put({ id: c.id, createdAt: at, updatedAt: at, messages: [{ id: `m${c.id}`, role: 'user', content: c.q }] }, c.id);
          }
          const kv = tx.objectStore('kv');
          const r = kv.get('settings');
          r.onsuccess = () => kv.put({ ...(r.result ?? {}), autoDelete }, 'settings');
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error);
        });
        db.close();
      },
      { convs, autoDelete },
    );

  it('removes what ran out on open, and the rest by a timer while the app is open', async () => {
    const { ctx, page, errors } = await phone();
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=home]');
    const HOUR = 3_600_000;
    await seed(
      page,
      [
        { id: 'c_old', q: 'Old marker-hotel-91', ago: 2 * HOUR },
        { id: 'c_soon', q: 'Soon marker-india-92', ago: HOUR - 8_000 },
        { id: 'c_new', q: 'New marker-juliet-93', ago: 60_000 },
      ],
      'hour',
    );
    await page.reload();
    await page.waitForSelector('[data-screen=home]');
    // On open: the one past its hour is gone before anything is shown.
    let all = await dump(page);
    expect(all).not.toContain('marker-hotel-91');
    expect(all).toContain('marker-india-92');
    await openHistory(page);
    expect(await page.getAttribute('#auto-hour', 'aria-checked')).toBe('true');
    expect(await page.textContent('#historyIntro')).toBe('Each conversation is kept until its timer runs out, then it is gone.');
    await expect.poll(() => historyWords(page)).toEqual(['New marker-juliet-93', 'Soon marker-india-92']);
    expect(await page.locator('.burn-timer.soon').count()).toBe(1);
    // While open: the next one goes when its hour is up, and the open History screen follows.
    await expect.poll(() => historyWords(page), { timeout: 15_000 }).toEqual(['New marker-juliet-93']);
    all = await dump(page);
    expect(all).not.toContain('marker-india-92');
    expect(all).toContain('marker-juliet-93');

    // On close: everything goes when the app is closed or reloaded.
    await page.click('#auto-close');
    expect(await page.textContent('#historyIntro')).toBe('Each conversation is removed when Forge is closed or reloaded. If the phone stops Forge first, it is removed the next time Forge opens.');
    expect(await page.locator('.burn-timer').count()).toBe(0);
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector('[data-screen=history]');
    await page.waitForSelector('#historyEmpty');
    expect(await dump(page)).not.toContain('marker-juliet-93');

    // Never: kept however old.
    await page.click('#auto-off');
    await page.waitForTimeout(300);
    await seed(page, [{ id: 'c_ancient', q: 'Ancient marker-kilo-94', ago: 30 * 24 * HOUR }], 'off');
    await page.reload();
    await page.waitForSelector('[data-screen=history]');
    await expect.poll(() => historyWords(page)).toEqual(['Ancient marker-kilo-94']);
    expect(await page.textContent('#historyIntro')).toBe('Each conversation is kept on this phone until you burn it.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});

describe('Erase everything', () => {
  it('warns about the balance, offers Take funds out, needs a hold, and leaves nothing behind', async () => {
    const { ctx, page, errors } = await phone();
    // The Classic app on the same site: its worker, caches, database and settings go too.
    await page.goto(`${g.url}/`);
    await page.evaluate(() => navigator.serviceWorker.ready);
    await page.evaluate(() => localStorage.setItem('forge.settings', '{"theme":"dark"}'));
    await ready(page);
    await ask(page, 'Something to erase marker-lima-95');
    // Both workers (Classic at /, v2 at /v2/) are installed before erasing.
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).filter((r) => r.active).length), { timeout: 15_000 }).toBe(2);
    const before = await leftovers(page);
    expect(before.localStorage).toBeGreaterThan(0);
    expect(before.databases).toContain('forge2');
    expect(before.caches.length).toBeGreaterThan(0);

    await page.goto(`${g.url}/v2/#/`);
    await page.click('#btn-more');
    await page.click('#moreErase');
    await page.waitForSelector('[data-screen=erase]');
    expect(await page.textContent('#eraseLine')).toBe('This cannot be undone. Forge keeps no copy of your conversations, so nothing can be restored.');
    await expect.poll(() => page.textContent('#eraseMoney b')).toMatch(/^Your \$\d\.\d+ balance is lost$/);
    expect(await page.textContent('#eraseGoes')).toContain('The balance key. Without it the balance cannot be used.');
    expect(await page.textContent('#eraseAuto')).toContain('1 day');
    // Take funds out first: the offer goes to the Take funds out screen.
    expect(await page.textContent('#eraseTakeOut')).toMatch(/^Take out \$\d\.\d\d first$/);
    await page.click('#eraseTakeOut');
    await page.waitForSelector('[data-screen=takeOut]');
    await page.click('.back-head .round');
    await page.waitForSelector('[data-screen=erase]');

    // A tap, by finger or keyboard, erases nothing.
    await page.click('#eraseHold');
    await expect.poll(() => page.textContent('.foot .msg')).toBe('Hold the button down to erase. A tap does nothing.');
    await page.focus('#eraseHold');
    await page.keyboard.down('Enter');
    await page.waitForTimeout(400);
    await page.keyboard.up('Enter');
    await page.waitForTimeout(2_000);
    expect(await page.isVisible('[data-screen=erase]')).toBe(true);
    expect(await page.evaluate(() => localStorage.getItem('forge.balanceKey'))).toMatch(/^sk-forge-/);

    // Held for two seconds: everything goes.
    const box = (await page.locator('#eraseHold').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(2_300);
    await page.mouse.up();
    await page.waitForSelector('[data-screen=erased]');
    expect(await page.getAttribute('[data-screen=erased]', 'data-ok')).toBe('true');
    expect(await page.textContent('#erasedBody')).toBe("Forge's conversations, settings, eCash and balance key are gone from this browser.");
    const empty = { localStorage: 0, sessionStorage: 0, databases: [], caches: [], workers: 0 };
    expect(await leftovers(page)).toEqual(empty);
    // Nothing is written back afterwards by work that was still under way.
    await page.waitForTimeout(1_500);
    expect(await leftovers(page)).toEqual(empty);

    // Opened again, it starts from nothing: no balance, no conversation.
    await page.click('#erasedAgain');
    await page.waitForSelector('[data-screen=home]');
    await expect.poll(() => page.textContent('#balanceText')).toBe('Add funds');
    await openHistory(page);
    await page.waitForSelector('#historyEmpty');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('erases by keyboard too: Space held down for two seconds', async () => {
    const { ctx, page } = await phone();
    await page.goto(`${g.url}/v2/#/more/erase`);
    await page.waitForSelector('[data-screen=erase]');
    expect(await page.isVisible('#eraseMoney')).toBe(false); // no balance, nothing to warn about
    await page.focus('#eraseHold');
    await page.keyboard.down(' ');
    await page.waitForTimeout(2_300);
    await page.keyboard.up(' ');
    await page.waitForSelector('[data-screen=erased]');
    expect(await leftovers(page)).toEqual({ localStorage: 0, sessionStorage: 0, databases: [], caches: [], workers: 0 });
    await ctx.close();
  }, 60_000);

  it('fits 360 px with no sideways scrolling and 44 px touch targets', async () => {
    const { ctx, page } = await phone({ viewport: { width: 360, height: 740 } });
    await ready(page);
    await ask(page, 'A question for the list');
    for (const route of ['more', 'more/history', 'more/erase', 'answer']) {
      await page.goto(`${g.url}/v2/#/${route}`);
      await page.waitForSelector('[data-screen]');
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => document.documentElement.scrollWidth), route).toBeLessThanOrEqual(360);
      const small = await page.locator('main button:visible').evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0 && (r.width < 44 || r.height < 44)).length);
      expect(small, `touch targets on ${route}`).toBe(0);
    }
    await ctx.close();
  }, 90_000);
});
