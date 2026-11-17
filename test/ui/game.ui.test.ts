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
// nothing of the game. No test leans on luck: one move can never finish a level, and where a test needs a
// level done or lost it seeds the game through its record, with a seeded board. GAME_SHOTS=1 also saves
// screenshots to .tmp/game-shots, among them a middle and a late level at 360 by 640 and 390 by 844.
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const SHOTS = process.env.GAME_SHOTS ? resolve(import.meta.dirname, '../../.tmp/game-shots') : null;
const G: any = await import('../../public/v2/modules/mode/playful/games/garden/logic.js' as string);
const { seeded } = await import('../../scripts/garden-sim.ts');

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
/** A swap on board `b` that matches tiles of `kind`, or null. */
function goalMove(b: number[], kind: number): [number, number] | null {
  for (let i = 0; i < 25; i++) for (const d of ['right', 'down']) {
    const j = G.step(i, d);
    if (j >= 0 && G.canSwap(b, i, j) && G.goalTiles(G.findRuns(G.swapped(b, i, j)), kind) > 0) return [i, j];
  }
  return null;
}
/** A board from a seeded random source (the same every run) with a swap that matches tiles of `kind`. */
function goalBoard(kind: number): { board: number[]; swap: [number, number] } {
  for (let seed = 1; ; seed++) {
    const board = G.newBoard(seeded(seed));
    const swap = goalMove(board, kind);
    if (swap) return { board, swap };
  }
}
/** Puts a game in the app's database as the game keeps it (the page reloads after to take it). */
const keepGame = (page: Page, game: object) =>
  page.evaluate(async (game) => {
    const db: IDBDatabase = await new Promise((r) => (indexedDB.open('forge2', 1).onsuccess = (e: any) => r(e.target.result)));
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(game, 'game');
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  }, game);
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
    expect(await textOf(page, '#gameSub')).toBe('Ten more suns to bloom.');
    // The goal under the board: a sun tile and how many are left, named for a screen reader.
    expect(await textOf(page, '#gameGoalLeft')).toBe('10');
    expect(await textOf(page, '#gameGoal')).toBe('Suns to match:10');
    expect(await page.$eval('#gameGoal .gd-mini', (n) => [n.className, getComputedStyle(n).backgroundColor])).toEqual(['gd-mini k0', 'rgb(255, 210, 63)']);
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
    // Only the suns the swap itself matched count (at most 9), so one move never finishes the level. A swap
    // that matched no sun has Pip point at them.
    expect(['Nice move!', 'Wow, a chain!', 'No moves left. New tiles!', 'Match the suns!']).toContain(await textOf(page, '#gameSay'));
    expect(await textOf(page, '#gameSub')).toMatch(/^(One more sun|(Two|Three|Four|Five|Six|Seven|Eight|Nine|Ten) more suns) to bloom\.$/);
    expect(await count(page, '#gameGoalLeft')).toBeGreaterThanOrEqual(1);
    const after = await boardOf(page);
    expect(G.findRuns(after)).toEqual([]);
    expect(G.hasMove(after)).toBe(true);
    // The tiles on show are the board the cells say.
    await expect.poll(() => page.$$eval('.gd-tile:not(.gone)', (ts) => ts.length)).toBe(25);
    await shot(page, 'game-412x915-mid.png');
    // The progress is kept: a reload opens the same board, moves, goal and flowers.
    const flowers = await count(page, '#gameFlowers');
    const left = await textOf(page, '#gameGoalLeft');
    await page.reload();
    await onGame(page);
    expect(await count(page, '#gameFlowers')).toBe(flowers);
    expect(await count(page, '#gameMoves')).toBe(14);
    expect(await textOf(page, '#gameGoalLeft')).toBe(left);
    expect(await boardOf(page)).toEqual(after);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("a level is done when its tiles are matched, and out of moves offers Play again", async () => {
    const { ctx, page, errors } = await phone();
    // Nine of level 1's ten suns matched already, one move left, and a board with a sun to match.
    const { board, swap } = goalBoard(G.goalFor(1).kind);
    await keepGame(page, { v: 2, level: 1, flowers: 120, moves: 1, got: 9, board });
    await page.reload();
    await onGame(page);
    expect(await textOf(page, '#gameSub')).toBe('One more sun to bloom.');
    expect(await textOf(page, '#gameGoalLeft')).toBe('1');
    await drag(page, ...swap);
    await page.waitForSelector('#gameNext');
    expect(await textOf(page, '#gameSay')).toBe('The garden bloomed!');
    expect(await textOf(page, '#gameSub')).toBe('Level 1 done.');
    expect(await textOf(page, '#gameGoalLeft')).toBe('0');
    await shot(page, 'game-412x915-level-done.png');
    await page.click('#gameNext');
    await expect.poll(() => textOf(page, '#gameLevel')).toBe('Level 2');
    expect(await textOf(page, '#gameMoves')).toBe('Moves 15');
    expect(await textOf(page, '#gameSub')).toBe('11 more leaves to bloom.');
    expect(await page.getAttribute('#gameGoal .gd-mini', 'class')).toBe('gd-mini k1');

    // Out of moves at level 2: its last move cannot match eleven leaves.
    const b2 = await boardOf(page);
    await keepGame(page, { v: 2, level: 2, flowers: 300, moves: 1, got: 0, board: b2 });
    await page.reload();
    await onGame(page);
    const [c, d] = G.findMove(b2);
    await drag(page, c, d);
    await page.waitForSelector('#gameAgain');
    expect(await textOf(page, '#gameSay')).toBe('Out of moves.');
    expect(await textOf(page, '#gameSub')).toBe('Try this level again.');
    const kept = await count(page, '#gameFlowers');
    expect(kept).toBeGreaterThan(300);
    await page.click('#gameAgain');
    await expect.poll(() => textOf(page, '#gameMoves')).toBe('Moves 15');
    expect(await textOf(page, '#gameLevel')).toBe('Level 2');
    expect(await textOf(page, '#gameGoalLeft')).toBe('11');
    // The flowers are kept.
    expect(await count(page, '#gameFlowers')).toBe(kept);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('a game kept under the first rules opens at its level with its flowers, on a new board', async () => {
    const { ctx, page, errors } = await phone();
    // The first rules' record: level 4, 1,080 flowers, matches made.
    await keepGame(page, { v: 1, level: 4, flowers: 1080, moves: 9, made: 3, board: G.newBoard(seeded(5)) });
    await page.reload();
    await onGame(page);
    expect(await textOf(page, '#gameLevel')).toBe('Level 4');
    expect(await textOf(page, '#gameFlowers')).toBe('Flowers 1080');
    expect(await textOf(page, '#gameMoves')).toBe('Moves 15');
    expect(await textOf(page, '#gameSub')).toBe('13 more drops to bloom.');
    const b = await boardOf(page);
    expect(G.findRuns(b)).toEqual([]);
    expect(G.hasMove(b)).toBe(true);
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

  // The helper's top row with the game button: each chip's words in full, on the home and the answer, at
  // 360 px wide and up. A phone set to larger text scales the words and not the boxes: text-size-adjust
  // does the same here, and at 130 % gives the Pixel's measured chips (Standard 140 px, the star 159 px).
  it('the top row: the game button, Private or Standard and every star word in full from 360 px, with larger text too', async () => {
    const { ctx, page, errors } = await phone({ viewport: { width: 412, height: 915 } });
    const EN: Record<string, string> = (await import('../../public/v2/strings/en.js' as string)).default;
    const word = (k: string): string => EN[k] ?? k;
    const pills = [word('status.private'), word('status.standard')];
    const stars = [...['lots', 'little', 'some', 'none', 'free', 'start'].map((k) => word(`playful.star.${k}`)), word('status.offline')];
    await page.evaluate(() => document.fonts.ready);
    const bigText = (pct: number) =>
      page.evaluate((p) => {
        document.getElementById('textScale')?.remove();
        const s = Object.assign(document.createElement('style'), { id: 'textScale', textContent: `html { -webkit-text-size-adjust: ${p}%; text-size-adjust: ${p}%; }` });
        document.head.append(s);
      }, pct);
    /** Puts the words in the chips and measures the row at once, before the screen can draw them again. */
    const fit = (pill: string, star: string) =>
      page.evaluate(
        ([pill, star]) => {
          const pillWords = document.querySelector('#privacyPill span') as HTMLElement;
          const starWords = document.querySelector('#starWords') as HTMLElement;
          pillWords.textContent = pill;
          starWords.textContent = star;
          const chips = ['#gameBtn', '#privacyPill', '#starChip'].map((s) => document.querySelector(s) as HTMLElement);
          const [g, p, s] = chips.map((n) => n.getBoundingClientRect()) as [DOMRect, DOMRect, DOMRect];
          const inside = (a: DOMRect, b: DOMRect) => a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5 && a.left >= b.left - 0.5 && a.right <= b.right + 0.5;
          return {
            // Cut short: wider than its box (an ellipsis), or its lines outside its white pill.
            cut: [pillWords, starWords, ...chips]
              .filter((n) => n.scrollWidth > n.clientWidth || (n.parentElement!.closest('.pf-chip') && !inside(n.getBoundingClientRect(), n.parentElement!.closest('.pf-chip')!.getBoundingClientRect())))
              .map((n) => n.id || n.textContent),
            overlap: g.right > p.left || p.right > s.left,
            outside: [g, p, s].some((b) => b.left < 0 || b.right > innerWidth),
            sideways: document.documentElement.scrollWidth > innerWidth,
            small: [g, p, s].some((b) => b.height < 48) || g.width < 48,
          };
        },
        [pill, star] as [string, string],
      );
    const check = async (where: string) => {
      for (const width of [360, 384, 395, 412]) {
        await page.setViewportSize({ width, height: 915 });
        for (const pct of [100, 130]) {
          await bigText(pct);
          for (const pill of pills)
            for (const star of stars) {
              const r = await fit(pill, star);
              expect(r, `${where} ${width} px, text ${pct} %, ${pill} | ${star}`).toEqual({ cut: [], overlap: false, outside: false, sideways: false, small: false });
            }
        }
        if (width === 395 || width === 360) {
          await fit(word('status.standard'), word('playful.star.free'));
          await shot(page, `top-row-${where}-${width}-130.png`);
        }
      }
      await bigText(100);
    };
    await holdPip(page, 3200);
    await onHelper(page);
    await page.waitForSelector('#gameBtn:not([hidden])');
    await check('home');
    await page.setViewportSize({ width: 412, height: 915 });
    await page.click('#btn-type');
    await page.fill('#question', 'Why is the sky dark at night?');
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer][data-mode=playful] #burnBtn', { timeout: 20_000 });
    await page.waitForSelector('#gameBtn:not([hidden])');
    await check('answer');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

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
      for (const sel of ['.gd-title', '#gameLevel', '#gameBoard', '#gameMoves', '#gameGoal', '#gameFlowers', '#pipBtn', '.gd-card']) expect(await inView(page, sel), sel).toBe(true);
      const sizes = await page.$$eval('.gd-cell, #pipBtn', (n) => n.map((x) => Math.min(x.getBoundingClientRect().width, x.getBoundingClientRect().height)));
      expect(Math.min(...sizes)).toBeGreaterThanOrEqual(48);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight)).toBe(true);
      if (viewport.width !== 412) {
        await shot(page, `game-${viewport.width}x${viewport.height}-fresh.png`);
        const [a, b] = G.findMove(await boardOf(page));
        await drag(page, a, b);
        await expect.poll(() => count(page, '#gameMoves'), { timeout: 10_000 }).toBe(14);
        await shot(page, `game-${viewport.width}x${viewport.height}-mid.png`);
        // A late level, as it opens, with a six-figure score: the three counts still fit on one line.
        await keepGame(page, { v: 2, level: 18, flowers: 123450, moves: 15, got: 0, board: G.newBoard(seeded(18)) });
        await page.reload();
        await onGame(page);
        expect(await textOf(page, '#gameSub')).toBe('24 more leaves to bloom.');
        expect(await page.$eval('.gd-stats', (n) => n.scrollWidth <= n.clientWidth)).toBe(true);
        for (const sel of ['#gameMoves', '#gameGoal', '#gameFlowers']) expect(await inView(page, sel), sel).toBe(true);
        await shot(page, `game-${viewport.width}x${viewport.height}-level-18.png`);
        // The design's middle level, Level 7 with 12 moves left, one flower short of its goal.
        const { board, swap } = goalBoard(G.goalFor(7).kind);
        await keepGame(page, { v: 2, level: 7, flowers: 340, moves: 12, got: G.goalFor(7).count - 1, board });
        await page.reload();
        await onGame(page);
        for (const sel of ['#gameBoard', '#gameGoal', '#pipBtn', '.gd-card']) expect(await inView(page, sel), sel).toBe(true);
        await shot(page, `game-${viewport.width}x${viewport.height}-level-7.png`);
        await drag(page, ...swap);
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
    await expect.poll(() => textOf(page, '#gameLive'), { timeout: 10_000 }).toMatch(/more suns? to bloom\. Flowers \d+\.$/);
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
    // The move is kept.
    const saved: any = await kept();
    expect(saved).toMatchObject({ v: 2, level: 1, moves: 14 });
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
