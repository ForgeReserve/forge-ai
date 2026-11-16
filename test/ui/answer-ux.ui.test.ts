import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { fakePhoneVoice } from './phonevoice.ts';

// The answer screen's UX pass (owner, 2026-11-15): the wait shows it is working, then offers a fast model;
// the model picker's speed groups (rabbits and turtles); Listen and the bottom row pinned under a long
// answer; Burn held, never one tap; a new model starts a new conversation and each answer names its
// model; and Funds says free questions work at $0 when a paid model is chosen.
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true' },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      const free = (id: string, name: string, upstream: string, speed?: string) => ({ id, name, supplier: 'freebie', upstream, pricing: 'free', free_reason: 'ui test', max_output_tokens: 256, ...(speed ? { speed } : {}) });
      c.models.push(free('slow-free', 'Turtle Model', 'mock-slow', 'slow'));
      c.models.push(free('plain-free', 'Plain Model', 'mock-echo'));
      c.models.push(free('glm-5.3-flash', 'Rabbit Model', 'mock-echo', 'fast'));
      c.models.push(free('fast-two', 'Hare Model', 'mock-slow', 'fast'));
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

async function phone({ voice = true, context = {} }: { voice?: boolean; context?: object } = {}): Promise<{ ctx: BrowserContext; page: Page; errors: string[] }> {
  const ctx = await browser.newContext({ ...PHONE, ...context });
  await pastFirstRun(ctx);
  await fakePhoneVoice(ctx, voice);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  return { ctx, page, errors };
}

/** A $0 balance opened with an invite, on the home. */
async function zeroBalance(page: Page): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`open failed: ${JSON.stringify(b)}`);
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), b.key);
  await page.reload();
  await page.waitForSelector('[data-screen=home]');
  return b.key;
}

/** Chooses a model with Private only off; the list closes on the choice. */
async function useModel(page: Page, id: string) {
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click(`[data-model="${id}"]`);
  await page.waitForSelector('[data-screen=model]', { state: 'detached' });
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
}

async function ask(page: Page, q: string) {
  await page.click('#btn-type');
  await page.fill('#question', q);
  await page.click('#sendBtn');
  await page.waitForSelector('[data-screen=answer]');
}

const conversations = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('forge2');
        open.onsuccess = () => {
          const db = open.result;
          const names = [...db.objectStoreNames];
          if (!names.includes('chats')) return resolve(0);
          const r = db.transaction('chats').objectStore('chats').count();
          r.onsuccess = () => resolve(r.result);
        };
      }),
  );

/** How many stored conversations end on a stopped answer. */
const stoppedAnswers = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const open = indexedDB.open('forge2');
        open.onsuccess = () => {
          const db = open.result;
          if (![...db.objectStoreNames].includes('chats')) return resolve(0);
          const r = db.transaction('chats').objectStore('chats').getAll();
          r.onsuccess = () => resolve(r.result.filter((c: any) => c?.messages?.at(-1)?.meta?.stopped).length);
        };
      }),
  );

describe('waiting for the first words', () => {
  it('shows turning rings and the seconds, then after 20 s a Slow model note that asks a fast model in one tap', async () => {
    const { ctx, page, errors } = await phone();
    await page.clock.install();
    await zeroBalance(page);
    await useModel(page, 'slow-free');
    // The engine holds the first words back until the test lets them go.
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/v1/chat/completions', async (route) => {
      if (JSON.parse(route.request().postData() ?? '{}').model === 'slow-free') await gate;
      await route.continue().catch(() => {}); // the held one was stopped meanwhile
    });
    await ask(page, 'Is it slow?');
    await page.waitForSelector('#answerWait:not([hidden])');
    expect(await page.textContent('#answerWait')).toMatch(/^Thinking\d+ s$/);
    expect(await page.$eval('.wait-gold', (n) => getComputedStyle(n).animationName)).toBe('waitspin');
    // The model it was asked: its name and its turtle, small, under the question.
    expect(await page.textContent('#answerModel')).toBe('Turtle Model');
    expect(await page.getAttribute('#answerModel', 'aria-label')).toBe('Answered by Turtle Model');
    // The Stop is in the pinned dock.
    expect(await page.isVisible('#answerDock #stopBtn')).toBe(true);
    await page.clock.fastForward(5000);
    await expect.poll(() => page.textContent('#waitSecs')).toMatch(/^[5-7] s$/);
    expect(await page.isVisible('#slowNote')).toBe(false);
    await page.clock.fastForward(16_000);
    await page.waitForSelector('#slowNote:not([hidden])');
    expect(await page.textContent('#slowText')).toMatch(/^Slow model\./);
    expect(await page.textContent('#useFast')).toBe('Ask Rabbit Model');
    expect(await page.locator('#useFast svg').count()).toBe(1);
    // One tap: stopped quietly, the fast model chosen, the same question asked there in a new conversation.
    // A double tap (easy to do on a big button) still asks once.
    await page.dblclick('#useFast');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(await page.textContent('.asked')).toBe('Is it slow?');
    expect(await page.textContent('#answerModel')).toBe('Rabbit Model');
    expect(await page.isVisible('#answerWait')).toBe(false);
    release();
    await expect.poll(() => conversations(page)).toBe(2);
    // A second switch would only start once the slow answer is settled and saved (stopped): wait for that,
    // then give it a moment it would need to ask again. This is a window for something NOT to happen.
    await expect.poll(() => stoppedAnswers(page), { timeout: 10_000 }).toBe(1);
    await page.waitForTimeout(1500);
    expect(await conversations(page)).toBe(2);
    expect(await stoppedAnswers(page)).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 90_000);

  it('keeps the rings still with reduced motion, and still counts', async () => {
    const { ctx, page } = await phone({ context: { reducedMotion: 'reduce' } });
    await zeroBalance(page);
    await useModel(page, 'plain-free');
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/v1/chat/completions', async (route) => (await gate, route.continue().catch(() => {})));
    await ask(page, 'Still?');
    await page.waitForSelector('#answerWait:not([hidden])');
    expect(await page.$eval('.wait-gold', (n) => getComputedStyle(n).animationIterationCount)).toBe('1');
    await expect.poll(() => page.textContent('#waitSecs'), { timeout: 4000 }).toMatch(/^[1-3] s$/);
    release();
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    await ctx.close();
  }, 60_000);
});

describe('Choose a model by speed', () => {
  it('lists fast free models first with a rabbit, Slow below Standard with a turtle, checks the one chosen, and closes on a choice', async () => {
    const { ctx, page, errors } = await phone();
    await zeroBalance(page);
    await page.click('#btn-more');
    await page.click('#moreModel');
    await page.waitForSelector('[data-screen=model]');
    await page.click('#privateOnly');
    const groups = await page.$$eval('.model-group', (gs) => gs.map((g) => [g.id, [...g.querySelectorAll('[data-model]')].map((m) => m.getAttribute('data-model'))]));
    expect(groups.map((x) => x[0])).toEqual(['group-fast', 'group-private', 'group-standard', 'group-slow']);
    expect(groups[0]![1]).toEqual(['glm-5.3-flash', 'fast-two']);
    expect(groups[3]![1]).toEqual(['slow-free']);
    expect(await page.textContent('#groupHead-slow')).toBe('Slow');
    // Each group's heading has its picture; fast and slow models carry theirs.
    for (const id of ['fast', 'private', 'standard', 'slow']) expect(await page.locator(`#groupHead-${id} svg`).count()).toBe(1);
    expect(await page.textContent('[data-model="fast-two"] .tag.speed')).toBe('Fast');
    expect(await page.textContent('[data-model="slow-free"] .tag.slow')).toBe('Slow');
    expect(await page.locator('[data-model="plain-free"] .tag.speed, [data-model="plain-free"] .tag.slow').count()).toBe(0);
    // The chosen model has a check, not only an outline.
    const chosen = await page.$$eval('[data-model][aria-checked=true]', (xs) => xs.map((x) => x.getAttribute('data-model')));
    expect(chosen.length).toBe(1);
    expect(await page.locator(`[data-model="${chosen[0]}"] .model-on`).count()).toBe(1);
    expect(await page.getAttribute(`[data-model="${chosen[0]}"] .model-on`, 'aria-label')).toBe('Chosen');
    // Choosing closes the list: back to the home (it was opened from More).
    await page.click('[data-model="fast-two"]');
    await page.waitForSelector('[data-screen=home]');
    expect(await page.isVisible('#moreSheet')).toBe(false);
    expect(await page.textContent('#freeModelName')).toBe('Hare Model');
    // The home is gone back to, not pushed over the list: the phone's Back does not reopen More.
    expect(await page.evaluate(() => history.state?.forge2 ?? 0)).toBe(0);
    expect(errors.filter((e) => !/status of 40[13]/.test(e))).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('a long answer', () => {
  it.each([
    [390, 844],
    [360, 640],
  ])('keeps Listen and the bottom row in view at %ix%i, and the toast off the words', async (vw, vh) => {
    const { ctx, page, errors } = await phone({ context: { viewport: { width: vw, height: vh } } });
    await zeroBalance(page);
    await useModel(page, 'fast-two'); // mock-slow: 200 words
    await ask(page, 'Tell me a lot.');
    await page.waitForSelector('#speakBtn', { timeout: 30_000 });
    expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeGreaterThan(vh + 200);
    // Nothing runs off the side, and the dock leaves most of the screen to the words.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(vw);
    expect((await page.locator('#answerDock').boundingBox())!.height).toBeLessThan(vh * 0.4);
    for (const top of [0, 400, 100_000]) {
      // Scrolling is synchronous, and so is the layout the boxes are read from.
      await page.evaluate((y) => window.scrollTo(0, y), top);
      for (const sel of ['#speakBtn', '#btn-type', '#btn-add', '#btn-more']) {
        const b = (await page.locator(sel).boundingBox())!;
        expect(b.y, `${sel} at ${top}`).toBeGreaterThanOrEqual(0);
        expect(b.y + b.height, `${sel} at ${top}`).toBeLessThanOrEqual(vh);
      }
    }
    // "Answer ready." is said to screen readers here, not over the answer.
    await expect.poll(() => page.textContent('#announce')).toBe('Answer ready.');
    expect(await page.$eval('#toast', (n) => n.classList.contains('show')).catch(() => false)).toBe(false);
    // The bottom row's Add is a paper clip, not the plus of Add money.
    expect(await page.innerHTML('#btn-add svg')).toContain('M20 11.5');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('Burn, held', () => {
  it('a short hold sets the card alight and lets it recover; a full hold burns it', async () => {
    const { ctx, page, errors } = await phone();
    await zeroBalance(page);
    await useModel(page, 'plain-free');
    await ask(page, 'Burn me?');
    await page.waitForSelector('#burnBtn', { timeout: 20_000 });
    await expect.poll(() => conversations(page)).toBe(1);
    const box = (await page.locator('#burnBtn').boundingBox())!;
    // A tap says to hold.
    await page.click('#burnBtn');
    await expect.poll(() => page.textContent('#toast')).toMatch(/^Hold to burn\./);
    // Held for part of the way: the fire is drawn over the card, the card warms; let go and it recovers.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#burnBtn')!).getPropertyValue('--hold')) > 0.3);
    expect(await page.locator('canvas.burn-fx').count()).toBe(1);
    expect(await page.$eval('.answer-card', (n) => n.classList.contains('burning'))).toBe(true);
    const mid = Number(await page.$eval('#burnBtn', (n) => getComputedStyle(n).getPropertyValue('--hold')));
    expect(mid).toBeLessThan(0.9);
    await page.mouse.up();
    await page.waitForFunction(() => !document.querySelector('.answer-card.burning'), null, { timeout: 3000 });
    await page.waitForFunction(() => !document.querySelector('canvas.burn-fx'), null, { timeout: 4000 });
    expect(await page.isVisible('[data-screen=answer]')).toBe(true);
    expect(await conversations(page)).toBe(1);
    // Held to the end: it burns away, and the app goes home with the conversation gone.
    await page.mouse.down();
    await page.waitForSelector('[data-screen=home]', { timeout: 6000 });
    await page.mouse.up();
    await expect.poll(() => conversations(page)).toBe(0);
    await expect.poll(() => page.textContent('#toast')).toMatch(/^Burned\./);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('with reduced motion, fills the button like a bar and draws no fire', async () => {
    const { ctx, page } = await phone({ context: { reducedMotion: 'reduce' } });
    await zeroBalance(page);
    await useModel(page, 'plain-free');
    await ask(page, 'Quietly?');
    await page.waitForSelector('#burnBtn', { timeout: 20_000 });
    const box = (await page.locator('#burnBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#burnBtn')!).getPropertyValue('--hold')) > 0.2);
    expect(await page.locator('canvas.burn-fx').count()).toBe(0);
    expect(await page.$eval('.hold-fill', (n) => getComputedStyle(n).transform)).not.toBe('none');
    await page.waitForSelector('[data-screen=home]', { timeout: 5000 });
    await page.mouse.up();
    await expect.poll(() => conversations(page)).toBe(0);
    await ctx.close();
  }, 60_000);

  // Only a full hold burns: a cancelled touch, a short key press, focus taken away mid-hold, or the screen
  // left mid-hold all keep the conversation.
  it('a cancelled touch, a short key press or focus taken away never burns; a held key does', async () => {
    const { ctx, page, errors } = await phone();
    await zeroBalance(page);
    await useModel(page, 'plain-free');
    await ask(page, 'Keep me?');
    await page.waitForSelector('#burnBtn', { timeout: 20_000 });
    await expect.poll(() => conversations(page)).toBe(1);
    const hold = () => page.$eval('#burnBtn', (n) => Number(getComputedStyle(n).getPropertyValue('--hold') || 0));
    const atRest = () => page.waitForFunction(() => !document.querySelector('.answer-card.burning') && Number(getComputedStyle(document.querySelector('#burnBtn')!).getPropertyValue('--hold') || 0) === 0, null, { timeout: 4000 });
    // The browser takes the touch over (a scroll, a call): pointercancel ends the hold.
    const box = (await page.locator('#burnBtn').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#burnBtn')!).getPropertyValue('--hold')) > 0.2);
    await page.$eval('#burnBtn', (n) => n.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 })));
    await atRest();
    await page.mouse.up();
    expect(await conversations(page)).toBe(1);
    // A short press of Space: it says to hold.
    await page.focus('#burnBtn');
    await page.keyboard.press('Space');
    await expect.poll(() => page.textContent('#toast')).toMatch(/^Hold to burn\./);
    await atRest();
    // Space held, then focus moved away: its keyup goes elsewhere, so the hold ends with the focus.
    await page.focus('#burnBtn');
    await page.keyboard.down('Space');
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#burnBtn')!).getPropertyValue('--hold')) > 0.2);
    await page.$eval('#burnBtn', (n) => (n as HTMLElement).blur());
    await atRest();
    await page.keyboard.up('Space');
    expect(await hold()).toBe(0);
    expect(await conversations(page)).toBe(1);
    // Enter held to the end burns it.
    await page.focus('#burnBtn');
    await page.keyboard.down('Enter');
    await page.waitForSelector('[data-screen=home]', { timeout: 6000 });
    await page.keyboard.up('Enter');
    await expect.poll(() => conversations(page)).toBe(0);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);

  it('leaving History mid-hold on Burn all burns nothing, even after the list was drawn again', async () => {
    const { ctx, page, errors } = await phone();
    await page.clock.install();
    await zeroBalance(page);
    await useModel(page, 'plain-free');
    await ask(page, 'One');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home]');
    await page.click('#btn-more');
    await page.click('#moreHistory');
    await page.waitForSelector('[data-screen=history]');
    await expect.poll(() => page.locator('.hist-card').count()).toBe(1);
    await page.click('#burnAll');
    // The list is drawn again under the open question (another auto-delete time).
    await page.click('#auto-week');
    await page.waitForSelector('#auto-week[aria-checked=true]');
    const box = (await page.locator('#burnAllYes').boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('#burnAllYes')!).getPropertyValue('--hold')) > 0.1);
    // Back, with the finger still down: the button leaves the page, and no pointerup can reach it.
    await page.goBack();
    await page.waitForSelector('[data-screen=history]', { state: 'detached' });
    // Run the page's frames well past a full hold.
    await page.clock.runFor(4000);
    // No fire left running: a hold still going would be in its last burst by now, its canvas still up.
    expect(await page.locator('canvas.burn-fx').count()).toBe(0);
    await page.mouse.up();
    expect(await conversations(page)).toBe(1);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('changing the model', () => {
  it('starts a new conversation and says so; each answer names its model', async () => {
    const { ctx, page, errors } = await phone();
    await zeroBalance(page);
    await useModel(page, 'plain-free');
    await ask(page, 'First question');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(await page.textContent('#answerModel')).toBe('Plain Model');
    await useModel(page, 'glm-5.3-flash');
    await expect.poll(() => page.textContent('#toast')).toBe('New conversation with Rabbit Model.');
    // The next question starts afresh: the old one is in History, the answer screen is empty.
    await page.goto(`${g.url}/v2/#/answer`);
    await page.waitForSelector('[data-screen=answer]');
    expect(await page.textContent('#answerText')).toContain('No answer yet');
    expect(await conversations(page)).toBe(1);
    await page.goto(`${g.url}/v2/#/`);
    await ask(page, 'Second question');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(await page.textContent('#answerModel')).toBe('Rabbit Model');
    expect(await page.locator('#answerModel svg').count()).toBe(2); // the open lock and the rabbit
    await expect.poll(() => conversations(page)).toBe(2);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('changing the model mid-answer', () => {
  it('stops the answer quietly in its own conversation; the toast says the new conversation', async () => {
    const { ctx, page, errors } = await phone();
    await zeroBalance(page);
    await useModel(page, 'slow-free');
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    await page.route('**/v1/chat/completions', async (route) => (await gate, route.continue().catch(() => {})));
    await ask(page, 'Still waiting?');
    await page.waitForSelector('#answerWait:not([hidden])');
    await useModel(page, 'plain-free');
    await expect.poll(() => page.textContent('#toast')).toBe('New conversation with Plain Model.');
    // The stopped answer is settled and saved (its toast, if any, was said before the save).
    await expect.poll(() => stoppedAnswers(page), { timeout: 10_000 }).toBe(1);
    expect(await page.textContent('#toast')).toBe('New conversation with Plain Model.');
    expect(await conversations(page)).toBe(1);
    // The next question goes to the new model, in a new conversation.
    release();
    await ask(page, 'Now?');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    expect(await page.textContent('#answerModel')).toBe('Plain Model');
    await expect.poll(() => conversations(page)).toBe(2);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});

describe('money at $0 with free models', () => {
  it('on a private model: Funds says free questions work, with the gift; the home names the model', async () => {
    const { ctx, page, errors } = await phone();
    await zeroBalance(page);
    // Private only is on: the private model is chosen, and it needs money.
    expect(await page.textContent('#modelChip')).toBe('tinfoil/enc-model');
    expect(await page.getAttribute('#modelChip', 'data-kind')).toBe('private');
    expect(await page.isVisible('#addMoney')).toBe(true);
    // Add money and Add (to the question) never share a picture.
    expect(await page.innerHTML('#addMoney svg')).not.toBe(await page.innerHTML('#btn-add svg'));
    const rb = (await page.locator('#ringsBtn').boundingBox())!;
    await page.locator('#ringsBtn').click({ position: { x: 16, y: rb.height / 2 } });
    await page.waitForSelector('[data-screen=funds]');
    await page.waitForSelector('#fundsFreeState:not([hidden])');
    expect(await page.textContent('#fundsFreeState')).toMatch(/^Free questions on free models\./);
    expect(await page.locator('#fundsFreeState svg').count()).toBeGreaterThanOrEqual(1);
    expect(await page.isVisible('#fundsNote')).toBe(false); // never "Not enough for a question."
    // One tap: Start free's question first, as Private only is on.
    await page.click('#fundsFreeModels');
    await page.waitForSelector('[data-screen=startFree]');
    // The whole funds ring is one button.
    await page.goBack();
    await page.waitForSelector('[data-screen=funds]');
    const ring = (await page.locator('#fundsRing').boundingBox())!;
    expect(ring.width).toBeGreaterThanOrEqual(170);
    await page.mouse.click(ring.x + ring.width / 2, ring.y + ring.height / 2);
    await page.waitForSelector('[data-screen=addFunds]');
    expect(errors.filter((e) => !/status of 40[13]/.test(e))).toEqual([]);
    await ctx.close();
  }, 60_000);
});
