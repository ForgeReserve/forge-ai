import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// The Private (or Standard) chip at the top left (owner, 2026-11-17), tapped with a finger in Default and
// in Playful: one tap switches the kind of model; leaving Private asks Start free's question the first
// time only, and a no changes nothing; it goes back to the models last chosen of each kind; nothing else
// in the top row moves; it survives a reload; and the next question goes to the model it chose, also when
// it was tapped while an answer came in. TOGGLE_SHOTS=1 saves screenshots to .tmp/toggle-shots/.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = process.env.TOGGLE_SHOTS ? resolve(import.meta.dirname, '../../.tmp/toggle-shots') : null;
const EN: Record<string, string> = (await import('../../public/v2/strings/en.js' as string)).default;

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true' },
    editCatalog: (c) => {
      // Two Private models (the dear one listed first) and a free fast Standard one beside the mock ones.
      const enc = c.models.find((m: any) => m.id === 'tinfoil/enc-model');
      enc.name = 'Big Private';
      c.models.push({ ...enc, id: 'tinfoil/enc-cheap', name: 'Cheap Private', upstream: 'enc-cheap', input_usd_per_mtok: 10, output_usd_per_mtok: 100 });
      c.models.find((m: any) => m.id === 'mock-echo').name = 'Echo';
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'glm-5.3-flash', name: 'GLM Flash', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256, speed: 'fast' });
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function fundedKey(): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', 300);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

type Mode = 'default' | 'playful';

interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  /** The model of every question the page sent: a Standard one's from its body, a Private one's (encrypted) as `enc:` and its upstream name. */
  sent: string[];
}

/** A funded phone past the first run, on the home in `mode`, with Private only on (the default). */
async function phone(mode: Mode): Promise<Phone> {
  const ctx = await browser.newContext(PHONE);
  await pastFirstRun(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const sent: string[] = [];
  page.on('request', (r) => {
    if (r.method() !== 'POST' || !new URL(r.url()).pathname.endsWith('/chat/completions')) return;
    const enc = r.headers()['x-tinfoil-model'];
    sent.push(enc ? `enc:${enc}` : JSON.parse(r.postData() ?? '{}').model);
  });
  await page.goto(`${g.url}/v2/`);
  await page.waitForSelector('[data-screen=home]');
  const key = await fundedKey();
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  if (mode === 'playful') {
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.waitForSelector('[data-screen=look]');
    await page.click('#mode-playful');
    await expect.poll(() => page.getAttribute('#mode-playful', 'aria-checked'), { timeout: 10_000 }).toBe('true');
    // This file tests the helper's screens: the app opens straight on them.
    if ((await page.getAttribute('#gameFirst', 'aria-checked')) === 'true') await page.click('#gameFirst');
    await expect.poll(() => settings(page).then((s) => s?.gameFirst)).toBe(false);
  }
  await page.goto(`${g.url}/v2/#/`);
  await home(page, mode);
  return { ctx, page, errors, sent };
}

const home = (page: Page, mode: Mode) => page.waitForSelector(mode === 'playful' ? '[data-screen=home][data-mode=playful]' : '[data-screen=home]:not([data-mode])');

/** The settings as the app saved them in its database. */
const settings = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<any>((done) => {
        const open = indexedDB.open('forge2');
        open.onsuccess = () => {
          const db = open.result;
          if (![...db.objectStoreNames].includes('kv')) return done(null);
          const r = db.transaction('kv').objectStore('kv').get('settings');
          r.onsuccess = () => done(r.result ?? null);
          r.onerror = () => done(null);
        };
        open.onerror = () => done(null);
      }),
  );

/** Every stored conversation, oldest first. */
const conversations = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<any[]>((done) => {
        const open = indexedDB.open('forge2');
        open.onsuccess = () => {
          const db = open.result;
          if (![...db.objectStoreNames].includes('chats')) return done([]);
          const r = db.transaction('chats').objectStore('chats').getAll();
          r.onsuccess = () => done((r.result as any[]).sort((a, b) => a.createdAt - b.createdAt));
        };
      }),
  );

/** True once the last stored conversation ends on an answer with words in it (saved when it is complete). */
const answered = async (page: Page) => {
  const last = (await conversations(page)).at(-1)?.messages?.at(-1);
  return last?.role === 'assistant' && !!last.content;
};

const kind = (page: Page) => page.getAttribute('#privacyPill', 'data-kind');
const label = (page: Page) => page.getAttribute('#privacyPill', 'aria-label');

/** What the app said last: the toast on Default, Pip's words on Playful (its bubble, or its line on the answer). */
const said = (page: Page) =>
  page.evaluate(() => {
    const n = document.querySelector('[data-mode=playful] #pipSays, [data-mode=playful] #pipLine') ?? document.querySelector('#toast.show');
    if (!n) return '';
    const c = n.cloneNode(true) as HTMLElement;
    for (const x of c.querySelectorAll('.info-btn, [hidden]')) x.remove();
    return (c.textContent ?? '').replace(/\s+/g, ' ').trim();
  });

/** The chip and the other controls of the top row, where they are now. */
const topRow = (page: Page) =>
  page.evaluate(() =>
    ['#privacyPill', '#balancePill', '#starChip', '#gameBtn']
      .map((s) => document.querySelector(s) as HTMLElement | null)
      .filter((n) => n && !n.hidden)
      .map((n) => {
        const r = n!.getBoundingClientRect();
        return { id: n!.id, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      }),
  );

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: resolve(SHOTS, name) });
}

/** One tap with a finger on the chip. */
const tapChip = (page: Page) => page.locator('#privacyPill').tap();

async function ask(page: Page, q: string) {
  await page.locator('#btn-type').tap();
  await page.fill('#question', q);
  await page.locator('#sendBtn').tap();
  await page.waitForSelector('[data-screen=answer]');
}

/** Chooses a model on Choose a model (More), with Private only as `privateOnly`. */
async function chooseModel(page: Page, mode: Mode, id: string, privateOnly: boolean) {
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) !== String(privateOnly)) await page.locator('#privateOnly').tap();
  await page.locator(`[data-model="${id}"]`).tap();
  await page.waitForSelector('[data-screen=model]', { state: 'detached' });
  await page.goto(`${g.url}/v2/#/`);
  await home(page, mode);
}

for (const mode of ['default', 'playful'] as const) {
  describe(`the Private chip in ${mode}`, () => {
    it('one tap each way; the question once, a no changes nothing; nothing else in the top row moves; kept after a reload', async () => {
      const { ctx, page, errors } = await phone(mode);
      expect(await kind(page)).toBe('private');
      expect(await label(page)).toBe('Private model. Tap for Standard.');
      expect(await page.textContent('#privacyPill')).toBe('Private');
      const row = await topRow(page);
      const chip = row.find((r) => r.id === 'privacyPill')!;
      expect(chip.h).toBeGreaterThanOrEqual(48);
      expect(chip.w).toBeGreaterThanOrEqual(48);
      await shot(page, `${mode}-home-private.png`);

      // The first step down asks Start free's question (the default Standard model is the free one).
      await tapChip(page);
      await page.waitForSelector('#kindAsk[open]');
      expect(await page.textContent('#kindAskText')).toBe(EN['startFree.ask']);
      expect(await page.getAttribute('#kindAskText', 'data-approved')).toBe('');
      if (SHOTS) {
        await page.waitForFunction(() => document.querySelector('#kindAsk .sf-sheet')!.getAnimations().every((a) => a.playState === 'finished'));
        await shot(page, `${mode}-question.png`);
      }
      // No: nothing changes, and nothing is kept.
      await page.locator('#kindKeep').tap();
      await page.waitForSelector('#kindAsk', { state: 'detached' });
      expect(await kind(page)).toBe('private');
      const s0 = await settings(page);
      expect(s0?.privateOnly ?? true).toBe(true);
      expect(s0?.standardOk ?? false).toBe(false);
      expect(s0?.model ?? '').toBe('');

      // Asked again, since the no was not a yes; Use Standard.
      await tapChip(page);
      await page.waitForSelector('#kindAsk[open]');
      await page.locator('#kindUse').tap();
      await page.waitForSelector('#kindAsk', { state: 'detached' });
      await expect.poll(() => kind(page)).toBe('standard');
      expect(await label(page)).toBe('Standard model. Tap for Private.');
      expect(await page.textContent('#privacyPill')).toBe('Standard');
      await expect.poll(() => said(page)).toContain('GLM Flash');
      await expect.poll(() => settings(page)).toMatchObject({ privateOnly: false, model: 'glm-5.3-flash', lastStandard: 'glm-5.3-flash', standardOk: true });
      // The chip did not change its size, and nothing beside it moved.
      expect(await topRow(page)).toEqual(row);
      await shot(page, `${mode}-home-standard.png`);

      // Back to Private: never asked; the cheapest Private model (none was chosen before).
      await tapChip(page);
      await expect.poll(() => kind(page)).toBe('private');
      expect(await page.locator('#kindAsk').count()).toBe(0);
      await expect.poll(() => said(page)).toContain('Cheap Private');
      await expect.poll(() => settings(page)).toMatchObject({ model: 'tinfoil/enc-cheap', lastPrivate: 'tinfoil/enc-cheap' });
      // And down again: the yes is kept, so no question.
      await tapChip(page);
      await expect.poll(() => kind(page)).toBe('standard');
      expect(await page.locator('#kindAsk').count()).toBe(0);
      expect(await topRow(page)).toEqual(row);

      // After a reload (once the settings are written): still Standard, and still no question on the way down.
      await expect.poll(() => settings(page)).toMatchObject({ model: 'glm-5.3-flash', privateOnly: false, standardOk: true });
      await page.reload();
      await home(page, mode);
      await expect.poll(() => kind(page)).toBe('standard');
      await tapChip(page);
      await expect.poll(() => kind(page)).toBe('private');
      await expect.poll(() => said(page)).toContain('Cheap Private');
      await tapChip(page);
      await expect.poll(() => kind(page)).toBe('standard');
      expect(await page.locator('#kindAsk').count()).toBe(0);

      // What Private and Standard mean: one tap on the info mark beside each heading in Choose a model.
      await page.goto(`${g.url}/v2/#/more/model`);
      await page.waitForSelector('[data-screen=model]');
      for (const [id, key] of [['private', 'status.privateLabel'], ['standard', 'status.standardLabel']] as const) {
        const about = page.locator(`#group-${id} .group-about`);
        expect(await about.isVisible()).toBe(false);
        await page.locator(`#groupInfo-${id}`).tap();
        await expect.poll(() => about.isVisible()).toBe(true);
        expect(await about.textContent()).toBe(EN[key]);
      }
      expect(errors).toEqual([]);
      await ctx.close();
    }, 90_000);

    it('goes back to the models chosen on Choose a model, and the next question goes to the one it chose', async () => {
      const { ctx, page, errors, sent } = await phone(mode);
      await chooseModel(page, mode, 'tinfoil/enc-model', true);
      await chooseModel(page, mode, 'mock-echo', false);
      expect(await kind(page)).toBe('standard');
      // To Private: the one chosen last of that kind, though another is cheaper.
      await tapChip(page);
      await expect.poll(() => kind(page)).toBe('private');
      await expect.poll(() => said(page)).toContain('Big Private');
      // To Standard: the question first (never answered yet on this phone), in its words for a paid model.
      await tapChip(page);
      await page.waitForSelector('#kindAsk[open]');
      expect(await page.textContent('#kindAskText')).toBe(EN['privacy.ask']);
      await page.locator('#kindUse').tap();
      await expect.poll(() => kind(page)).toBe('standard');
      await expect.poll(() => said(page)).toContain('Echo');
      expect((await settings(page))?.model).toBe('mock-echo');

      // A question now goes to Echo.
      await ask(page, 'First?');
      await expect.poll(() => sent).toEqual(['mock-echo']);
      await expect.poll(() => answered(page), { timeout: 20_000 }).toBe(true);
      await shot(page, `${mode}-answer-standard.png`);
      // Switched on the answer screen: the answer stays, and the next question starts a new conversation
      // with the Private model.
      await tapChip(page);
      await expect.poll(() => kind(page)).toBe('private');
      await expect.poll(() => said(page)).toContain(EN['model.chosenNext']!.replace('{name}', 'Big Private'));
      expect(await page.locator('[data-screen=answer]').count()).toBe(1);
      expect(await page.textContent('[data-screen=answer]')).toContain('First?');
      await shot(page, `${mode}-answer-private.png`);
      await ask(page, 'Second?');
      await expect.poll(async () => (await conversations(page)).at(-1)?.messages?.length, { timeout: 20_000 }).toBe(2);
      const last = (await conversations(page)).at(-1);
      expect((await conversations(page)).length).toBe(2);
      expect(last.messages.map((m: any) => m.role)).toEqual(['user', 'assistant']);
      expect(last.messages[0].content).toBe('Second?');
      expect(last.messages[1].meta.model).toBe('tinfoil/enc-model');
      // It went out encrypted, to the Private model; nothing more went out as a Standard question.
      expect(sent).toEqual(['mock-echo', 'enc:enc-model']);
      expect(errors).toEqual([]);
      await ctx.close();
    }, 90_000);

    it('tapped while an answer comes in: the answer goes on, and the next question goes to the new model', async () => {
      const { ctx, page, errors, sent } = await phone(mode);
      await chooseModel(page, mode, 'mock-echo', false);
      let release = () => {};
      const gate = new Promise<void>((r) => (release = r));
      await page.route('**/v1/chat/completions', async (route) => (await gate, route.continue().catch(() => {})));
      await ask(page, 'Still coming?');
      await expect.poll(() => sent).toEqual(['mock-echo']);
      await tapChip(page);
      await expect.poll(() => kind(page)).toBe('private');
      await expect.poll(() => said(page)).toContain(EN['model.chosenNext']!.replace('{name}', 'Cheap Private'));
      release();
      // The answer was not stopped: it came in whole, from Echo, in its own conversation.
      await expect.poll(() => answered(page), { timeout: 20_000 }).toBe(true);
      const first = (await conversations(page)).at(-1);
      expect(first.messages.at(-1).meta.model).toBe('mock-echo');
      expect(first.messages.at(-1).meta.stopped).toBeUndefined();
      await ask(page, 'And now?');
      await expect.poll(async () => (await conversations(page)).at(-1)?.messages?.length, { timeout: 20_000 }).toBe(2);
      expect((await conversations(page)).length).toBe(2);
      const next = (await conversations(page)).at(-1);
      expect(next.messages[0].content).toBe('And now?');
      expect(next.messages.length).toBe(2);
      expect(next.messages[1].meta.model).toBe('tinfoil/enc-cheap');
      expect(sent).toEqual(['mock-echo', 'enc:enc-cheap']);
      expect(errors).toEqual([]);
      await ctx.close();
    }, 90_000);
  });
}

describe('the Private chip with only one kind of model listed', () => {
  /** The engine's list with only the Private, or only the Standard, models. */
  const only = (page: Page, priv: boolean) =>
    page.route('**/v1/models', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.data = body.data.filter((m: any) => (m.tier === 'enclave') === priv);
      await route.fulfill({ response: res, json: body });
    });

  /** Once the app has the engine's list (it keeps a copy as it takes it). */
  const listed = (page: Page) => expect.poll(() => page.evaluate(() => !!localStorage.getItem('forge2.models'))).toBe(true);

  it('says so in a short toast and changes nothing', async () => {
    const ctx = await browser.newContext(PHONE);
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await only(page, true);
    await page.goto(`${g.url}/v2/#/`);
    await home(page, 'default');
    await listed(page);
    expect(await page.getAttribute('#privacyPill', 'title')).toBe(EN['status.privateLabel']);
    await tapChip(page);
    await expect.poll(() => said(page)).toBe(EN['privacy.noStandard']);
    expect(await page.locator('#kindAsk').count()).toBe(0);
    expect(await kind(page)).toBe('private');
    await ctx.close();

    const ctx2 = await browser.newContext(PHONE);
    await pastFirstRun(ctx2);
    const page2 = await ctx2.newPage();
    await only(page2, false);
    await page2.goto(`${g.url}/v2/#/`);
    await home(page2, 'default');
    await listed(page2);
    // Private only hides every model here: Private still, as before. A tap asks, then uses Standard.
    expect(await kind(page2)).toBe('private');
    await tapChip(page2);
    await page2.waitForSelector('#kindAsk[open]');
    await page2.locator('#kindUse').tap();
    await expect.poll(() => kind(page2)).toBe('standard');
    await tapChip(page2);
    await expect.poll(() => said(page2)).toBe(EN['privacy.noPrivate']);
    expect(await kind(page2)).toBe('standard');
    await ctx2.close();
  }, 60_000);
});
