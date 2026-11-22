import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Gateway, startGateway } from '../e2e/helpers.ts';
import { fakeApk } from '../support/apk.ts';

const { tokens: LIGHT }: { tokens: Record<string, string> } = await import('../../public/v2/modules/look/light/index.js' as string);

// The landing page, the site's front page at /, in a real browser. It is one screen: at each of six
// sizes (three computer screens, three phones) the page is exactly as tall and wide as the window and
// every part of it is inside the window, whichever words the title shows. The three actions sit at the
// top right. The moments (Talk, Private, Pay, Share unseen) move on by themselves, can be picked by tap or
// keyboard, stop with Pause, pause under the mouse, and stand still under reduced motion; Share unseen
// shows its photo as it was taken, taps After and shows it covered, with its labels; the title's
// last words turn on a quicker clock of their own and stop whenever the moments stop, and a screen
// reader hears one sentence. Download opens a quiet panel with the /download page's row of ways, filled
// from /download/info only once it is opened: each way that is there goes where /download would take
// it, one that is not is dim and says Soon, and an iPhone sees no Android way. What was meant for the
// Classic page at / goes on to /classic/. Nothing is asked of another site and nothing is logged as an
// error.
let g: Gateway;
/** A site with both APKs; and one with an APK, Google Play's link and the iPhone app's link. */
let withApk: Gateway;
let linked: Gateway;
let browser: Browser;
const PLAY = 'https://play.google.com/store/apps/details?id=com.forgereserve.ai';
const TESTFLIGHT = 'https://testflight.apple.com/join/AbCd1234';
const ANDROID_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';

beforeAll(async () => {
  g = await startGateway();
  const dir = mkdtempSync(join(tmpdir(), 'forge-about-apk-'));
  writeFileSync(join(dir, 'forge.apk'), fakeApk('1.2.3', 7, 30_000));
  writeFileSync(join(dir, 'pv.apk'), fakeApk('1.2.3', 7, 70_000));
  withApk = await startGateway({ env: { FORGE_APK_PATH: join(dir, 'forge.apk'), FORGE_APK_PRIVATE_VOICE_PATH: join(dir, 'pv.apk') } });
  linked = await startGateway({ env: { FORGE_APK_PATH: join(dir, 'forge.apk'), FORGE_PLAY_URL: PLAY, FORGE_IOS_URL: TESTFLIGHT } });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await Promise.all([g?.close(), withApk?.close(), linked?.close()]);
});

interface Opened {
  page: Page;
  errors: string[];
  /** Every request to another origin. */
  away: string[];
  /** Every path asked of this site. */
  asked: string[];
}

/** The title as one sentence: what a screen reader reads, and what shows under reduced motion. */
const SENTENCE = 'Private AI for activists and anyone who cannot risk being linked to a question.';
/** The words that turn after "Private AI for", in order (public/about/index.html). */
const WHOS = ['activists', 'journalists', 'anyone who cannot risk being linked to a question', 'researchers', 'survivors', 'organizers', 'whistleblowers', 'lawyers'];
/** The phrase in the list, set smaller on two lines and shown longer. */
const LONG = WHOS[2]!;

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
  { still = false, look, path = '/', site = g, ua }: { still?: boolean; look?: object; path?: string; site?: Gateway; ua?: string } = {},
): Promise<Opened> {
  const mobile = width < 600;
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: 2, reducedMotion: still ? 'reduce' : 'no-preference', ...(ua ? { userAgent: ua } : {}) });
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
  const asked: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  // A file the page's policy refused shows here too.
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (u.origin !== site.url) away.push(r.url());
    else asked.push(u.pathname);
  });
  await page.goto(`${site.url}${path}`);
  await page.waitForLoadState('networkidle');
  return { page, errors, away, asked };
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

/** WCAG contrast of an element's text against the page's ground. */
const contrast = (page: Page, sel: string) =>
  page.$eval(sel, (e) => {
    const rgb = (s: string) => (s.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };
    const a = lum(rgb(getComputedStyle(e).color));
    const b = lum(rgb(getComputedStyle(document.body).backgroundColor));
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });

/** Anything in the Download panel drawn as a pill, a tile or a card: a class of that kind, or a rounded box with a fill, an edge or a shadow. */
const boxes = (page: Page) =>
  page.$$eval('#download *', (xs) =>
    xs
      .filter((x) => !x.closest('svg'))
      .filter((x) => {
        if (/\b(tag|chip|pill|card|badge|soon|tile)\b/i.test(x.getAttribute('class') ?? '')) return true;
        const s = getComputedStyle(x);
        const r = parseFloat(s.borderTopLeftRadius) || 0;
        const fill = s.backgroundColor !== 'rgba(0, 0, 0, 0)' && (s.backgroundColor.match(/[\d.]+/g) ?? []).map(Number)[3] !== 0;
        const edge = ['Top', 'Right', 'Bottom', 'Left'].some((k) => parseFloat((s as any)[`border${k}Width`]) > 0 && (s as any)[`border${k}Style`] !== 'none');
        return r > 4 && (fill || edge || s.boxShadow !== 'none');
      })
      .map((x) => `${x.tagName.toLowerCase()}.${x.getAttribute('class') ?? ''}#${x.id}`),
  );

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
    expect(imgs.length).toBe(7);
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
    for (const words of [...WHOS.slice(1), WHOS[0]!, LONG]) {
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

  it('turns the title on its own clock, through its list in order and round again: a word about 2 s, the phrase about 5 s, whatever the moments do', async () => {
    const { page, errors } = await open([1440, 900]);
    expect(await showing(page)).toBe('activists');
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    // The moments slowed to a crawl (a ring takes ten minutes): the title keeps its own pace.
    await page.evaluate(() => (document.querySelector('.hero') as HTMLElement).style.setProperty('--dur', '600s'));
    // Each word that comes, with the time it came, and each time a ring's half ends.
    await page.evaluate(() => {
      const log: [string, number][] = [];
      (window as any).log = log;
      new MutationObserver(() => {
        const on = document.querySelector('#whos .who.on')?.textContent;
        if (on && log.findLast((x) => x[0] !== '|')?.[0] !== on) log.push([on, performance.now()]);
      }).observe(document.getElementById('whos')!, { attributes: true, subtree: true });
      document.querySelector('.hero')!.addEventListener('animationend', (e) => (e as AnimationEvent).animationName === 'arc' && log.push(['|', performance.now()]));
    });
    const RATE = 4;
    await faster(page, RATE);
    await expect.poll(() => page.evaluate(() => (window as any).log.filter((x: [string]) => x[0] !== '|').length), { timeout: 20_000 }).toBeGreaterThanOrEqual(WHOS.length + 2);
    const log: [string, number][] = await page.evaluate(() => (window as any).log);
    // No ring ended: the title did not wait for the moments.
    expect(log.filter((x) => x[0] === '|')).toEqual([]);
    const words = log.map((x) => x[0]);
    expect(words.slice(0, WHOS.length + 1)).toEqual([...WHOS.slice(1), WHOS[0], WHOS[1]]);
    // How long each stayed, at the page's own speed: a word about 2 s, the phrase about 5 s.
    for (let i = 0; i < WHOS.length; i++) {
      const [w, at] = log[i]!;
      const stayed = ((log[i + 1]![1] - at) * RATE) / 1000;
      if (w === LONG) {
        expect(stayed, w).toBeGreaterThanOrEqual(4.5);
        expect(stayed, w).toBeLessThanOrEqual(6);
      } else {
        expect(stayed, w).toBeGreaterThanOrEqual(1.8);
        expect(stayed, w).toBeLessThanOrEqual(2.8);
      }
    }
    // The clock is the word's own animation: 2 s for a word, 5 s for the phrase.
    const holds = await page.evaluate(() =>
      [...document.querySelectorAll('#whos .who')].map((w) => {
        const had = w.classList.contains('on');
        w.classList.add('on');
        const a = w.getAnimations().find((x) => (x as CSSAnimation).animationName === 'who-hold');
        const d = a?.effect?.getComputedTiming().duration;
        if (!had) w.classList.remove('on');
        return [w.textContent, d];
      }),
    );
    expect(Object.fromEntries(holds)).toEqual(Object.fromEntries(WHOS.map((w) => [w, w === LONG ? 5000 : 2000])));
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('stops the title whenever the moments stop: Pause, a moment picked, the mouse, focus and the page out of sight; it goes on from where it was', async () => {
    const { page, errors } = await open([1440, 900]);
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    /** How far the word on show is through its time (ms at the page's speed), once a pause or a play has taken hold. */
    const through = () =>
      page.evaluate(async () => {
        const a = document.querySelector('#whos .who.on')!.getAnimations().find((x) => (x as CSSAnimation).animationName === 'who-hold')!;
        await a.ready;
        return a.currentTime as number;
      });
    /** Waits longer than any word stays at this speed, and expects the same word, no further through. */
    const holdsStill = async () => {
      const [w, t] = [await showing(page), await through()];
      await page.waitForTimeout(1500);
      expect(await showing(page)).toBe(w);
      expect(await through()).toBe(t);
      return [w, t] as const;
    };

    // Pause stops it part way through a word; Play goes on from there, not from the start of the word.
    await page.waitForTimeout(800);
    await page.click('#play');
    await faster(page, 10);
    const [paused, at] = await holdsStill();
    expect(at).toBeGreaterThan(0);
    await page.click('#play');
    expect(await through()).toBeGreaterThanOrEqual(at - 0.5); // (to within the rounding of the time)
    await expect.poll(() => showing(page), { timeout: 5000 }).not.toBe(paused);

    // A moment picked stops the moments, and the title with them; Play starts both. (Picked without the
    // mouse, which would hold it anyway.)
    await page.evaluate(() => document.getElementById('tab-pay')!.click());
    expect((await state(page)).play).toBe('stopped');
    const [picked] = await holdsStill();
    await page.click('#play');
    await expect.poll(() => showing(page), { timeout: 5000 }).not.toBe(picked);

    // The mouse over the phone holds it.
    const phone = await box(page, '.phone');
    await page.mouse.move(phone.x + phone.width / 2, phone.y + phone.height / 2);
    const [held] = await holdsStill();
    await page.mouse.move(5, 450);
    await expect.poll(() => showing(page), { timeout: 5000 }).not.toBe(held);

    // Keyboard focus on the tabs holds it.
    await page.focus('#tab-pay');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.querySelector('.hero')!.classList.contains('held'))).toBe(true);
    const [focused] = await holdsStill();
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect.poll(() => showing(page), { timeout: 5000 }).not.toBe(focused);

    // Out of sight (another tab, a locked phone), it holds too.
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    const [away] = await holdsStill();
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
    await show(page, LONG);
    expect(await headingName(page)).toBe(SENTENCE);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('moves through the moments by itself, two screens for Talk, Pay and Share unseen', async () => {
    const { page, errors } = await open([1440, 900]);
    await page.evaluate(() => {
      const hero = document.querySelector('.hero') as HTMLElement;
      const seen: string[] = [hero.dataset.frame!];
      (window as any).seen = seen;
      new MutationObserver(() => seen.at(-1) !== hero.dataset.frame && seen.push(hero.dataset.frame!)).observe(hero, { attributes: true });
    });
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    await faster(page, 25);
    await expect.poll(() => page.evaluate(() => (window as any).seen.length), { timeout: 15_000 }).toBeGreaterThanOrEqual(8);
    expect((await page.evaluate(() => (window as any).seen)).slice(0, 8)).toEqual(['talk-a', 'talk-b', 'private', 'pay-a', 'pay-b', 'share-a', 'share-b', 'talk-a']);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('shows Share unseen as taken, taps After, runs the checks and shows it covered, with its labels', async () => {
    const { page, errors } = await open([1440, 900]);
    await expect.poll(() => state(page).then((s) => s.play), { timeout: 5000 }).toBe('playing');
    // From the start of the moment (picked and played without the mouse, which would hold it), at the
    // page's own speed (so a busy machine still draws enough frames), a sample at every frame: the
    // moment's time from its ring, the screen, and how much of the fingertip, the line over the photo and
    // the labels shows.
    await page.evaluate(() => document.getElementById('tab-share')!.click());
    await page.evaluate(() => {
      const hero = document.querySelector('.hero') as HTMLElement;
      const ring = [...document.querySelectorAll('#tab-share .arc')];
      const op = (s: string) => [...document.querySelectorAll(s)].map((e) => (getComputedStyle(e).visibility === 'hidden' ? 0 : Number(getComputedStyle(e).opacity)));
      const log: any[] = [];
      (window as any).log = log;
      const img = document.querySelector('.frame[data-frame=share-a]')!;
      const sample = () => {
        const t = Math.max(...ring.map((a) => Number(a.getAnimations()[0]?.currentTime ?? 0))) / 1000;
        if (hero.dataset.moment !== 'share') return;
        const f = document.querySelector('.finger')!.getBoundingClientRect();
        const i = img.getBoundingClientRect();
        log.push({ t, frame: hero.dataset.frame, finger: op('.finger')[0], beam: op('.beam-box')[0], chips: op('.chip[data-for=share]'), at: [(f.x + f.width / 2 - i.x) / i.width, (f.y + f.height / 2 - i.y) / i.height] });
        requestAnimationFrame(sample);
      };
      // Picked, the moment rests on After; Play starts it from Before, and the samples start with it.
      document.getElementById('play')!.click();
      requestAnimationFrame(sample);
    });
    await expect.poll(() => state(page).then((s) => s.moment), { timeout: 15_000 }).toBe('talk');
    const log: { t: number; frame: string; finger: number; beam: number; chips: number[]; at: [number, number] }[] = await page.evaluate(() => (window as any).log);
    expect(log.length).toBeGreaterThan(40);
    // Before for the first half, then After to the end: one change, never back.
    const frames = log.map((x) => x.frame).filter((f, i, a) => f !== a[i - 1]);
    expect(frames).toEqual(['share-a', 'share-b']);
    const turn = log.find((x) => x.frame === 'share-b')!.t;
    expect(turn).toBeGreaterThan(3.9);
    expect(turn).toBeLessThan(4.2);
    expect(log.at(-1)!.t).toBeGreaterThan(7.5);
    // The fingertip shows only in Before, from about 1 s to 2 s, and presses the After tab (its place in
    // the shot: x 25 to 296 and y 178 to 252 of 600 by 1298).
    const touched = log.filter((x) => x.finger > 0.5);
    expect(touched.length).toBeGreaterThanOrEqual(3);
    for (const x of touched) {
      expect(x.frame).toBe('share-a');
      expect(x.t).toBeGreaterThan(0.9);
      expect(x.t).toBeLessThan(2.1);
      expect(x.at[0]).toBeGreaterThan(25 / 600);
      expect(x.at[0]).toBeLessThan(296 / 600);
      expect(x.at[1]).toBeGreaterThan(178 / 1298);
      expect(x.at[1]).toBeLessThan(252 / 1298);
    }
    // The line over the photo comes after the tap and is gone as After comes in.
    const scanned = log.filter((x) => x.beam > 0.5);
    expect(scanned.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...scanned.map((x) => x.t))).toBeGreaterThan(Math.max(...touched.map((x) => x.t)) - 0.5);
    for (const x of log.filter((x) => x.beam > 0)) expect(x.frame).toBe('share-a');
    // The labels stay hidden through Before, come in with After and stay.
    for (const x of log.filter((x) => x.frame === 'share-a')) expect(x.chips).toEqual([0, 0]);
    for (const x of log.filter((x) => x.t > turn + 1.5)) expect(x.chips).toEqual([1, 1]);
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
    // A moment a person picks rests on its still screen: for Share unseen, the photo with its faces covered.
    expect(await state(page)).toMatchObject({ moment: 'share', frame: 'share-b' });
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
    // A tab still changes the moment, at once. Share unseen shows its photo covered (After) only, with its labels.
    await page.click('#tab-share');
    expect(await state(page)).toMatchObject({ moment: 'share', frame: 'share-b' });
    const looks = (sel: string) => page.evaluate((s) => [...document.querySelectorAll(s)].map((e) => [getComputedStyle(e).opacity, getComputedStyle(e).visibility].join(' ')), sel);
    expect(await looks('.frame[data-frame=share-b]')).toEqual(['1 visible']);
    expect(await looks('.frame[data-frame=share-a]')).toEqual(['0 hidden']);
    if (width > 600) expect(await looks('.chip[data-for=share]')).toEqual(['1 visible', '1 visible']);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it.each([
    [1440, 900],
    [360, 640],
    [320, 568],
  ] as const)('opens the Download panel by tap and keyboard at %i by %i: the row of ways, asked for only once it opens', async (width, height) => {
    const { page, errors, away, asked } = await open([width, height]);
    const opened = () => page.evaluate(() => document.getElementById('download')!.matches(':popover-open'));
    expect(await opened()).toBe(false);
    expect(await page.getAttribute('#topDownload', 'aria-expanded')).toBe('false');
    // Nothing about the downloads is asked before the panel opens.
    await page.waitForTimeout(300);
    expect(asked.filter((p) => p.startsWith('/download') || p.startsWith('/v2/download/'))).toEqual([]);
    if (width < 600) await page.tap('#topDownload');
    else await page.click('#topDownload');
    expect(await opened()).toBe(true);
    await expect.poll(() => page.getAttribute('#topDownload', 'aria-expanded')).toBe('true');
    await page.waitForSelector('#dlWays:not([aria-busy])', { state: 'attached' });
    expect(asked.filter((p) => p === '/download/info')).toEqual(['/download/info']);
    // A computer, and a site with nothing yet: the browser first and there, the rest dim with Soon.
    expect(await page.getAttribute('#dlWays', 'data-plan')).toBe('web android? play? iphone?');
    expect(await page.getAttribute('#dlWeb', 'href')).toBe('/v2/');
    expect(await page.getAttribute('#dlWeb', 'aria-label')).toBe('Forge in the browser');
    for (const [sel, name] of [['#dlAndroid', 'Android'], ['#dlPlay', 'Google Play'], ['#dlIphone', 'iPhone']]) {
      expect(await page.getAttribute(sel!, 'href'), sel).toBeNull();
      expect(await page.getAttribute(sel!, 'aria-disabled'), sel).toBe('true');
      expect(await page.getAttribute(sel!, 'aria-label'), sel).toBe(`${name}, Soon`);
      expect(await page.textContent(`${sel} .way-word`), sel).toBe('Soon');
      // Not focusable: no link behind it.
      expect(await page.$eval(sel!, (a) => ((a as HTMLElement).focus(), document.activeElement === a)), sel).toBe(false);
    }
    expect(await page.isVisible('#dlGraphene')).toBe(false);
    // All downloads, and one quiet way to the Classic page.
    expect(await page.getAttribute('#dlAll', 'href')).toBe('/download');
    expect(await page.getAttribute('#dlClassic', 'href')).toBe('/classic/');
    expect(await page.textContent('#dlClassic')).toBe('Classic app');
    // Big enough to tap, inside the window, and no box, tile or tag in it.
    await page.waitForTimeout(700);
    for (const sel of ['#dlWeb', '#dlAndroid', '#dlPlay', '#dlIphone']) {
      const b = await box(page, sel);
      expect(Math.min(b.width, b.height), sel).toBeGreaterThanOrEqual(56);
    }
    for (const sel of ['#dlAll', '#dlClassic']) expect((await box(page, sel)).height, sel).toBeGreaterThanOrEqual(48);
    const p = await box(page, '#download');
    expect(p.x).toBeGreaterThanOrEqual(0);
    expect(p.x + p.width).toBeLessThanOrEqual(width);
    expect(p.y + p.height).toBeLessThanOrEqual(height);
    expect(await boxes(page)).toEqual([]);
    // Escape closes it and Download has the focus; Enter opens it again, and Tab goes into it.
    await page.keyboard.press('Escape');
    expect(await opened()).toBe(false);
    await expect.poll(() => page.getAttribute('#topDownload', 'aria-expanded')).toBe('false');
    await page.focus('#topDownload');
    await page.keyboard.press('Enter');
    expect(await opened()).toBe(true);
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('dlWeb');
    await page.keyboard.press('Escape');
    expect(await opened()).toBe(false);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('topDownload');
    // A tap on the dimmed page under it closes it, and Download has the focus.
    await page.click('#topDownload');
    expect(await opened()).toBe(true);
    await page.mouse.click(10, height - 10);
    expect(await opened()).toBe(false);
    await expect.poll(() => page.getAttribute('#topDownload', 'aria-expanded')).toBe('false');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('topDownload');
    // It asked once, however often it opened.
    expect(asked.filter((p) => p === '/download/info')).toHaveLength(1);
    expect(away).toEqual([]);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('on Android with both APKs: Android and Graphene go to /download with that way picked', async () => {
    const { page, errors } = await open([390, 844], { site: withApk, ua: ANDROID_UA });
    await page.tap('#topDownload');
    await page.waitForSelector('#dlWays:not([aria-busy])', { state: 'attached' });
    expect(await page.getAttribute('#dlWays', 'data-plan')).toBe('android graphene play? iphone? web');
    expect(await page.getAttribute('#dlAndroid', 'href')).toBe('/download#way=android');
    expect(await page.getAttribute('#dlGraphene', 'href')).toBe('/download#way=graphene');
    expect(await page.getAttribute('#dlGraphene', 'aria-label')).toBe('GrapheneOS');
    expect(await page.textContent('#dlGraphene .way-word')).toBe('Graphene');
    expect(await page.$$eval('#dlWays li:not([hidden]) a', (xs) => xs.map((x) => x.id))).toEqual(['dlAndroid', 'dlGraphene', 'dlPlay', 'dlIphone', 'dlWeb']);
    // Words keep 4.5:1 against the page's ground.
    for (const sel of ['#dlAndroid .way-word', '#dlPlay .way-word']) expect(await contrast(page, sel), sel).toBeGreaterThanOrEqual(4.5);
    await page.waitForTimeout(600);
    await page.tap('#dlGraphene');
    await page.waitForURL(/\/download#way=graphene$/);
    await page.waitForSelector('#downloadBody:not([aria-busy])', { state: 'attached' });
    expect(await page.getAttribute('#way-graphene', 'aria-checked')).toBe('true');
    expect(await page.getAttribute('.go', 'href')).toBe('/download/forge-private-voice.apk');
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('with Google Play\'s and the iPhone app\'s links set: both go straight there', async () => {
    const { page, errors } = await open([390, 844], { site: linked, ua: ANDROID_UA });
    await page.tap('#topDownload');
    await page.waitForSelector('#dlWays:not([aria-busy])', { state: 'attached' });
    expect(await page.getAttribute('#dlWays', 'data-plan')).toBe('android play iphone web');
    expect(await page.getAttribute('#dlPlay', 'href')).toBe(PLAY);
    expect(await page.getAttribute('#dlIphone', 'href')).toBe(TESTFLIGHT);
    expect(await page.getAttribute('#dlPlay', 'aria-disabled')).toBeNull();
    expect(await page.textContent('#dlIphone .way-word')).toBe('iPhone');
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('on an iPhone: the iPhone app and the browser only, never an Android way', async () => {
    const { page, errors } = await open([390, 844], { site: withApk, ua: IPHONE_UA });
    await page.tap('#topDownload');
    await page.waitForSelector('#dlWays:not([aria-busy])', { state: 'attached' });
    expect(await page.getAttribute('#dlWays', 'data-plan')).toBe('iphone? web');
    expect(await page.$$eval('#dlWays li:not([hidden]) a', (xs) => xs.map((x) => x.id))).toEqual(['dlIphone', 'dlWeb']);
    expect(await page.evaluate(() => document.getElementById('download')!.innerText)).not.toMatch(/Android|Graphene|Play/);
    expect(await page.locator('#download a[href*="#way="]').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.context().close();
  });

  it('keeps 4.5:1 in the light look the phone keeps from the app', async () => {
    const { page, errors } = await open([390, 844], { site: withApk, ua: ANDROID_UA, look: { look: 'light', scheme: 'light', tokens: LIGHT } });
    await page.tap('#topDownload');
    await page.waitForSelector('#dlWays:not([aria-busy])', { state: 'attached' });
    await page.waitForTimeout(700);
    for (const sel of ['#dlAndroid .way-word', '#dlPlay .way-word', '#dlClassic', '#dlAll span']) expect(await contrast(page, sel), sel).toBeGreaterThanOrEqual(4.5);
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
