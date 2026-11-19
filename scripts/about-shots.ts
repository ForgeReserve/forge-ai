/**
 * Makes the phone screenshots on the landing page (public/about/, served at /): the v2 app at a
 * phone's size, with made-up words and a test balance, saved as WebP in public/about/shots/: the home, an
 * answer, Private only, Add money (the paper note's card and the cards' card) and Share unseen.
 *
 *   pnpm mint:up                       # once: the local test mints
 *   pnpm about:shots                   # writes public/about/shots/*.webp
 *
 * Runs a local gateway with the test catalog and one extra model on the mock supplier, funds it from the
 * local test mint, and drives the installed Chrome (channel 'chrome'). The question and answer are
 * written here (QUESTION, ANSWER); the answer replaces the mock model's words. The mock cannot take an
 * encrypted question, so the app is shown that model as a Private one (showPrivate) only where no
 * question is sent, and the answer is opened again that way once it is in. Nothing leaves this
 * computer. Chrome itself makes the WebP files (canvas.toBlob), so no image tool is needed.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type BrowserContext, chromium, type Page } from 'playwright-core';
import { setLogSilent } from '../src/log.ts';
import { createInvite, MINT_A, mintsUp, mintToken, startGateway } from '../test/e2e/helpers.ts';

setLogSilent(true);
const ROOT = resolve(import.meta.dirname, '..');
const OUT = join(ROOT, 'public', 'about', 'shots');
/** The size of a shot in CSS pixels (an ordinary phone) and the width of the saved file. */
const PHONE = { width: 390, height: 844 };
const SAVE_WIDTH = 600;

const MODEL = 'tinfoil/gemma4-31b';
const QUESTION = 'How do I keep my phone safe at a march?';
const ANSWER = [
  'Three steps help:',
  '',
  '- **Use a passcode.** A face or a finger can be forced.',
  '- **Turn off location** before you go.',
  '- **Turn on auto-delete** for your chats.',
].join('\n');

if (!(await mintsUp())) throw new Error('The local test mints are not running. Start them with pnpm mint:up.');
const g = await startGateway({
  env: { FORGE_INVITE_ONLY: 'true' },
  // A Private model with a real model's name, on the mock supplier (tier enclave, so the app marks it Private).
  editCatalog: (c) => {
    c.suppliers.mockenclave = { type: 'mock', tier: 'enclave' };
    c.models.push({ ...c.models.find((m: any) => m.id === 'mock-echo'), id: MODEL, name: 'Gemma 4 31B', supplier: 'mockenclave', upstream: 'mock-echo', vision: true });
  },
});
const browser = await chromium.launch({ channel: 'chrome', headless: true });
mkdirSync(OUT, { recursive: true });

async function fundedKey(cents: number): Promise<string> {
  const token = await mintToken(MINT_A, 'usd', cents);
  const r = await fetch(`${g.url}/v1/wallet/topup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, invite: createInvite(g) }) });
  const b: any = await r.json();
  if (!b.key) throw new Error(`topup failed: ${JSON.stringify(b)}`);
  return b.key;
}

/**
 * Shows MODEL to the app as a Private model, as a Tinfoil model is listed (encrypted_passthrough). The
 * mock supplier cannot take an encrypted question, so a question is asked before this is turned on.
 */
const showPrivate = (ctx: BrowserContext) =>
  ctx.route('**/v1/models', async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    for (const m of body.data) if (m.id === MODEL) m.encrypted_passthrough = true;
    await route.fulfill({ response: res, json: body });
  });

/** A phone past the first run, with a balance and MODEL chosen (Private, or with Private only off). */
async function phone(key: string | null, asPrivate = true): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: PHONE, isMobile: true, hasTouch: true, deviceScaleFactor: 2, reducedMotion: 'reduce' });
  await ctx.addInitScript((k) => {
    localStorage.setItem('forge2.firstRun', 'done');
    if (k && !localStorage.getItem('forge.balanceKey')) localStorage.setItem('forge.balanceKey', k);
  }, key);
  if (asPrivate) await showPrivate(ctx);
  const page = await ctx.newPage();
  await page.goto(`${g.url}/v2/#/more/model`);
  await page.waitForSelector('[data-screen=model]');
  if (!asPrivate && (await page.getAttribute('#privateOnly', 'aria-checked')) === 'true') await page.click('#privateOnly');
  await page.waitForSelector(`[data-model="${MODEL}"]`);
  await page.click(`[data-model="${MODEL}"]`);
  await page.goto(`${g.url}/v2/#/`);
  await page.waitForSelector('[data-screen=home]');
  return { ctx, page };
}

/** Saves the page as it is now: a PNG from Chrome, made into a WebP SAVE_WIDTH wide by Chrome's own encoder. */
async function shot(page: Page, name: string) {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  // No toast ("Gemma 4 31B chosen") over the screen.
  await page.waitForFunction(() => !document.querySelector('#toast.show'), null, { timeout: 10_000 });
  await page.waitForTimeout(600);
  const png = await page.screenshot({ type: 'png' });
  const webp = await page.evaluate(
    async ({ b64, width }) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + b64;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = width;
      c.height = Math.round((img.height * width) / img.width);
      const x = c.getContext('2d')!;
      x.imageSmoothingQuality = 'high';
      x.drawImage(img, 0, 0, c.width, c.height);
      const blob: Blob = await new Promise((r) => c.toBlob((b) => r(b!), 'image/webp', 0.86));
      return { bytes: Array.from(new Uint8Array(await blob.arrayBuffer())), height: c.height };
    },
    { b64: png.toString('base64'), width: SAVE_WIDTH },
  );
  writeFileSync(join(OUT, `${name}.webp`), Buffer.from(webp.bytes));
  console.log(`${name}.webp ${SAVE_WIDTH}x${webp.height} ${Math.round(webp.bytes.length / 1024)} KB`);
}

try {
  const key = await fundedKey(500);

  // 1. Home: the two rings, with funds.
  {
    const { ctx, page } = await phone(key);
    await shot(page, 'home');
    await ctx.close();
  }

  // 2. An answer, with the words above in place of the mock model's.
  {
    const { ctx, page } = await phone(key, false);
    await page.route('**/v1/chat/completions', async (route) => {
      const res = await route.fetch();
      let first = true;
      const body = (await res.text())
        .split('\n')
        .map((line) => {
          if (!line.startsWith('data: {')) return line;
          const d = JSON.parse(line.slice(6));
          const delta = d.choices?.[0]?.delta;
          if (delta && typeof delta.content === 'string') {
            delta.content = first ? ANSWER : '';
            first = false;
          }
          return 'data: ' + JSON.stringify(d);
        })
        .join('\n');
      await route.fulfill({ response: res, body });
    });
    await page.click('#btn-type');
    await page.waitForSelector('[data-screen=type]');
    await page.fill('#question', QUESTION);
    await page.click('#sendBtn');
    await page.waitForSelector('[data-screen=answer]');
    await page.waitForSelector('#answerText:not(:has(> p.plain))');
    await page.waitForSelector('#copyBtn', { timeout: 20_000 });
    // Opened again with MODEL shown as Private, as the answer from a Private model looks.
    await showPrivate(ctx);
    await page.reload();
    await page.waitForSelector('[data-screen=answer]');
    await page.waitForSelector('#answerText:not(:has(> p.plain))');
    await shot(page, 'answer');
    await ctx.close();
  }

  // 3. Add money: the wallet cards, one way per card. First the paper note's card, then the cards' card.
  {
    const { ctx, page } = await phone(await fundedKey(500));
    await page.goto(`${g.url}/v2/#/funds/add`);
    await page.waitForSelector('[data-screen=addFunds]');
    await shot(page, 'add-money');
    await page.click('#tab-cards');
    await page.waitForSelector('#tab-cards[aria-selected=true]');
    await shot(page, 'pay-card');
    await ctx.close();
  }

  // 3b. Private only: the first run's last step, with the switch on.
  {
    const { ctx, page } = await phone(key);
    await page.goto(`${g.url}/v2/#/start/private`);
    await page.waitForSelector('[data-step=private] #privateToggle[aria-checked=true]');
    await shot(page, 'private');
    await ctx.close();
  }

  // 4. Share unseen: a public domain photo (test/unit/fixtures/photos/README.md) with its faces covered.
  {
    const { ctx, page } = await phone(key);
    await page.click('#btn-add');
    await page.click('#addPhoto');
    await page.waitForSelector('[data-screen=photo]');
    await page.setInputFiles('#photoFile', { name: 'crew.jpg', mimeType: 'image/jpeg', buffer: readFileSync(join(ROOT, 'test/unit/fixtures/photos/crew.jpg')) });
    await page.waitForSelector('#photoChanges', { timeout: 60_000 });
    await shot(page, 'share-unseen');
    await ctx.close();
  }
} finally {
  await browser.close();
  await g.close();
}
