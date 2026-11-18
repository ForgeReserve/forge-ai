import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium, type Page } from 'playwright-core';
import { createInvite, type Gateway, mintsUp, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';
import { fakePhoneVoice } from './phonevoice.ts';

// The talk button is always in full view and pressable (owner, 2026-11-18, on an iPhone 13 Pro Max and a
// Pixel 8 Pro: a longer answer pushed the reply button down under Listen, its lower half and Hold to talk
// covered). On the home and on the answer, in Default and in Playful, with a short answer, a long one and
// a very long one with Markdown, on three phone sizes at the usual text size and at twice it: the button
// and its word lie inside the window and nothing lies over them; Listen and the bottom row are in full
// view and clear of the rings; the page itself does not scroll, the answer scrolls inside its card to its
// last line; and the card's actions can be pressed.
// MIC_SHOTS=<name> also saves screenshots of the long answer to .tmp/mic-shots/<name>.
const SHOTS = process.env.MIC_SHOTS ? resolve(import.meta.dirname, '../../.tmp/mic-shots', process.env.MIC_SHOTS) : null;
const SIZES = [
  [428, 926],
  [412, 892],
  [360, 640],
] as const;

const SHORT = 'Hello! How can I help you today? Is there something specific you would like to know?';
// About 120 words, as the answer the owner saw on the phones.
const LONG =
  'Ping was borrowed from sonar, where a quick sound pulse is called a ping. Early network engineers used it for a program that sends an echo request and listens for the reply, like a sonar pulse returning. ' +
  'The name was chosen by Mike Muuss in 1983, who wrote the first version in one evening after hearing about the idea at a meeting. ' +
  'It measures how long a message takes to reach another computer and come back, and whether it comes back at all. ' +
  'People still use it every day to check that a link works, to find a slow connection, and to see where a problem starts. ' +
  'Do you want a brief explanation of how the ping command works on your phone?';
// About 600 words with Markdown: headings, lists, bold, code and a table.
const VERY_LONG = [
  '## How ping works\n\nPing sends a small message to another computer and waits for the answer. The time between the two is the **round trip**, and it tells you how far away, or how busy, the other side is.',
  ...Array.from({ length: 6 }, (_, i) =>
    [
      `### Step ${i + 1}: what happens on the way`,
      'Your phone builds a short packet with a number in it, so each answer can be matched to its question. The packet goes to your router first, then out to the wider network, hop after hop, until it reaches the computer you named.',
      '- The packet carries a **sequence number** so lost ones can be counted.\n- Each hop may delay it a little, or drop it when it is busy.\n- The other side copies the packet and sends it straight back.',
      'When the copy comes home, the phone notes the time it took and prints a line for it. A few lines together show whether the link is steady or jumps around, which matters more than any single number.',
    ].join('\n\n'),
  ),
  '```\nping -c 4 example.org\n```',
  '| Time | Meaning |\n| --- | --- |\n| under 30 ms | close and quick |\n| 30 to 100 ms | normal |\n| over 200 ms | far or busy |',
  'If nothing comes back at all, the other computer may be switched off, or it may simply choose not to answer ping. That is the end of the answer.',
].join('\n\n');
const ANSWERS = { short: SHORT, long: LONG, veryLong: VERY_LONG };
/** The answer's last words, to know it is all in. */
const END = { short: 'like to know?', long: 'on your phone?', veryLong: 'end of the answer.' };

let g: Gateway;
let browser: Browser;

beforeAll(async () => {
  if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
  g = await startGateway({
    env: { FORGE_INVITE_ONLY: 'true' },
    editCatalog: (c) => {
      c.suppliers.freebie = { type: 'mock', tier: 'standard' };
      c.models.push({ id: 'plain-free', name: 'Plain Model', supplier: 'freebie', upstream: 'mock-echo', pricing: 'free', free_reason: 'ui test', max_output_tokens: 256 });
    },
  });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  if (SHOTS) mkdirSync(SHOTS, { recursive: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
});

/**
 * A phone with its text at `pct` %, a $0 balance on the free echo model, in `mode`. The engine's answer is
 * the text given to the returned setter: the echo model's own stream with its words swapped for it.
 */
async function phone(mode: 'default' | 'playful', pct: number) {
  const [width, height] = SIZES[0];
  const ctx = await browser.newContext({ viewport: { width, height }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await pastFirstRun(ctx);
  await fakePhoneVoice(ctx, true);
  // Larger text: the phone scales the words, not the boxes (as talk-still.ui.test.ts sets it).
  if (pct !== 100)
    await ctx.addInitScript((scale) => {
      document.addEventListener('DOMContentLoaded', () => {
        const s = document.createElement('style');
        s.textContent = `html { -webkit-text-size-adjust: ${scale}%; text-size-adjust: ${scale}%; }`;
        document.head.append(s);
      });
    }, pct);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let text = SHORT;
  await page.route('**/v1/chat/completions', async (route) => {
    const r = await route.fetch();
    const body = (await r.text()).replace('"content":"Forge"', `"content":${JSON.stringify(text)}`).replaceAll('"content":" word"', '"content":""');
    await route.fulfill({ response: r, body });
  });
  const res = await fetch(`${g.url}/v1/wallet/open`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: createInvite(g) }) });
  const b: any = await res.json();
  if (!b.key) throw new Error(`open failed: ${JSON.stringify(b)}`);
  await page.goto(`${g.url}/v2/`);
  await page.evaluate((k) => localStorage.setItem('forge.balanceKey', k), b.key);
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  if ((await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.click('[data-model="plain-free"]');
  await page.waitForSelector('[data-screen=model]', { state: 'detached' });
  if (mode === 'playful') {
    await page.goto(`${g.url}/v2/#/more/look`);
    await page.click('#mode-playful');
    await expect.poll(() => page.getAttribute('#mode-playful', 'aria-checked'), { timeout: 10_000 }).toBe('true');
    if ((await page.getAttribute('#gameFirst', 'aria-checked')) === 'true') {
      await page.click('#gameFirst');
      await expect.poll(() => page.getAttribute('#gameFirst', 'aria-checked')).toBe('false');
    }
  }
  return { ctx, page, errors, answerWith: (s: string) => (text = s) };
}

/** Waits until `sel` has held its place for 10 frames running (the rings and the card settle after a resize). */
const settled = (page: Page, sel: string) =>
  page.evaluate(
    (s) =>
      new Promise<void>((done) => {
        let last = '';
        let same = 0;
        const tick = () => {
          const b = document.querySelector(s)!.getBoundingClientRect();
          const k = `${b.x.toFixed(1)},${b.y.toFixed(1)},${b.width.toFixed(1)}`;
          same = k === last ? same + 1 : 0;
          last = k;
          if (same >= 10) done();
          else requestAnimationFrame(tick);
        };
        tick();
      }),
    sel,
  );

/**
 * What is wrong with the screen now, in words (none: an empty list). `answer`: the answer screen, whose
 * text is also scrolled to its end to check its last line and the card's actions.
 */
const problems = (page: Page, answer: boolean) =>
  page.evaluate((answer) => {
    const out: string[] = [];
    const W = innerWidth;
    const H = innerHeight;
    const fmt = (b: DOMRect) => `${Math.round(b.left)},${Math.round(b.top)} to ${Math.round(b.right)},${Math.round(b.bottom)}`;
    const inView = (b: DOMRect) => b.left >= -0.5 && b.top >= -0.5 && b.right <= W + 0.5 && b.bottom <= H + 0.5;
    /** Null when what lies at x, y is `n`, inside it, or passes `also`; else what lies there. */
    const hits = (n: Element, x: number, y: number, also = (_e: Element) => false) => {
      const e = document.elementFromPoint(x, y);
      return e && (n.contains(e) || also(e)) ? null : (e?.id ? `#${e.id}` : e?.className?.toString?.()) || String(e);
    };
    const mic = document.querySelector(answer ? '#replyBtn' : '#talkBtn')!;
    const rings = mic.closest('.rings')!;
    const m = mic.getBoundingClientRect();
    if (!inView(m)) out.push(`the talk button at ${fmt(m)} is not inside the window`);
    if (m.width < 95.5) out.push(`the talk button is ${Math.round(m.width)} px across`);
    const label = mic.querySelector('.talk-label')!.getBoundingClientRect();
    if (!inView(label)) out.push(`its word at ${fmt(label)} is not inside the window`);
    if (label.left < m.left - 0.5 || label.right > m.right + 0.5 || label.top < m.top - 0.5 || label.bottom > m.bottom + 0.5) out.push(`its word at ${fmt(label)} spills out of the button at ${fmt(m)}`);
    // The four corners and the centre: the button, or the rings' own area that lies round it.
    const ringHit = (e: Element) => e.classList.contains('ring-hit') && rings.contains(e);
    for (const [x, y] of [
      [m.left + 2, m.top + 2],
      [m.right - 2, m.top + 2],
      [m.left + 2, m.bottom - 2],
      [m.right - 2, m.bottom - 2],
      [m.left + m.width / 2, m.top + m.height / 2],
    ] as const) {
      const over = hits(mic, x, y, ringHit);
      if (over) out.push(`${over} lies over the talk button at ${Math.round(x)},${Math.round(y)}`);
    }
    // Listen and the bottom row: in view, pressable, clear of the rings.
    const ring = rings.getBoundingClientRect();
    for (const sel of [answer ? '#speakBtn' : null, '#btn-type', '#btn-add', '#btn-more']) {
      if (!sel) continue;
      const n = document.querySelector(sel);
      if (!n) {
        if (sel !== '#speakBtn' || !document.querySelector('[data-mode=playful]')) out.push(`no ${sel}`);
        continue;
      }
      const b = n.getBoundingClientRect();
      if (!inView(b)) out.push(`${sel} at ${fmt(b)} is not inside the window`);
      const over = hits(n, b.left + b.width / 2, b.top + b.height / 2);
      if (over) out.push(`${over} lies over ${sel}`);
      if (b.top < ring.bottom - 0.5 && b.bottom > ring.top + 0.5 && b.left < ring.right - 0.5 && b.right > ring.left + 0.5) out.push(`${sel} at ${fmt(b)} overlaps the rings at ${fmt(ring)}`);
    }
    if (!answer) return out;
    if (document.documentElement.scrollHeight > H + 1) out.push(`the page is ${document.documentElement.scrollHeight} px high in a ${H} px window`);
    // The answer's last line, its text scrolled to the end.
    const text = document.querySelector('#answerText')!;
    let box: Element | null = text.parentElement;
    while (box && !/auto|scroll/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    const scroller = box ?? document.scrollingElement!;
    scroller.scrollTop = scroller.scrollHeight;
    const walk = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    let lastText: Text | null = null;
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (n.textContent!.trim()) lastText = n as Text;
    const range = document.createRange();
    range.selectNodeContents(lastText!);
    const view = scroller === document.scrollingElement ? new DOMRect(0, 0, W, H) : scroller.getBoundingClientRect();
    let line = [...range.getClientRects()].at(-1)!;
    // On a short card what follows the text (the price line) can carry the last line up past the top: back to it.
    if (line.top < view.top) {
      scroller.scrollTop -= view.top - line.top;
      line = [...range.getClientRects()].at(-1)!;
    }
    if (line.top < view.top - 1 || line.bottom > view.bottom + 1 || !inView(line)) out.push(`the last line at ${fmt(line)} cannot be scrolled into view (${fmt(view)})`);
    else {
      const over = hits(text, line.left + Math.min(line.width / 2, 20), line.top + line.height / 2);
      if (over) out.push(`${over} lies over the last line`);
    }
    // The card's actions (Copy, Ask again, Burn; Playful's Again, Share, Burn).
    const tiles = [...document.querySelectorAll('.action-tiles > button, #pfActs > button')];
    if (tiles.length < 2) out.push('no action row');
    for (const n of tiles) {
      const b = n.getBoundingClientRect();
      const over = inView(b) ? hits(n, b.left + b.width / 2, b.top + b.height / 2) : 'the window edge';
      if (over) out.push(`${over} lies over #${n.id} at ${fmt(b)}`);
    }
    scroller.scrollTop = 0;
    return out;
  }, answer);

/** Asks a typed question from the home and waits until the whole answer is in, with its Markdown. */
async function ask(page: Page, end: string) {
  await page.click('#btn-type');
  await page.waitForSelector('[data-screen=type]');
  await page.fill('#question', 'How does ping work?');
  await page.click('#sendBtn');
  await page.waitForSelector('[data-screen=answer] #burnBtn', { timeout: 20_000 });
  await expect.poll(() => page.textContent('#answerText'), { timeout: 10_000 }).toContain(end);
  // Markdown is in once the answer's lists are drawn as lists (it loads with the first answer screen).
  await page.waitForFunction(() => !document.querySelector('#answerText .plain'));
  await page.evaluate(() => document.fonts.ready);
}

async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  await page.evaluate(() => document.getElementById('toast')?.classList.remove('show'));
  await page.waitForTimeout(250); // the toast's fade
  await page.screenshot({ path: join(SHOTS, `${name}.png`) });
}

describe('the talk button is always in full view', () => {
  it.each([
    ['default', 100],
    ['default', 200],
    ['playful', 100],
    ['playful', 200],
  ] as const)('%s, text at %i percent: the home and short, long and very long answers on three phones', async (mode, pct) => {
    const { ctx, page, errors, answerWith } = await phone(mode, pct);
    const found: string[] = [];
    await page.goto(`${g.url}/v2/#/`);
    await page.waitForSelector('[data-screen=home] #talkBtn');
    await page.evaluate(() => document.fonts.ready);
    for (const [w, h] of SIZES) {
      await page.setViewportSize({ width: w, height: h });
      await settled(page, '#talkBtn');
      if (w === 360) await shot(page, `${mode}-home-${w}x${h}-${pct}`);
      for (const p of await problems(page, false)) found.push(`home ${w}x${h}: ${p}`);
    }
    for (const [len, text] of Object.entries(ANSWERS) as Array<[keyof typeof ANSWERS, string]>) {
      answerWith(text);
      await page.setViewportSize({ width: SIZES[0][0], height: SIZES[0][1] });
      await page.goto(`${g.url}/v2/#/`);
      await page.waitForSelector('[data-screen=home] #talkBtn');
      await ask(page, END[len]);
      for (const [w, h] of SIZES) {
        await page.setViewportSize({ width: w, height: h });
        await settled(page, '#replyBtn');
        if (len !== 'short' && w !== 412) await shot(page, `${mode}-${len}-${w}x${h}-${pct}`);
        for (const p of await problems(page, true)) found.push(`${len} answer ${w}x${h}: ${p}`);
      }
    }
    expect(found).toEqual([]);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 180_000);
});
