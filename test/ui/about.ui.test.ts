import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { type Gateway, startGateway } from '../e2e/helpers.ts';

// The landing page, the site's front page at /, in a real browser. It is one screen: at each of six
// sizes (three computer screens, three phones) the page is exactly as tall and wide as the window and
// every part of it is inside the window, whichever words the title shows. The three actions sit at the
// top right. The moments (Talk, Private, Pay, Share unseen) move on by themselves, can be picked by tap or
// keyboard, stop with Pause, pause under the mouse, and stand still under reduced motion; the title's
// last words turn with them and stop with them, and a screen reader hears one sentence. The download
// buttons show Soon while their links are empty and become links once set. What was meant for the
// Classic page at / goes on to /classic/. Nothing is asked of another site and nothing is logged as an
// error.
let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  g = await startGateway();
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

interface Opened {
  page: Page;
  errors: string[];
  /** Every request to another origin. */
  away: string[];
}

/** The title as one sentence: what a screen reader reads, and what shows under reduced motion. */
const SENTENCE = 'Private AI for activists and anyone who cannot risk being linked to a question.';
/** The words that turn after "Private AI for", in order (public/about/index.html). */
const WHOS = ['activists', 'journalists', 'researchers', 'survivors', 'organizers', 'whistleblowers', 'lawyers', 'anyone who cannot risk being linked to a question'];

const SIZES = [
  [1280, 720],
  [1440, 900],
  [1920, 1080],
  [390, 844],
  [360, 740],
  [320, 568],
] as const;

async function open(
  [width, height]: readonly [number, number],
  { links, still = false, look, path = '/' }: { links?: Record<string, string>; still?: boolean; look?: object; path?: string } = {},
): Promise<Opened> {
  const mobile = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2, reducedMotion: still ? 'reduce' : 'no-preference' });
  if (look) await ctx.addInitScript((l) => localStorage.setItem('forge2.look', JSON.stringify(l)), look);
  // Every layout shift the page makes, from its first paint.
  await ctx.addInitScript(() => {
    (window as any).shifts = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any[]) if (!e.hadRecentInput) (window as any).shifts += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  });
  const page = await ctx.newPage();
  const errors: string[] = [];
  const away: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A file the page's policy refused shows here too.
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => {
    if (new URL(r.url()).origin !== g.url) away.push(r.url());
  });
  if (links)
    await page.route(
      (u) => u.pathname === '/',
      async (route) => {
        const res = await route.fetch();
        let body = await res.text();
        for (const [k, v] of Object.entries(links)) body = body.replace(`data-download="${k}" data-href=""`, `data-download="${k}" data-href="${v}"`);
        await route.fulfill({ response: res, body });
      },
    );
  await page.goto(`${g.url}${path}`);
  await page.waitForLoadState('networkidle');
  return { page, errors, away };
}

/** The moments' state: which moment, which screen, playing or stopped. */
const state = (page: Page) => page.evaluate(() => ({ ...(document.querySelector('.hero') as HTMLElement).dataset }));

/** The title's words that show now. */
const showing = (page: Page) => page.evaluate(() => document.querySelector('#whos .who.on')?.textContent);

/** Shows these words in the title, as about.js does when they come round, and waits for them to settle (about 1 s at the page's speed). */
async function show(page: Page, words: string, wait = 1100) {
  await page.evaluate((w) => {
    for (const e of document.querySelectorAll('#whos .who')) e.classList.toggle('on', e.textContent === w);
  }, words);
  await page.waitForTimeout(wait);
}

/** The heading's name as a screen reader gets it. */
const headingName = async (page: Page) => /^- heading "(.*)" \[level=1\]$/.exec((await page.locator('h1').ariaSnapshot()).trim())?.[1];

/** Plays the page's animations this many times faster (the moments' clock is a CSS animation). */
async function faster(page: Page, rate: number) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Animation.enable');
  await cdp.send('Animation.setPlaybackRate', { playbackRate: rate });
}

/**
 * How the page fits the window: its scroll size, and every part that shows outside the window (each
 * part cut to the boxes that clip it, such as the rings' box).
 */
const fit = (page: Page) =>
  page.evaluate(() => {
    const W = innerWidth;
    const H = innerHeight;
    const outside: string[] = [];
    for (const e of document.querySelectorAll('body *')) {
      const r = e.getBoundingClientRect();
      if (!r.width || !r.height || getComputedStyle(e).visibility === 'hidden') continue;
      let [l, t, rt, b] = [r.left, r.top, r.right, r.bottom];
      for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
        const s = getComputedStyle(a);
        if (s.display === 'none') l = rt = 0;
        if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
        const c = a.getBoundingClientRect();
        [l, t, rt, b] = [Math.max(l, c.left), Math.max(t, c.top), Math.min(rt, c.right), Math.min(b, c.bottom)];
      }
      if (rt - l <= 0 || b - t <= 0) continue;
      if (l < -0.5 || t < -0.5 || rt > W + 0.5 || b > H + 0.5) outside.push(`${e.tagName.toLowerCase()}.${e.getAttribute("class") ?? ""} ${Math.round(l)},${Math.round(t)},${Math.round(rt)},${Math.round(b)}`);
    }
    const d = document.documentElement;
    return { scroll: [d.scrollWidth, d.scrollHeight], window: [W, H], outside };
  });

/** The box of an element, or fails. */
const box = async (page: Page, sel: string) => (await page.locator(sel).boundingBox())!;

/** Whether two boxes overlap. */
const overlap = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('the landing page in a browser', () => {
  it.each(SIZES)('is one screen at %i by %i, with its actions in the top right', async (width, height) => {
    const { page, errors, away } = await open([width, height]);
    expect(new URL(page.url()).pathname).toBe('/');
    expect(await page.title()).toBe('Forge AI, private AI for activists');
    // After the way in: no scroll either way, and nothing outside the window.
    await page.waitForTimeout(2000);
    const f = await fit(page);
    expect(f.scroll).toEqual([width, height]);
    expect(f.outside).toEqual([]);
    expect(await page.evaluate(() => document.fonts.check('16px Inter'))).toBe(true);

    // The three actions: at the top, right of the brand, each at least 48 px to tap.
    const brand = await box(page, '.brand');
    const targets = { '#topOpen': '/v2/', '#topCode': 'https://github.com/ForgeReserve/forge-ai' };
    for (const [sel, href] of Object.entries(targets)) expect(await page.getAttribute(sel, 'href'), sel).toBe(href);
    for (const sel of ['#topOpen', '#topDownload', '#topCode']) {
      const b = await box(page, sel);
      expect(b.y + b.height, sel).toBeLessThanOrEqual(90);
      expect(b.x, sel).toBeGreaterThan(brand.x + brand.width);
      expect(Math.min(b.width, b.height), sel).toBeGreaterThanOrEqual(48);
    }
    // GitHub ends at the right of the page's width (1480 px at most, centred).
    const code = await box(page, '#topCode');
    expect(width - (code.x + code.width) - Math.max(0, (width - 1480) / 2)).toBeLessThanOrEqual(50);
    expect(await page.getAttribute('#topCode', 'aria-label')).toBe('The code on GitHub');
    expect(await page.textContent('#topOpen')).toContain('Open the app');
    expect(await page.textContent('#topDownload')).toContain('Download');

    // The title, the phone, the words and the tabs: all showing, none over another.
    const parts = { title: await box(page, 'h1'), phone: await box(page, '.phone'), words: await box(page, '#cap-talk'), tabs: await box(page, '.rail') };
    for (const [a, pa] of Object.entries(parts)) for (const [b, pb] of Object.entries(parts)) if (a < b) expect(overlap(pa, pb), `${a} over ${b}`).toBe(false);
    expect(parts.phone.height).toBeGreaterThan(height * 0.3);
    // Every tab and Pause at least 48 px to tap.
    for (const sel of ['#tab-talk', '#tab-private', '#tab-pay', '#tab-share', '#play']) {
      const b = await box(page, sel);
      expect(Math.min(b.width, b.height), sel).toBeGreaterThanOrEqual(48);
    }
    // The labels beside the phone (where they show) never cover the phone or the words.
    for (const chip of await page.locator('.chip').all())
      if (await chip.isVisible()) {
        const b = (await chip.boundingBox())!;
        expect(overlap(b, parts.phone)).toBe(false);
        expect(overlap(b, parts.words)).toBe(false);
      }

    // Every phone picture loaded, each with words for a screen reader; one shows.
    const imgs = await page.locator('.frame').evaluateAll((xs) => xs.map((x) => ({ w: (x as HTMLImageElement).naturalWidth, alt: x.getAttribute('alt') ?? '', shown: getComputedStyle(x).visibility === 'visible' })));
    expect(imgs.length).toBe(6);
    for (const i of imgs) {
      expect(i.w).toBe(600);
      expect(i.alt.length).toBeGreaterThan(20);
    }
    expect(imgs.filter((i) => i.shown).length).toBeGreaterThanOrEqual(1);
    // The way in moves by transform and opacity only: nothing shifted.
    expect(await page.evaluate(() => (window as any).shifts)).toBe(0);

    // Whichever words the title shows, the page keeps its place: the title, the tabs, the words and the
    // phone stay where they are, nothing shows outside the window, the words fit the title's width, and
    // nothing shifts. The longest (the phrase) last.
    await page.evaluate(() => document.querySelector('.hero')!.classList.add('held'));
    await faster(page, 10);
    const where = async () => Promise.all(['h1', '.rail', '.caps', '.phone-in'].map((sel) => box(page, sel).then((b) => [b.x, b.y, b.width, b.height].map(Math.round).join(','))));
    const at = await where();
    for (const words of [...WHOS.slice(1), WHOS[0]!, WHOS.at(-1)!]) {
      await show(page, words, 200);
      expect(await showing(page)).toBe(words);
      expect(await where(), words).toEqual(at);
      const f2 = await fit(page);
      expect(f2.scroll, words).toEqual([width, height]);
      expect(f2.outside, words).toEqual([]);
      const wide = await page.evaluate(() => {
        const on = document.querySelector('#whos .who.on')!;
        const r = document.createRange();
        r.selectNodeContents(on);
        const right = Math.max(...[...r.getClientRects()].map((x) => x.right));
        return { right, edge: document.querySelector('h1')!.getBoundingClientRect().right, lines: new Set([...r.getClientRects()].map((x) => Math.round(x.top))).size };
      });
      expect(wide.right, words).toBeLessThanOrEqual(wide.edge + 0.5);
      expect(wide.lines, words).toBe(words.includes(' ') ? 2 : 1);
    }
    expect(await page.evaluate(() => (window as any).shifts)).toBe(0);
    expect(away).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('moves its old address, /about, to /', async () => {
    for (const old of ['/about', '/about/']) {
      const { page, errors } = await open([390, 844], { path: old });
      expect(new URL(page.url()).pathname, old).toBe('/');
      expect(await page.title()).toBe('Forge AI, private AI for activists');
      expect(errors).toEqual([]);
      await page.context().close();
    }
  });

  it('turns the title with the moments, through its list in order and round again, the phrase for two halves', async () => {
    const { page, errors } = await open([1440, 900]);
    expect(await showing(page)).toBe('activists');
    // Each word that comes, and each end of half a ring (what moves the title on), in order.
    await page.evaluate(() => {
      const log: string[] = [];
      (window as any).log = log;
      new MutationObserver(() => {
        const on = document.querySelector('#whos .who.on')!.textContent!;
        if (log.findLast((x) => x !== '|') !== on) log.push(on);
      }).observe(document.getElementById('whos')!, { attributes: true, subtree: true });
      document.querySelector('.hero')!.addEventListener('animationend', (e) => (e as AnimationEvent).animationName === 'arc' && log.push('|'));
    });
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    await faster(page, 25);
    await expect.poll(() => page.evaluate(() => (window as any).log.filter((x: string) => x !== '|').length), { timeout: 20_000 }).toBeGreaterThanOrEqual(WHOS.length + 1);
    const log: string[] = await page.evaluate(() => (window as any).log);
    const words = log.filter((x) => x !== '|');
    expect(words.slice(0, WHOS.length + 1)).toEqual([...WHOS.slice(1), WHOS[0], WHOS[1]]);
    // How many halves each showed for: one each, two for the phrase. (A word comes in at the end of a
    // half; the mark for that half follows it.)
    const spans = words.slice(0, WHOS.length).map((w, i) => {
      const from = log.indexOf(w);
      const to = log.indexOf(words[i + 1]!, from + 1);
      return [w, log.slice(from, to).filter((x) => x === '|').length];
    });
    expect(Object.fromEntries(spans)).toEqual(Object.fromEntries([...WHOS.slice(1), WHOS[0]!].map((w) => [w, w === WHOS.at(-1) ? 2 : 1])));
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('stops the title with Pause, under the mouse and while the page is out of sight', async () => {
    const { page, errors } = await open([1440, 900]);
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    await page.click('#play');
    await faster(page, 25);
    const paused = await showing(page);
    await page.waitForTimeout(1500); // more than a whole round of the moments at this speed
    expect(await showing(page)).toBe(paused);
    await page.click('#play');
    await expect.poll(() => showing(page), { timeout: 5000 }).not.toBe(paused);

    // The mouse over the phone holds it.
    const phone = await box(page, '.phone');
    await page.mouse.move(phone.x + phone.width / 2, phone.y + phone.height / 2);
    const held = await showing(page);
    await page.waitForTimeout(1500);
    expect(await showing(page)).toBe(held);
    await page.mouse.move(5, 450);
    await expect.poll(() => showing(page), { timeout: 5000 }).not.toBe(held);

    // Out of sight (another tab, a locked phone), it holds too.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const away = await showing(page);
    await page.waitForTimeout(1500);
    expect(await showing(page)).toBe(away);
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect.poll(() => showing(page), { timeout: 5000 }).not.toBe(away);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('gives a screen reader one sentence that never changes, and no live region in the title', async () => {
    const { page, errors } = await open([390, 844]);
    expect(await headingName(page)).toBe(SENTENCE);
    expect(await page.locator('h1 [aria-live], h1[aria-live]').count()).toBe(0);
    expect(await page.getAttribute('.t-turn', 'aria-hidden')).toBe('true');
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    await faster(page, 25);
    await expect.poll(() => showing(page), { timeout: 10_000 }).not.toBe('activists');
    expect(await headingName(page)).toBe(SENTENCE);
    await show(page, WHOS.at(-1)!);
    expect(await headingName(page)).toBe(SENTENCE);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('moves through the moments by itself, two screens for Talk and Pay', async () => {
    const { page, errors } = await open([1440, 900]);
    await page.evaluate(() => {
      const hero = document.querySelector('.hero') as HTMLElement;
      const seen: string[] = [hero.dataset.frame!];
      (window as any).seen = seen;
      new MutationObserver(() => seen.at(-1) !== hero.dataset.frame && seen.push(hero.dataset.frame!)).observe(hero, { attributes: true });
    });
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    await faster(page, 25);
    await expect.poll(() => page.evaluate(() => (window as any).seen.length), { timeout: 15_000 }).toBeGreaterThanOrEqual(7);
    expect((await page.evaluate(() => (window as any).seen)).slice(0, 7)).toEqual(['talk-a', 'talk-b', 'private', 'pay-a', 'pay-b', 'share', 'talk-a']);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('shows a moment picked by tap or keyboard, and stops there', async () => {
    const { page, errors } = await open([390, 844]);
    await page.tap('#tab-pay');
    expect(await state(page)).toMatchObject({ moment: 'pay', frame: 'pay-a', play: 'stopped' });
    expect(await page.getAttribute('#tab-pay', 'aria-selected')).toBe('true');
    expect(await page.getAttribute('#tab-talk', 'aria-selected')).toBe('false');
    expect(await page.getAttribute('#play', 'aria-label')).toBe('Play');
    // Its words show, with the way to Bellows; the others are hidden.
    await expect.poll(() => page.isVisible('#cap-pay a[href="https://bellows.forgereserve.org"]')).toBe(true);
    for (const id of ['#cap-talk', '#cap-private', '#cap-share']) await expect.poll(() => page.evaluate((s) => getComputedStyle(document.querySelector(s)!).visibility, id)).toBe('hidden');
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector('.frame[data-frame=pay-a]')!).opacity)).toBe('1');
    // Stopped: it stays on Pay.
    await faster(page, 25);
    await page.waitForTimeout(1000);
    expect((await state(page)).moment).toBe('pay');

    // The keyboard: arrows move along the tabs, Home and End to the ends.
    await page.focus('#tab-pay');
    await page.keyboard.press('ArrowRight');
    expect(await state(page)).toMatchObject({ moment: 'share', frame: 'share' });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('tab-share');
    await page.keyboard.press('ArrowRight');
    expect((await state(page)).moment).toBe('talk');
    await page.keyboard.press('End');
    expect((await state(page)).moment).toBe('share');
    await page.keyboard.press('Home');
    expect((await state(page)).moment).toBe('talk');
    // Only the picked tab is in the tab order.
    expect(await page.locator('[role=tab][tabindex="0"]').count()).toBe(1);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('stops with Pause and goes on with Play; the mouse over it holds it', async () => {
    const { page, errors } = await open([1440, 900]);
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    await page.click('#play');
    expect((await state(page)).play).toBe('stopped');
    expect(await page.getAttribute('#play', 'aria-label')).toBe('Play');
    expect(await page.getAttribute('.caps', 'aria-live')).toBe('polite');
    await faster(page, 25);
    await page.waitForTimeout(1200);
    expect((await state(page)).moment).toBe('talk');
    // Every moving part of the moments stands still.
    expect(await page.evaluate(() => document.querySelector('.hero')!.getAnimations({ subtree: true }).filter((a) => a.playState === 'running' && /arc|finger|ripple|beam|float/.test((a as CSSAnimation).animationName)).length)).toBe(0);

    await page.click('#play');
    expect((await state(page)).play).toBe('playing');
    expect(await page.getAttribute('#play', 'aria-label')).toBe('Pause');
    await expect.poll(() => state(page).then((s) => s.moment), { timeout: 5000 }).not.toBe('talk');

    // The mouse over the phone holds it; away again, it goes on. (The phone floats, so it is never still
    // enough for Playwright's own hover and click: the mouse goes to its middle.)
    const phone = await box(page, '.phone');
    const middle = [phone.x + phone.width / 2, phone.y + phone.height / 2] as const;
    await page.mouse.move(...middle);
    expect(await page.evaluate(() => document.querySelector('.hero')!.classList.contains('held'))).toBe(true);
    const held = (await state(page)).moment;
    await page.waitForTimeout(1200);
    expect((await state(page)).moment).toBe(held);
    await page.mouse.move(5, 450);
    expect(await page.evaluate(() => document.querySelector('.hero')!.classList.contains('held'))).toBe(false);
    // A click on the phone stops it, and another starts it.
    await page.mouse.click(...middle);
    expect((await state(page)).play).toBe('stopped');
    await page.mouse.click(...middle);
    expect((await state(page)).play).toBe('playing');
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it.each([
    [1440, 900],
    [390, 844],
  ] as const)('stands still under reduced motion at %i by %i', async (width, height) => {
    const { page, errors } = await open([width, height], { still: true });
    expect(await state(page)).toMatchObject({ play: 'stopped', moment: 'talk', frame: 'talk-a' });
    // The title is the whole sentence, as it was before it turned, and its turning part never shows.
    expect(await page.isVisible('.t-turn')).toBe(false);
    expect((await page.innerText('h1')).replace(/\s+/g, ' ').trim()).toBe(SENTENCE);
    expect(await headingName(page)).toBe(SENTENCE);
    // No animation at all, no Pause (nothing moves), the rings drawn whole, and still one screen.
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
    expect(await page.isVisible('#play')).toBe(false);
    expect(await page.locator('.q').evaluateAll((qs) => qs.map((q) => getComputedStyle(q).opacity))).toEqual(['1', '1', '1', '1']);
    await page.waitForTimeout(1000);
    expect((await state(page)).moment).toBe('talk');
    expect(await showing(page)).toBe('activists');
    const f = await fit(page);
    expect(f.scroll).toEqual([width, height]);
    expect(f.outside).toEqual([]);
    // A tab still changes the moment, at once.
    await page.click('#tab-share');
    expect(await state(page)).toMatchObject({ moment: 'share', frame: 'share' });
    expect(await page.evaluate(() => getComputedStyle(document.querySelector('.frame[data-frame=share]')!).opacity)).toBe('1');
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it.each([
    [1440, 900],
    [320, 568],
  ] as const)('opens the download panel by tap and keyboard at %i by %i, with Soon and no links', async (width, height) => {
    const { page, errors, away } = await open([width, height]);
    const opened = () => page.evaluate(() => document.getElementById('download')!.matches(':popover-open'));
    expect(await opened()).toBe(false);
    expect(await page.getAttribute('#topDownload', 'aria-expanded')).toBe('false');
    if (width < 600) await page.tap('#topDownload');
    else await page.click('#topDownload');
    expect(await opened()).toBe(true);
    await expect.poll(() => page.getAttribute('#topDownload', 'aria-expanded')).toBe('true');
    // No link yet: each download button says Soon and goes nowhere.
    for (const sel of ['#dlAndroid', '#dlIphone']) {
      expect(await page.getAttribute(sel, 'href'), sel).toBeNull();
      expect(await page.textContent(`${sel} .soon`), sel).toBe('Soon');
      expect(await page.isVisible(`${sel} .soon`), sel).toBe(true);
    }
    expect(await page.textContent('#dlAndroid')).toContain('Android');
    expect(await page.textContent('#dlIphone')).toContain('iPhone');
    expect(await page.getAttribute('#dlWeb', 'href')).toBe('/v2/');
    // One quiet way to the Classic page, under the rest, big enough to tap.
    expect(await page.getAttribute('#dlClassic', 'href')).toBe('/classic/');
    expect(await page.textContent('#dlClassic')).toBe('Classic app');
    // The panel is inside the window.
    await page.waitForTimeout(400);
    expect((await box(page, '#dlClassic')).height).toBeGreaterThanOrEqual(44);
    const p = await box(page, '#download');
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(width);
    expect(p.y + p.height).toBeLessThanOrEqual(height);
    // Escape closes it; Enter on Download opens it again, and Tab goes into it.
    await page.keyboard.press('Escape');
    expect(await opened()).toBe(false);
    await expect.poll(() => page.getAttribute('#topDownload', 'aria-expanded')).toBe('false');
    await page.focus('#topDownload');
    await page.keyboard.press('Enter');
    expect(await opened()).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('dlWeb');
    // A tap outside closes it.
    await page.mouse.click(10, height - 10);
    expect(await opened()).toBe(false);
    expect(away).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('turns a download button into a link once its link is set', async () => {
    const { page, errors } = await open([390, 844], { links: { android: '/download/' } });
    expect(await page.getAttribute('#dlAndroid', 'href')).toBe('/download/');
    expect(await page.locator('#dlAndroid .soon').count()).toBe(0);
    expect(await page.getAttribute('#dlIphone', 'href')).toBeNull();
    expect(await page.textContent('#dlIphone .soon')).toBe('Soon');
    await page.tap('#topDownload');
    await page.tap('#dlAndroid');
    await page.waitForURL(/\/download\/?$/);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it.each([
    ['/#/c/c_0123456789abcdef', '/classic/#/c/c_0123456789abcdef'],
    ['/#new', '/classic/#new'],
    ['/#fund', '/classic/#fund'],
  ])('sends %s, meant for the Classic page when it was at /, on to %s', async (from, to) => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await ctx.newPage();
    // Every address the tab shows (the Classic page then takes its shortcut's hash off).
    const seen: string[] = [];
    page.on('framenavigated', (f) => f === page.mainFrame() && seen.push(f.url()));
    await page.goto(`${g.url}${from}`);
    await page.waitForURL((u) => u.pathname === '/classic/');
    await expect.poll(() => seen).toContain(`${g.url}${to}`);
    expect(await page.title()).toBe('Forge AI');
    // The Classic page acts on it: Add funds opens the wallet.
    if (to.endsWith('#fund')) await page.waitForSelector('#walletDialog[open]');
    await ctx.close();
  });

  it('sends the Classic app put on a home screen (it opens at /) on to /classic/, and leaves a browser tab here', async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // As Safari has it in an app put on the Home Screen.
    await ctx.addInitScript(() => Object.defineProperty(Navigator.prototype, 'standalone', { configurable: true, get: () => true }));
    const page = await ctx.newPage();
    await page.goto(`${g.url}/`);
    await page.waitForURL(`${g.url}/classic/`);
    await ctx.close();
    // A tab with the skip link's hash stays.
    const { page: tab, errors } = await open([390, 844], { path: '/#moments' });
    await tab.waitForTimeout(500);
    expect(new URL(tab.url()).pathname).toBe('/');
    expect(errors).toEqual([]);
    await tab.context().close();
  });

  it('opens the app from Open the app', async () => {
    const { page, errors } = await open([390, 844]);
    await page.tap('#topOpen');
    await page.waitForURL(`${g.url}/v2/`);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('takes the look this phone keeps from the app', async () => {
    const { page, errors } = await open([390, 844], { look: { look: 'light', scheme: 'light', tokens: { bg: '#F6F5F1', ink: '#14161A' } } });
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe('rgb(246, 245, 241)');
    expect(await page.getAttribute('html', 'data-scheme')).toBe('light');
    expect(errors).toEqual([]);
    await page.context().close();
  });
});
