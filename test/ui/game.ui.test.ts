import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, MINT_A, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Playful's cover game, Pip's Garden (docs/PLAYFUL.md, The cover game), in a phone-sized Chrome: Playful
// opens on the game with the helper behind it; swaps that match and swaps that slide back; Pip held three
// seconds opens the helper and a shorter hold does not; the game button and Back put the game back; a
// reload and the app put away and brought back show the game; "Open as a game first" off opens the helper;
// the game screen shows nothing of the app; the fit at 360 by 640 and 412 by 915; play with the keyboard;
// messages held until the helper opens; Erase everything removes the game's record; and Default fetches
// nothing of the game. GAME_SHOTS=1 also saves screenshots to .tmp/game-shots.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = process.env.GAME_SHOTS ? resolve(import.meta.dirname, '../../.tmp/game-shots') : null;
const G: any = await import('../../public/v2/modules/mode/playful/games/garden/logic.js' as string);

let g: Gateway;
let browser: Browser;
let modelNames: string[] = [];

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({ env: { FORGE_INVITE_ONLY: 'true' } });
  const models: any = await (await fetch(`${g.url}/v1/models`)).json();
  modelNames = models.data.flatMap((m: any) => [m.id, m.name]).filter(Boolean);
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

interface Phone {
  ctx: BrowserContext;
  page: Page;
  errors: string[];
  asked: string[];
}

/**
 * A phone past the first run with a $3 balance and Private only off. playful: Playful chosen in Mode and
 * look, with "Open as a game first" as it comes (on), then the app opened fresh.
 */
async function phone({ viewport = PHONE.viewport, playful = true, reduce = false } = {}): Promise<Phone> {
  const ctx = await browser.newContext({ ...PHONE, viewport, reducedMotion: reduce ? 'reduce' : 'no-preference' });
  await pastFirstRun(ctx);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${m.text()} ${m.location().url}`));
  const asked: string[] = [];
  page.on('request', (r) => asked.push(new URL(r.url()).pathname));
  await page.goto(`${g.url}/v2/`);
  await page.waitForSelector('[data-screen=home]');
  const key = await fundedKey();
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  await page.click('#privateOnly');
  await page.click('[data-model="mock-echo"]');
  if (playful) {
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.waitForSelector('[data-screen=look]');
    await page.click('#mode-playful');
    await expect.poll(() => page.getAttribute('#mode-playful', 'aria-checked')).toBe('true');
    await page.goto(`${g.url}/v2/#/`);
    await page.reload();
    await onGame(page);
  }
  return { ctx, page, errors, asked };
}

const onGame = (page: Page) => page.waitForSelector('[data-screen=game][data-mode=playful]');
const onHelper = (page: Page) => page.waitForSelector('[data-screen=home][data-mode=playful]');
const textOf = (page: Page, sel: string) => page.$eval(sel, (n) => (n.textContent ?? '').trim());
/** The board as the cells say it (data-kind on each). */
const boardOf = (page: Page): Promise<number[]> => page.$$eval('.gd-cell', (cs) => cs.map((c) => Number((c as HTMLElement).dataset.kind)));
const cell = (i: number) => `.gd-cell[data-i="${i}"]`;
const count = async (page: Page, sel: string) => Number((await textOf(page, sel)).replace(/\D/g, ''));
/** A swap of neighbours that makes no match. */
function badSwap(b: number[]): [number, number] {
  for (let i = 0; i < 25; i++) for (const d of ['right', 'down']) {
    const j = G.step(i, d);
    if (j >= 0 && b[i] !== b[j] && !G.canSwap(b, i, j)) return [i, j];
  }
  throw new Error('no swap without a match');
}
/** Drags from one cell's middle onto another's. */
async function drag(page: Page, a: number, b: number) {
  const ra = (await page.locator(cell(a)).boundingBox())!;
  const rb = (await page.locator(cell(b)).boundingBox())!;
  await page.mouse.move(ra.x + ra.width / 2, ra.y + ra.height / 2);
  await page.mouse.down();
  await page.mouse.move(rb.x + rb.width / 2, rb.y + rb.height / 2, { steps: 5 });
  await page.mouse.up();
}
/** Holds Pip down for `ms`. */
async function holdPip(page: Page, ms: number) {
  const r = (await page.locator('#pipBtn').boundingBox())!;
  await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(ms);
  await page.mouse.up();
}
/** The app put away and brought back, as a phone does (the page hidden, then shown). */
async function awayAndBack(page: Page) {
  for (const state of ['hidden', 'visible']) {
    await page.evaluate((s) => {
      Object.defineProperty(document, 'visibilityState', { value: s, configurable: true });
      Object.defineProperty(document, 'hidden', { value: s === 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await page.waitForTimeout(150);
  }
}
/** What a person sees: the visible words on the page, and its title. */
const seen = (page: Page) => page.evaluate(() => `${document.title}\n${document.body.innerText}`);
const inView = (page: Page, sel: string) =>
  page.$eval(sel, (n) => {
    const r = n.getBoundingClientRect();
    return r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5;
  });
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, name) });
}

describe("Pip's Garden", () => {
  it('Default fetches nothing of the game; Playful opens on it, and it shows nothing of the app', async () => {
    const d = await phone({ playful: false });
    expect(d.asked.filter((p) => /mode\/playful\/(cover\.js|games\/)/.test(p))).toEqual([]);
    expect(await d.page.evaluate(() => document.title)).toBe('Forge AI');
    await d.ctx.close();

    const { ctx, page, errors, asked } = await phone();
    expect(asked.some((p) => p.endsWith('/games/garden/logic.js'))).toBe(true);
    // The design's cover: the name, the level, the line, a 5 by 5 board, the counts and Pip's card.
    expect(await textOf(page, '.gd-title')).toBe("Pip's Garden");
    expect(await textOf(page, '#gameLevel')).toBe('Level 1');
    expect(await textOf(page, '.gd-how')).toBe('Match three to grow the garden.');
    expect(await page.locator('.gd-cell').count()).toBe(25);
    expect(await page.locator('.gd-tile').count()).toBe(25);
    expect(await textOf(page, '#gameMoves')).toBe('Moves 15');
    expect(await textOf(page, '#gameFlowers')).toBe('Flowers 0');
    expect(await textOf(page, '#gameSub')).toBe('Five more matches to bloom.');
    expect(await page.getAttribute('#pipBtn', 'aria-label')).toBe('Pip');
    // Four colours, each with its own picture.
    const colours = await page.$$eval('.gd-tile', (ts) => [...new Set(ts.map((t) => getComputedStyle(t).backgroundColor))].sort());
    expect(colours.every((c) => ['rgb(255, 210, 63)', 'rgb(61, 220, 151)', 'rgb(255, 138, 122)', 'rgb(127, 212, 255)'].includes(c))).toBe(true);
    for (const k of [0, 1, 2, 3]) {
      const shapes = await page.$$eval(`.gd-tile.k${k} svg`, (s) => [...new Set(s.map((x) => x.innerHTML))]);
      if (shapes.length) expect(shapes, `kind ${k}`).toHaveLength(1);
    }
    // No Forge, no price, no balance, no model, in the words on show or the title; the game's icon and bar colour.
    const words = await seen(page);
    expect(words).not.toMatch(/forge|\$|\bsats?\b|balance|wallet|private|standard|ecash|price|model/i);
    for (const name of modelNames) expect(words).not.toContain(name);
    expect(await page.evaluate(() => document.title)).toBe("Pip's Garden");
    expect(await page.getAttribute('meta[name="theme-color"]', 'content')).toBe('#4B3FC9');
    expect(await page.getAttribute('link[rel="icon"]', 'href')).toMatch(/games\/garden\/icon\.svg$/);
    expect(await page.$$eval('[aria-label]', (n) => n.map((x) => x.getAttribute('aria-label')).join('|'))).not.toMatch(/forge|balance|money/i);
    await shot(page, 'game-412x915-fresh.png');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a swap that matches clears, scores and drops new tiles; one that does not slides back and costs nothing', async () => {
    const { ctx, page, errors } = await phone();
    const before = await boardOf(page);
    const [x, y] = badSwap(before);
    await page.click(cell(x));
    expect(await page.getAttribute(cell(x), 'aria-pressed')).toBe('true');
    await page.click(cell(y));
    await expect.poll(() => textOf(page, '#gameSay'), { timeout: 5000 }).toBe('No match.');
    expect(await textOf(page, '#gameSub')).toBe('Try another swap.');
    expect(await boardOf(page)).toEqual(before);
    expect(await count(page, '#gameMoves')).toBe(15);
    // The tiles went back to their own cells.
    const at = (i: number) => page.$eval(`.gd-tile:nth-child(${i + 1})`, (t) => (t as HTMLElement).style.getPropertyValue('--c') + ',' + (t as HTMLElement).style.getPropertyValue('--r'));
    expect(await at(x)).toBe(`${x % 5},${Math.floor(x / 5)}`);

    const [a, b] = G.findMove(before);
    await drag(page, a, b);
    await expect.poll(() => count(page, '#gameMoves'), { timeout: 10_000 }).toBe(14);
    await expect.poll(() => count(page, '#gameFlowers'), { timeout: 10_000 }).toBeGreaterThanOrEqual(30);
    // A long chain can make all five matches at once and finish the level.
    expect(['Nice move!', 'Wow, a chain!', 'No moves left. New tiles!', 'The garden bloomed!']).toContain(await textOf(page, '#gameSay'));
    expect(await textOf(page, '#gameSub')).toMatch(/^(One|Two|Three|Four) more match(es)? to bloom\.$|^Level 1 done\.$/);
    const after = await boardOf(page);
    expect(G.findRuns(after)).toEqual([]);
    expect(G.hasMove(after)).toBe(true);
    // The tiles on show are the board the cells say.
    await expect.poll(() => page.$$eval('.gd-tile:not(.gone)', (ts) => ts.length)).toBe(25);
    await shot(page, 'game-412x915-mid.png');
    // The progress is kept: a reload opens the same level and flowers.
    const flowers = await count(page, '#gameFlowers');
    // On a lucky board that one move made all five matches: the level is done, and what is kept is the
    // next level, with its own board and moves.
    const bloomed = (await textOf(page, '#gameSub')) === 'Level 1 done.';
    await page.reload();
    await onGame(page);
    expect(await count(page, '#gameFlowers')).toBe(flowers);
    if (bloomed) {
      expect(await count(page, '#gameLevel')).toBe(2);
      expect(await count(page, '#gameMoves')).toBe(15);
    } else {
      expect(await count(page, '#gameMoves')).toBe(14);
      expect(await boardOf(page)).toEqual(after);
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a level is done when its matches are made, and out of moves offers Play again', async () => {
    const { ctx, page, errors } = await phone();
    // Four of level 1's five matches made already, and one move left.
    const board = G.newBoard(Math.random);
    await page.evaluate(async (game) => {
      const db: IDBDatabase = await new Promise((r) => (indexedDB.open('forge2', 1).onsuccess = (e: any) => r(e.target.result)));
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(game, 'game');
      await new Promise((r) => (tx.oncomplete = r));
      db.close();
    }, { v: 1, level: 1, flowers: 120, moves: 1, made: 4, board });
    await page.reload();
    await onGame(page);
    expect(await textOf(page, '#gameSub')).toBe('One more match to bloom.');
    const [a, b] = G.findMove(board);
    await drag(page, a, b);
    await page.waitForSelector('#gameNext');
    expect(await textOf(page, '#gameSay')).toBe('The garden bloomed!');
    expect(await textOf(page, '#gameSub')).toBe('Level 1 done.');
    await shot(page, 'game-412x915-level-done.png');
    await page.click('#gameNext');
    await expect.poll(() => textOf(page, '#gameLevel')).toBe('Level 2');
    expect(await textOf(page, '#gameMoves')).toBe('Moves 15');
    expect(await textOf(page, '#gameSub')).toBe('Six more matches to bloom.');

    // Out of moves at level 2.
    const b2 = await boardOf(page);
    await page.evaluate(async (game) => {
      const db: IDBDatabase = await new Promise((r) => (indexedDB.open('forge2', 1).onsuccess = (e: any) => r(e.target.result)));
      const tx = db.transaction('kv', 'readwrite');
      tx.objectStore('kv').put(game, 'game');
      await new Promise((r) => (tx.oncomplete = r));
      db.close();
    }, { v: 1, level: 2, flowers: 300, moves: 1, made: 0, board: b2 });
    await page.reload();
    await onGame(page);
    const [c, d] = G.findMove(b2);
    await drag(page, c, d);
    // One move can chain into several matches: if it made all six, the level is done instead.
    await page.waitForSelector('#gameAgain, #gameNext');
    if ((await textOf(page, '#gameSay')) !== 'The garden bloomed!') {
      expect(await textOf(page, '#gameSay')).toBe('Out of moves.');
      await page.click('#gameAgain');
      await expect.poll(() => textOf(page, '#gameMoves')).toBe('Moves 15');
      expect(await textOf(page, '#gameLevel')).toBe('Level 2');
    }
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('Pip held three seconds opens the helper; a shorter hold is a game line; the game button and Back put the game back', async () => {
    const { ctx, page, errors } = await phone();
    const said = await textOf(page, '#gameSay');
    await holdPip(page, 1000);
    await page.waitForTimeout(300);
    expect(await page.$('[data-screen=game]')).not.toBeNull();
    expect(await textOf(page, '#gameSay')).not.toBe(said);
    expect(await textOf(page, '#gameSay')).toBe('Swap two tiles to make three in a row.');
    // While held, nothing on the page changes: no ring, no fill, no count.
    const r = (await page.locator('#pipBtn').boundingBox())!;
    const still = await page.evaluate(() => document.querySelector('main')!.innerHTML);
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => document.querySelector('main')!.innerHTML)).toBe(still);
    await page.waitForTimeout(1700);
    await page.mouse.up();
    await onHelper(page);
    expect(await page.evaluate(() => document.title)).toBe('Forge AI');
    // The helper's top row has the game button: one tap, the game again.
    await page.waitForSelector('#gameBtn:not([hidden])');
    expect(await page.getAttribute('#gameBtn', 'aria-label')).toBe('Show the game');
    await shot(page, 'helper-412x915-game-button.png');
    await page.click('#gameBtn');
    await onGame(page);
    expect(await page.evaluate(() => document.title)).toBe("Pip's Garden");
    // Back from the game never shows the helper.
    await page.goBack();
    await page.waitForTimeout(300);
    expect(await page.$('[data-screen=home]')).toBeNull();
    await onGame(page);
    // Into the helper again, a few screens deep, then Back from its home: the game.
    await holdPip(page, 3200);
    await onHelper(page);
    await page.click('#btn-more');
    await page.waitForSelector('#moreSheet');
    await page.click('#btn-more');
    await page.waitForSelector('#moreSheet', { state: 'detached' });
    await page.goBack();
    await onGame(page);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a reload, the app put away and brought back, and an address of the helper all show the game', async () => {
    const { ctx, page, errors } = await phone();
    await holdPip(page, 3200);
    await onHelper(page);
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await awayAndBack(page);
    await onGame(page);
    expect(await page.$('[data-screen=type]')).toBeNull();
    await holdPip(page, 3200);
    await onHelper(page);
    await page.reload();
    await onGame(page);
    // Opened fresh on a helper address: the game.
    await page.goto(`${g.url}/v2/#/funds`);
    await onGame(page);
    await page.goto('about:blank');
    await page.goto(`${g.url}/v2/#/more/model`);
    await onGame(page);
    expect(await page.evaluate(() => document.title)).toBe("Pip's Garden");
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("holds the app's messages while the game shows, and Pip says them once the helper opens", async () => {
    const { ctx, page, errors } = await phone();
    // The app's own toast, as a top-up finishing would send it.
    await page.addScriptTag({ type: 'module', content: "import { toast } from '/v2/core/ui.js'; toast('Your balance is ready.', 4000);" });
    await page.waitForTimeout(300);
    expect(await page.$('#toast.show')).toBeNull();
    expect(await seen(page)).not.toContain('balance');
    await holdPip(page, 3200);
    await onHelper(page);
    await expect.poll(() => textOf(page, '#pipSays')).toContain('Your balance is ready.');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('with "Open as a game first" off, Playful opens on the helper, as before', async () => {
    const { ctx, page, errors } = await phone();
    await holdPip(page, 3200);
    await onHelper(page);
    await page.click('#btn-more');
    await page.click('#moreLook');
    await page.waitForSelector('[data-screen=look]');
    expect(await textOf(page, '#gameFirst')).toBe('Open as a game firstOn');
    expect(await textOf(page, '#coverWarn')).toBe('This hides Forge from a quick look at your screen. It does not hide it from someone who searches the phone.');
    expect(await page.textContent('#coverNote')).toContain('Hold Pip 3 seconds to open the helper.');
    await page.click('#gameFirst');
    await expect.poll(() => page.getAttribute('#gameFirst', 'aria-checked')).toBe('false');
    // The setting is written to the database a moment later.
    await page.waitForTimeout(300);
    await page.reload();
    await page.waitForSelector('[data-screen=look]');
    await page.goto(`${g.url}/v2/#/`);
    await page.reload();
    await onHelper(page);
    expect(await page.isVisible('#gameBtn')).toBe(false);
    await awayAndBack(page);
    await onHelper(page);
    // Default: the row and the warning are not shown.
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.click('#mode-default');
    await expect.poll(() => page.getAttribute('#mode-default', 'aria-checked')).toBe('true');
    expect(await page.isVisible('#gameFirst')).toBe(false);
    expect(await page.isVisible('#coverWarn')).toBe(false);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  for (const viewport of [
    { width: 360, height: 640 },
    { width: 390, height: 844 },
    { width: 412, height: 915 },
  ]) {
    it(`fits ${viewport.width} by ${viewport.height}: the whole board and Pip in view, 48 px targets, nothing scrolls`, async () => {
      const { ctx, page, errors } = await phone({ viewport });
      await page.evaluate(() => document.fonts.ready);
      for (const sel of ['.gd-title', '#gameLevel', '#gameBoard', '#gameMoves', '#gameFlowers', '#pipBtn', '.gd-card']) expect(await inView(page, sel), sel).toBe(true);
      const sizes = await page.$$eval('.gd-cell, #pipBtn', (n) => n.map((x) => Math.min(x.getBoundingClientRect().width, x.getBoundingClientRect().height)));
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      if (viewport.width !== 412) {
        await shot(page, `game-${viewport.width}x${viewport.height}-fresh.png`);
        const [a, b] = G.findMove(await boardOf(page));
        await drag(page, a, b);
        await expect.poll(() => count(page, '#gameMoves'), { timeout: 10_000 }).toBe(14);
        await shot(page, `game-${viewport.width}x${viewport.height}-mid.png`);
        await page.evaluate(async (game) => {
          const db: IDBDatabase = await new Promise((r) => (indexedDB.open('forge2', 1).onsuccess = (e: any) => r(e.target.result)));
          const tx = db.transaction('kv', 'readwrite');
          tx.objectStore('kv').put(game, 'game');
          await new Promise((r) => (tx.oncomplete = r));
          db.close();
        }, { v: 1, level: 7, flowers: 340, moves: 12, made: 10, board: await boardOf(page) });
        await page.reload();
        await onGame(page);
        const [c, d] = G.findMove(await boardOf(page));
        await drag(page, c, d);
        await page.waitForSelector('#gameNext');
        await shot(page, `game-${viewport.width}x${viewport.height}-level-done.png`);
        await holdPip(page, 3200);
        await onHelper(page);
        for (const sel of ['#gameBtn', '#privacyPill', '#starChip']) expect(await inView(page, sel), sel).toBe(true);
        await shot(page, `helper-${viewport.width}x${viewport.height}-game-button.png`);
      }
      expect(errors).toEqual([]);
      await ctx.close();
    }, 90_000);
  }

  it('plays with the keyboard, and Pip opens the helper with Enter held or a screen reader twice', async () => {
    const { ctx, page, errors } = await phone({ reduce: true });
    // Tab reaches the board at one tile; the arrows move along it.
    await page.focus(cell(0));
    await page.keyboard.press('ArrowRight');
    expect(await page.evaluate(() => (document.activeElement as HTMLElement).dataset.i)).toBe('1');
    expect(await page.$$eval('.gd-cell[tabindex="0"]', (n) => n.length)).toBe(1);
    expect(await page.getAttribute(cell(1), 'aria-label')).toMatch(/^(Yellow sun|Green leaf|Coral flower|Blue drop), row 1, column 2$/);
    // Pick a tile with Enter, then an arrow swaps it that way.
    const [a, b] = G.findMove(await boardOf(page));
    const dir = b === a + 1 ? 'ArrowRight' : 'ArrowDown';
    await page.focus(cell(a));
    await page.keyboard.press('Enter');
    expect(await page.getAttribute(cell(a), 'aria-pressed')).toBe('true');
    await expect.poll(() => textOf(page, '#gameLive')).toMatch(/picked\. Choose a tile next to it/);
    await page.keyboard.press(dir);
    await expect.poll(() => count(page, '#gameMoves'), { timeout: 10_000 }).toBe(14);
    // A long chain can even finish the level.
    await expect.poll(() => textOf(page, '#gameLive'), { timeout: 10_000 }).toMatch(/to bloom\.|New tiles|Level 1 done/);
    // Escape puts a picked tile down.
    await page.focus(cell(12));
    await page.keyboard.press(' ');
    expect(await page.getAttribute(cell(12), 'aria-pressed')).toBe('true');
    await page.keyboard.press('Escape');
    expect(await page.getAttribute(cell(12), 'aria-pressed')).toBe('false');
    // Enter on Pip, let go at once: a game line. Held three seconds: the helper.
    await page.focus('#pipBtn');
    await page.keyboard.press('Enter');
    expect(await page.$('[data-screen=game]')).not.toBeNull();
    await page.keyboard.down('Enter');
    await page.waitForTimeout(3200);
    await page.keyboard.up('Enter');
    await onHelper(page);
    await page.click('#gameBtn');
    await onGame(page);
    // A screen reader's activation cannot hold: once is a game line, twice in a row opens the helper.
    await page.evaluate(() => (document.querySelector('#pipBtn') as HTMLElement).click());
    await page.waitForTimeout(200);
    expect(await page.$('[data-screen=game]')).not.toBeNull();
    await page.evaluate(() => (document.querySelector('#pipBtn') as HTMLElement).click());
    await onHelper(page);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("Erase everything removes the game's record", async () => {
    const { ctx, page, errors } = await phone();
    const [a, b] = G.findMove(await boardOf(page));
    await drag(page, a, b);
    await expect.poll(() => count(page, '#gameMoves'), { timeout: 10_000 }).toBe(14);
    const kept = () =>
      page.evaluate(async () => {
        const names = (await indexedDB.databases()).map((d) => d.name);
        if (!names.includes('forge2')) return null;
        const db: IDBDatabase = await new Promise((r) => (indexedDB.open('forge2', 1).onsuccess = (e: any) => r(e.target.result)));
        const v = await new Promise((r) => (db.transaction('kv').objectStore('kv').get('game').onsuccess = (e: any) => r(e.target.result ?? null)));
        db.close();
        return v;
      });
    // The move is kept (a lucky board finishes level 1 with it, and then the next level is what is kept).
    const saved: any = await kept();
    expect(saved?.v).toBe(1);
    expect([1, 2]).toContain(saved.level);
    expect(await page.evaluate(() => localStorage.getItem('forge2.cover'))).toContain("Pip's Garden");
    await page.evaluate(() => {
      const p = document.querySelector('#pipBtn') as HTMLElement;
      p.click();
      p.click();
    });
    await onHelper(page);
    await page.click('#btn-more');
    await page.click('#moreErase');
    await page.waitForSelector('[data-screen=erase]');
    await page.focus('#eraseHold');
    await page.keyboard.down(' ');
    await page.waitForTimeout(2_300);
    await page.keyboard.up(' ');
    await page.waitForSelector('[data-screen=erased]');
    expect(await kept()).toBeNull();
    expect(await page.evaluate(() => localStorage.length)).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);
});
