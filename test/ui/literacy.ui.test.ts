import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';
import { createInvite, creditMintUp, type Gateway, MINT_A, MINT_CREDIT, mintsUp, mintToken, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { openWay } from './ways.ts';

// Reading load (owner, 2026-11-15): the app is made for people who read with difficulty or whose English
// is weak. Fewer words, more icons; one short word or label per element; no paragraphs on screen; the
// explanations behind an info button or spoken by Listen; 48 px targets. Every screen, sheet, notice and
// error state below is opened in Midnight on a 412 by 915 phone, photographed under .tmp/literacy/after/
// (LITERACY_PHASE=before keeps the pictures of the old screens apart and only counts), and checked:
//  - no visible run of text longer than LIMIT words, outside the places long text is allowed: a panel an
//    info button opened (.info-more and the wallet's .way-info), a first run sheet opened by Learn more,
//    the answer itself, the question the person asked (or its first words in History), and the words the
//    owner approved as they are ([data-approved]: the first run's titles and lines, the Private-only
//    question);
//  - every button has an icon or a one-word label;
//  - every target is at least 48 by 48 px.
// The words counted on each screen are written to words.json beside the pictures (docs/design/SCREENS.md,
// Reading load).
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const PHASE = process.env.LITERACY_PHASE === 'before' ? 'before' : 'after';
const STRICT = PHASE === 'after' && !process.env.LITERACY_REPORT;
const SHOTS = join(import.meta.dirname, '../../.tmp/literacy', PHASE);
const PHOTOS = resolve(import.meta.dirname, '../unit/fixtures/photos');
const CREW = readFileSync(resolve(PHOTOS, 'crew.jpg'));
/** The longest run of words a person must read in one place. */
const LIMIT = 8;

let g: Gateway;
let browser: Browser;
const report: Record<string, Reading> = {};

interface Reading {
  words: number;
  long: string[];
  buttons: string[];
  small: string[];
}

beforeAll(async () => {
  if (!(await mintsUp()) || !(await creditMintUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    audio: true,
    env: {
      FORGE_INVITE_ONLY: 'true',
      FORGE_CREDIT_MINT: MINT_CREDIT,
      FORGE_FREE_MODELS: 'mock-echo',
      FORGE_FAUCET_ENABLED: 'true',
      FORGE_FAUCET_POW_BITS: '8',
      FORGE_FAUCET_POW_MAX_BITS: '10',
      FORGE_FAUCET_PER_ADDRESS: '0',
    },
    editCatalog: (c) => {
      const echo = c.models.find((m: any) => m.id === 'mock-echo');
      c.models.push({ ...echo, id: 'mock-small', name: 'Small memory', upstream: 'mock-echo', context_length: 1900, max_output_tokens: 64 });
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'glm-5.3-flash', name: 'GLM Flash', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
}, 60_000);

afterAll(async () => {
  mkdirSync(SHOTS, { recursive: true });
  const old = (() => {
    try {
      return JSON.parse(readFileSync(join(SHOTS, 'words.json'), 'utf8'));
    } catch {
      return {};
    }
  })();
  writeFileSync(join(SHOTS, 'words.json'), JSON.stringify({ ...old, ...report }, null, 2));
  await browser?.close();
  await g?.close();
});

async function phone({ seen = true, voices = true } = {}) {
  const ctx = await browser.newContext(PHONE);
  if (seen) await pastFirstRun(ctx);
  await ctx.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'], { origin: g.url });
  // A phone voice, so Listen shows where a screen has it.
  if (voices)
    await ctx.addInitScript(() => {
      const w = window as any;
      w.SpeechSynthesisUtterance = class {
        text: string;
        onend: any = null;
        constructor(t: string) {
          this.text = t;
        }
      };
      Object.defineProperty(window, 'speechSynthesis', {
        configurable: true,
        value: { getVoices: () => [{ name: 'Phone voice', lang: 'en-US', localService: true }], speak: (u: any) => setTimeout(() => u.onend?.(), 50), cancel: () => {}, addEventListener: () => {}, removeEventListener: () => {} },
      });
    });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // 400 to 403: a refused invite or token, a model with no key or no funds, on purpose. 500: mock-fail.
  page.on('console', (m) => m.type() === 'error' && !/40[0-3]|500|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  return { ctx, page, errors };
}

/**
 * Counts the words on the screen as a person sees them, and what breaks the rule: a run of text over
 * LIMIT words outside the allowed places, a button with neither an icon nor a one-word label, and a
 * target under 48 px. Runs in the page.
 */
const read = (page: Page) =>
  page.evaluate((limit) => {
    const ALLOWED = '.info-more, .way-info, .fr-sheet, [data-approved], #answerText, .asked, .hist-text, .listen-text, .faucet-token';
    const seen = (e: Element) => {
      if (e.closest('[hidden], [aria-hidden=true], .sr-only, dialog:not([open]), svg, script, style, template')) return false;
      if (!(e as HTMLElement).checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) return false;
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };
    // A word has a letter in it: amounts, times and counts are not reading.
    const words = (s: string) => s.split(/\s+/).filter((w) => /\p{L}/u.test(w));
    const out = { words: 0, long: [] as string[], buttons: [] as string[], small: [] as string[] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    // Text in one element (its own text nodes and inline children) reads as one run.
    const runs = new Map<Element, string>();
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = n.textContent ?? '';
      if (!text.trim()) continue;
      let e = n.parentElement!;
      while (e.parentElement && /^(B|I|EM|STRONG|SPAN|SMALL|A|CODE)$/.test(e.tagName) && getComputedStyle(e).display === 'inline') e = e.parentElement;
      if (!seen(n.parentElement!)) continue;
      runs.set(e, `${runs.get(e) ?? ''} ${text}`);
    }
    for (const [e, text] of runs) {
      const w = words(text);
      out.words += w.length;
      if (w.length > limit && !e.closest(ALLOWED)) out.long.push(`${(e.id || e.className || e.tagName).toString().slice(0, 30)}: ${text.trim().replace(/\s+/g, ' ').slice(0, 90)}`);
    }
    for (const b of document.querySelectorAll('button, a[href], [role=button], [role=switch], [role=radio], [role=tab], input:not([type=file]), textarea, select')) {
      if (!seen(b) || (b as HTMLElement).tabIndex < 0) continue;
      const name = (b.id || b.className || b.tagName).toString().slice(0, 30);
      // The layout size: a wallet card that peeks beside the one on show is drawn a little smaller. A
      // block over a photo is the size of what it covers; its hit area reaches 48 px (style.css).
      const [w, h] = [(b as HTMLElement).offsetWidth, (b as HTMLElement).offsetHeight];
      if ((w < 48 || h < 48) && !b.classList.contains('cover-box')) out.small.push(`${name} ${w}x${h}`);
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(b.tagName)) continue;
      const pictured = !!b.querySelector('svg, img, canvas, .tile-ico, .radio, .track, .fr-track, .look-thumb') || getComputedStyle(b).backgroundImage !== 'none';
      const label = words([...b.childNodes].map((c) => (c.nodeType === 3 || seen(c as Element) ? c.textContent : '')).join(' ')).length;
      if (!pictured && label > 1 && !b.closest(ALLOWED)) out.buttons.push(`${name}: ${b.textContent?.trim().slice(0, 40)}`);
    }
    return out;
  }, LIMIT);

/** Photographs the screen and checks its reading load. */
async function check(page: Page, name: string): Promise<void> {
  mkdirSync(SHOTS, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(350);
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
  const r = await read(page);
  report[name] = r;
  if (STRICT) {
    expect(r.long, `${name}: text over ${LIMIT} words`).toEqual([]);
    expect(r.buttons, `${name}: buttons with no icon and more than one word`).toEqual([]);
    expect(r.small, `${name}: targets under 48 px`).toEqual([]);
  }
}

async function fundedKey(cents = 300): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', cents);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

async function zeroKey(): Promise<string> {
  const r = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`open failed: ${JSON.stringify(b)}`);
  return b.key;
}

async function useModel(page: Page, id: string, privateOnly = false) {
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click(`[data-model="${id}"]`);
  if (privateOnly) await page.click('#privateOnly');
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
}

async function withKey(page: Page, key: string, model = 'mock-echo') {
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), key);
  await useModel(page, model);
  await expect.poll(() => page.textContent('#balanceText'), { timeout: 8000 }).toMatch(/^\$/);
}

async function go(page: Page, route: string, screen: string) {
  await page.goto(`${g.url}/v2/#/${route}`);
  await page.waitForSelector(screen);
}

async function ask(page: Page, q: string) {
  await go(page, 'type', '[data-screen=type]');
  await page.fill('#question', q);
  await page.click('#sendBtn');
  await page.waitForSelector('[data-screen=answer]');
}

describe('reading load on every screen', () => {
  it('the home, the sheets, Type, the answer and its errors, with money', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('#addMoney:not([hidden])');
    await check(page, 'home-no-funds');

    await withKey(page, await fundedKey(), 'mock-small');
    await check(page, 'home-money');
    await page.click('#btn-add');
    await page.waitForSelector('#addSheet');
    await check(page, 'sheet-add');
    await page.click('#btn-add');
    await page.click('#btn-more');
    await page.waitForSelector('#moreSheet');
    await check(page, 'sheet-more');

    // Holding the talk button: the line under the rings while it records.
    await go(page, '', '[data-screen=home]');
    const talk = (await page.locator('#talkBtn').boundingBox())!;
    await page.mouse.move(talk.x + talk.width / 2, talk.y + talk.height / 2);
    await page.mouse.down();
    await page.waitForSelector('.listen-info:not([hidden])', { timeout: 8000 }).catch(() => {});
    await check(page, 'home-talking');
    await page.mouse.move(5, 5);
    await page.mouse.up();

    await go(page, 'type', '[data-screen=type]');
    await page.fill('#question', 'Which roads does the market notice cover?');
    await check(page, 'type');
    await page.click('#sendBtn');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    await check(page, 'answer');
    await ask(page, `Please read this. ${'The street notice covers the market and the side roads. '.repeat(112)}`);
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    await go(page, '', '#memoryLow:not([hidden])');
    await check(page, 'home-memory-low');
    await go(page, 'funds', '[data-screen=funds]');
    await expect.poll(() => page.textContent('#fundsAmount')).toMatch(/^\$/);
    await check(page, 'funds');

    // A model that fails: the error, its one next step and its price.
    await page.click('#startFresh');
    await useModel(page, 'mock-fail');
    await ask(page, 'Which roads are closed?');
    await page.waitForSelector('#answerError:not([hidden])', { timeout: 20_000 });
    await check(page, 'answer-error');

    await go(page, 'funds/out', '[data-screen=takeOut]');
    await page.waitForSelector('#outBtn:not([hidden])');
    await check(page, 'take-out');
    await page.fill('#outAmount', '0.50');
    await page.click('#outBtn');
    await page.waitForSelector('.token-card', { timeout: 20_000 });
    await check(page, 'take-out-token');
    await go(page, 'funds', '[data-screen=funds]');
    await page.waitForSelector('#vaultBox .vault-row');
    await check(page, 'funds-ecash-kept');
    await go(page, 'more/erase', '[data-screen=erase]');
    await check(page, 'erase-money');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);

  it('no funds: the free model, Type with the funds notice and the Private-only question', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/`);
    await useModel(page, 'glm-5.3-flash');
    await page.waitForSelector('#freeModelChip:not([hidden])');
    await check(page, 'home-free-model');
    await go(page, 'funds', '#fundsAmount');
    await check(page, 'funds-free-model');
    await go(page, 'type', '#typeNotice:not([hidden])');
    await check(page, 'type-need-balance');

    await useModel(page, 'mock-echo', true);
    await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), await zeroKey());
    await go(page, 'type', '[data-screen=type]');
    await page.reload();
    await page.waitForSelector('#noticeFreeBtn');
    await check(page, 'type-no-funds');
    await page.click('#noticeFreeBtn');
    await page.waitForSelector('#typeFreeAsk');
    await check(page, 'type-private-question');
    await go(page, 'funds', '#fundsAmount');
    await check(page, 'funds-zero');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('Add money: the cards and their info, Start free and its question, and each way', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await go(page, 'funds/add', '#tab-note');
    await check(page, 'add-money');
    await page.click('#tab-note');
    await page.click('#wayInfoBtn-note');
    await page.waitForSelector('#wayInfo-note:not([hidden])');
    await check(page, 'add-money-info');
    await page.click('#tab-more');
    await check(page, 'add-money-more');

    await go(page, 'funds/start-free', '[data-screen=startFree]');
    await check(page, 'start-free');
    await page.fill('#startFreeCode', 'not-a-code');
    await page.click('#startFreeGo');
    await expect.poll(() => page.textContent('#startFreeMsg')).not.toBe('');
    await page.waitForFunction(() => !/Opening/.test(document.querySelector('#startFreeMsg')?.textContent ?? ''));
    await check(page, 'start-free-wrong-code');
    await page.fill('#startFreeCode', createInvite(g));
    await page.click('#startFreeGo');
    await page.waitForSelector('#startFreeAsk:not([hidden])');
    await check(page, 'start-free-question');
    await page.click('#startFreeUse');
    await page.waitForSelector('#fundsAsk:not([hidden])');
    await check(page, 'funds-start-free');

    for (const way of ['note', 'ecash', 'lightning', 'othermint', 'free', 'card', 'fedimint']) {
      await go(page, 'funds/add', '[data-screen=addFunds]');
      await openWay(page, way);
      await page.waitForSelector(`[data-fund=${way}]`);
      await page.waitForTimeout(300);
      await check(page, `fund-${way}`);
    }

    // A wrong eCash token, and a Lightning invoice.
    await go(page, 'funds/add/ecash', '#ecashToken');
    await page.fill('#ecashToken', 'not a token');
    await page.click('#ecashAdd');
    await page.waitForSelector('[data-fund=ecash] .msg.err');
    await check(page, 'fund-ecash-error');
    await go(page, 'funds/add/lightning', '[data-fund=lightning]');
    await page.fill('#lnAmount', '1.00');
    await page.click('#lnCreate');
    await page.waitForSelector('[data-fund=lightning] .qr', { timeout: 20_000 }).catch(() => {});
    await check(page, 'fund-lightning-invoice');
    await go(page, 'funds/free-out', '[data-screen=freeOut]');
    await check(page, 'free-out');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);

  it('More: the model picker, the look, voice, History, Erase, Engine and Share unseen', async () => {
    const { ctx, page, errors } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const [route, screen, name] of [
      ['more/model', '[data-model]', 'model'],
      ['more/look', '[data-screen=look]', 'look'],
      ['more/voice', '[data-screen=voice]', 'voice'],
      ['more/history', '#historyEmpty', 'history-empty'],
      ['more/erase', '[data-screen=erase]', 'erase'],
      ['more/engine', '[data-screen=engine]', 'engine'],
      ['photo', '[data-screen=photo]', 'photo'],
      ['photo/missed', '#photoAlert', 'photo-missed'],
      ['photo/none', '#photoAlert', 'photo-none'],
      ['photo/sent', '#photoAlert', 'photo-sent'],
    ] as const) {
      await go(page, route, screen);
      await check(page, name);
    }
    await go(page, 'more/engine', '#engineAddress');
    await page.fill('#engineAddress', 'http://example.com');
    await page.click('#engineUse');
    await page.waitForSelector('#engineMsg.err');
    await check(page, 'engine-error');

    await go(page, 'more/erase', '#eraseHold');
    await page.click('#eraseHold');
    await page.waitForSelector('.msg.err');
    await check(page, 'erase-tapped');

    // A photo, checked on the phone.
    await go(page, 'photo', '[data-screen=photo]');
    await page.setInputFiles('#photoFile', { name: 'IMG_2042.jpg', mimeType: 'image/jpeg', buffer: CREW });
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    await check(page, 'photo-review');

    // History with a conversation in it.
    await withKey(page, await fundedKey());
    await ask(page, 'Which roads does the market notice cover?');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    await go(page, 'more/history', '.hist-card');
    await check(page, 'history');
    await page.click('#burnAll');
    await page.waitForSelector('#burnAllConfirm:not([hidden])');
    await check(page, 'history-burn-all');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);

  it('the first run, its sheets and the invite sheet', async () => {
    const { ctx, page, errors } = await phone({ seen: false });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/v2/`);
    await page.waitForSelector('[data-screen=intro][data-step=welcome]');
    await page.waitForTimeout(500);
    await check(page, 'intro-welcome');
    for (const [step, link, name] of [
      ['pay', '#learnMoreLink', 'intro-pay'],
      ['limits', '#fullListLink', 'intro-limits'],
      ['private', '#privateInfo', 'intro-private'],
    ] as const) {
      await page.click('#introNext');
      await page.waitForSelector(`[data-screen=intro][data-step=${step}]`);
      await page.waitForTimeout(400);
      await check(page, name);
      await page.click(link);
      await page.waitForSelector('dialog#learnSheet[open]');
      await check(page, `${name}-sheet`);
      await page.click('#learnSheetClose');
    }
    await page.waitForSelector('#introInviteLink:not([hidden])');
    await page.click('#introInviteLink');
    await page.waitForSelector('dialog#inviteSheet[open]');
    await check(page, 'intro-invite');
    expect(errors).toEqual([]);
    await ctx.close();
  }, 120_000);

  it('the /free and /download pages, and the screen after Erase', async () => {
    const { ctx, page } = await phone();
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${g.url}/free`);
    await page.waitForSelector('[data-screen=free]');
    await page.waitForSelector('#freeGet:not([disabled])', { timeout: 10_000 }).catch(() => {});
    await check(page, 'free-page');
    await page.goto(`${g.url}/v2/download/`);
    await page.waitForSelector('[data-screen=download]');
    await check(page, 'download-page');

    await go(page, 'more/erase', '#eraseHold');
    const b = (await page.locator('#eraseHold').boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.down();
    await page.waitForSelector('[data-screen=erased]', { timeout: 15_000 });
    await page.mouse.up();
    await check(page, 'erased');
    await ctx.close();
  }, 90_000);
});
