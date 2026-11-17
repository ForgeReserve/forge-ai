# Write your first module

This guide builds two modules for the Forge app and ends with both working: a look, which is only colours, and a filter for Share unseen, which has real logic. Each step shows the files and the code. The finished modules are in [`docs/modules/examples/`](https://github.com/ForgeReserve/forge-ai/blob/main/docs/modules/examples), and a test loads them through the app's registry, so the code on this page is the code that runs.

Read [the overview](README.md) first if you have not: it explains the manifest, the registry, and what a module can and cannot do today.

## What you need

- Node 22.18 or later, and pnpm.
- Docker, for the local test mints. A look or a filter does not need them; a fund module and the UI tests do.
- Chrome, for the UI tests.
- A fork of [ForgeReserve/forge-ai](https://github.com/ForgeReserve/forge-ai) on GitHub.

## Run the app on your computer

The engine and the app are one Node server. It serves the app at `/v2/` with no build step: change a file, reload the page.

```sh
git clone https://github.com/<you>/forge-ai.git
cd forge-ai
pnpm install
pnpm mint:up
FORGE_TRUSTED_MINTS=http://127.0.0.1:3338 \
FORGE_MODELS_FILE=config/models.dev.json \
FORGE_DB_PATH=data/dev.db \
FORGE_INVITE_ONLY=false \
FORGE_FOREIGN_DISCOVERY_RELAYS= \
pnpm start
```

Then open `http://localhost:8787/v2/`.

What each part does:

- `pnpm mint:up`: starts four local Cashu mints in Docker, on `127.0.0.1:3338` to `3341`. Their eCash is test money: invoices are paid on their own.
- `FORGE_TRUSTED_MINTS`: the engine takes eCash from the first local mint.
- `FORGE_MODELS_FILE`: the local catalog, with a mock model that answers without any API key.
- `FORGE_DB_PATH`: the engine's database, in `data/`, which git ignores.
- `FORGE_INVITE_ONLY=false`: new balances open without an invite code.
- `FORGE_FOREIGN_DISCOVERY_RELAYS=`: the engine does not read public Nostr relays for other mints.

To put test money on the app, make a token and paste it in Add money, eCash:

```sh
pnpm test-token 50 usd
```

It prints a token worth 50 cents from the local mint. The mock models are Standard models, so turn Private only off in More, Choose a model, to ask them a question.

One part of the app is not in the repository: the natural voice's files (about 68 MB), fetched with `node scripts/phonon-model.ts`; without them the browser logs one `404` for `/v2/voice/phonon/index.json` and the natural voice is not offered. The UI tests need them.

## How a module reaches the app

Every module, of any kind, takes the same five steps:

1. A folder `public/v2/modules/<kind>/<name>/` with `manifest.json` and `index.js`.
2. A line in `BUNDLED` in [`public/v2/core/registry.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/core/registry.js).
3. Its words in [`public/v2/strings/en.js`](https://github.com/ForgeReserve/forge-ai/blob/main/public/v2/strings/en.js).
4. `node scripts/v2-preload.ts`, which adds its files to the page's preload list.
5. Tests.

## A look: High contrast

A look is a set of colours. This one is black on white with dark colours and solid edges, for people who see poorly or use the phone in bright sun.

### Step 1: the look's manifest

Make the folder `public/v2/modules/look/contrast/` and put this `manifest.json` in it:

```json
{
  "id": "org.example.look.contrast",
  "kind": "look",
  "version": "1.0.0",
  "name": {
    "en": "High contrast"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

The registry checks every field: [the manifest rules](README.md#the-manifest).

### Step 2: the colours

`index.js` exports `create()`, which returns the look: its `id`, its `scheme` and its `tokens`. A look needs every token the bundled looks have; a token left out keeps the colour of the look shown before. Start from a copy of `public/v2/modules/look/light/index.js` and change the colours:

```js
// A look module: black on white, with dark colours and solid edges, for people who see poorly or use
// the phone in bright sun. Design tokens only; a look is handed no inputs.
export const tokens = Object.freeze({
  "bg": "#FFFFFF",
  "backdrop": "#E6E6E6",
  "surface": "#FFFFFF",
  "surface-2": "#F2F2F2",
  "ink": "#000000",
  "text-2": "#333333",
  "text-body": "#111111",
  "line": "#5C5C5C",
  "line-2": "#3D3D3D",
  "bar-track": "#D9D9D9",
  "grabber": "#5C5C5C",
  "dash": "#5C5C5C",
  "teal": "#005A4E",
  "teal-tint": "#E0F2EE",
  "teal-line": "#005A4E",
  "teal-bright": "#007A69",
  "memory": "#006B5D",
  "memory-track": "#CDEBE4",
  "gold": "#8A5A00",
  "gold-track": "#F0DDB0",
  "gold-ink": "#6B4500",
  "gold-line": "#6B4500",
  "gold-callout": "#8A5A00",
  "gold-tint": "#FBEFD2",
  "gold-free": "#C99A3A",
  "danger": "#A1200F",
  "danger-tint": "#FDE3DF",
  "danger-ink": "#FFFFFF",
  "low": "#A14A00",
  "low-tint": "#FDEBD9",
  "low-line": "#A14A00",
  "low-ink": "#6E2E00",
  "blue": "#003F9E",
  "blue-tint": "#DCE8FF",
  "violet": "#3F1FA8",
  "violet-tint": "#E8E0FF",
  "green": "#2F5200",
  "green-tint": "#E5F2CC",
  "primary": "#000000",
  "primary-ink": "#FFFFFF",
  "talk": "#000000",
  "talk-ink": "#FFFFFF",
  "shadow-raised": "inset 0 0 0 2px #000000",
  "shadow-raised-sm": "inset 0 0 0 2px #000000",
  "shadow-primary": "inset 0 -4px 0 rgba(255,255,255,0.25)",
  "shadow-talk": "inset 0 -6px 0 rgba(255,255,255,0.25)",
  "shadow-float": "0 0 0 2px #000000, 0 12px 40px rgba(0,0,0,0.25)",
  "focus": "#003F9E"
});

export function create() {
  return { id: 'contrast', scheme: 'light', tokens };
}
```

[Look modules](look.md#tokens) lists what each token colours.

### Step 3: the look's words

More, Mode and look shows each look's name and a short line, from the string table. Add two lines to `public/v2/strings/en.js`, after the Midnight look's:

```js
  'look.contrast.name': 'High contrast',
  'look.contrast.sub': 'Black on white, for easy reading.',
```

### Step 4: list the look

Add the look to `BUNDLED` in `public/v2/core/registry.js`, after Midnight. The app lists looks in this order:

```js
export const BUNDLED = [
  { kind: 'look', folder: 'light' },
  { kind: 'look', folder: 'dark' },
  { kind: 'look', folder: 'midnight' },
  { kind: 'look', folder: 'contrast' },
```

### Step 5: the preload list

The page names every bundled file up front so the browser fetches them at once. Write the list again:

```sh
node scripts/v2-preload.ts
```

It prints `public/v2/index.html: preload list written`, and `test/unit/v2/preload.test.ts` fails until you do.

### Step 6: see the look

Reload `http://localhost:8787/v2/`, open More, then Mode and look, and tap High contrast. The whole app turns black on white at once, and stays so after a reload.

### Step 7: test the look

Add `test/unit/v2/contrast-look.test.ts`. It checks the two things a look can get wrong: a missing token, and text too faint to read.

```ts
import { describe, expect, it } from 'vitest';

// The High contrast look (public/v2/modules/look/contrast/): every token Midnight has, and text that
// keeps a contrast of 4.5 to 1 or more on its ground.
const load = async (id: string) => ((await import(`../../../public/v2/modules/look/${id}/index.js` as string)) as any).create();
const look = await load('contrast');
const midnight = await load('midnight');

/** The WCAG contrast of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x! + 0.05) / (y! + 0.05);
}

describe('High contrast look', () => {
  it('has every token Midnight has', () => {
    expect(look.id).toBe('contrast');
    expect(Object.keys(look.tokens).sort()).toEqual(Object.keys(midnight.tokens).sort());
  });

  it('keeps text at 4.5 to 1 or more', () => {
    const t = look.tokens;
    for (const [fg, bg] of [['ink', 'bg'], ['text-2', 'bg'], ['text-body', 'surface'], ['primary-ink', 'primary'], ['talk-ink', 'talk'], ['teal', 'teal-tint'], ['danger', 'surface']] as Array<[string, string]>) {
      expect(contrast(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    }
  });
});
```

Run it on its own, then the whole unit suite:

```sh
pnpm exec vitest run test/unit/v2/contrast-look.test.ts
pnpm -s test
```

[`test/unit/v2/copy-and-looks.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/copy-and-looks.test.ts) runs the same checks on the bundled looks, with more pairs of colours.

## A filter: cover a date stamp

Some cameras print the date in orange in a corner of every photo. A date can say where a person was and when. This filter finds that orange in the bottom right corner and covers it with a flat block, on the phone, before the photo is shared.

### Step 1: the filter's manifest

Make the folder `public/v2/modules/filter/date-stamp/` with this `manifest.json`:

```json
{
  "id": "org.example.filter.date-stamp",
  "kind": "filter",
  "version": "1.0.0",
  "name": {
    "en": "Cover a date stamp"
  },
  "permissions": [],
  "entry": "index.js",
  "publisher": null,
  "sig": null
}
```

### Step 2: the search

`analyse(photo)` gets the photo's pixels and returns the blocks to paint. The search is a plain function, `findStamp`, exported so a test can call it without a browser.

```js
// A filter for Share unseen: covers a date stamp, the orange date and time some cameras print in the
// bottom right corner of a photo. It reads only the photo's pixels, on the phone. Its blocks are of the
// kind 'writing', so the app counts them with the other writing it covered.

/** The part of the photo searched: the right half of its bottom quarter. */
const AREA = { left: 0.5, top: 0.75 };

/** True for the orange of a printed date stamp: strong red, some green, little blue. */
const stampColour = (r, g, b) => r >= 200 && g >= 70 && g <= 190 && b <= 90 && r - b >= 140;

/**
 * Where a date stamp is, as a box in the photo's pixels ({x, y, w, h}), or null. `pixels` is the photo's
 * ImageData: {width, height, data}, with four bytes (red, green, blue, alpha) per pixel.
 */
export function findStamp({ width, height, data }) {
  const x0 = Math.floor(width * AREA.left);
  const y0 = Math.floor(height * AREA.top);
  let n = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = y0; y < height; y++) {
    for (let x = x0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!stampColour(data[i], data[i + 1], data[i + 2])) continue;
      n++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const area = (width - x0) * (height - y0);
  // Too few orange pixels to be writing, or so many that they are part of the picture (a sunset).
  if (n < 30 || n > area * 0.25) return null;
  // Orange spread over most of the corner is part of the picture too.
  if ((right - left + 1) * (bottom - top + 1) > area * 0.5) return null;
  const pad = 6;
  const x = Math.max(0, left - pad);
  const y = Math.max(0, top - pad);
  return { x, y, w: Math.min(width, right + 1 + pad) - x, h: Math.min(height, bottom + 1 + pad) - y };
}

export function create() {
  return {
    id: 'date-stamp',
    what: 'writing',
    async analyse(photo) {
      const box = findStamp(photo.pixels);
      return { covers: box ? [{ kind: 'writing', ...box }] : [] };
    },
  };
}
```

`what: 'writing'` puts it among the writing checks: its step on the screen reads "Writing and numbers", and the list of changes counts its block with the writing covered. It needs no new words. [Filter modules](filter.md#analyse-photo) has the whole interface.

### Step 3: list the filter

Add it to `BUNDLED` after the other filters. Share unseen runs them in this order:

```js
  { kind: 'filter', folder: 'strip-details' },
  { kind: 'filter', folder: 'cover-faces' },
  { kind: 'filter', folder: 'cover-numbers' },
  { kind: 'filter', folder: 'date-stamp' },
```

[`test/unit/v2/photo.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/photo.test.ts) checks the list of bundled filters. Add `'date-stamp'` to the list it expects in "run in the order hidden details, faces, writing, and are handed only t". Then write the preload list again:

```sh
node scripts/v2-preload.ts
```

### Step 4: see the filter

Reload the app and open Add, then Photo. Pick a photo with an orange date in the corner. The screen shows each check as it runs, then the photo with a flat block over the date, in the colour of the photo around it, and "Writing and numbers" in the list of changes. Tap the cross on the block's corner to take it away; tap the photo to add one.

### Step 5: test the search

Add `test/unit/v2/date-stamp.test.ts`. It runs in Node, with pictures made of plain numbers, and runs the filter through the app's own chain, `runFilters` from `public/v2/core/filters.js`:

```ts
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// The date stamp filter (public/v2/modules/filter/date-stamp/): it finds orange marks in the bottom right
// corner, nothing in a plain picture, and runs in the app's own filter chain.
const V2 = resolve(import.meta.dirname, '../../../public/v2');
const imp = (p: string) => import(resolve(V2, p) as string) as Promise<any>;
const { create, findStamp } = await imp('modules/filter/date-stamp/index.js');
const { runFilters } = await imp('core/filters.js');

/** A 400 by 300 picture in one dark blue, as ImageData is shaped. */
function picture() {
  const width = 400;
  const height = 300;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([40, 60, 90, 255], i * 4);
  return { width, height, data };
}

/** Paints orange strokes where a camera prints the date. */
function stamp<T extends { width: number; data: Uint8ClampedArray }>(img: T): T {
  for (let y = 260; y < 280; y++) for (let x = 300; x < 380; x++) if (x % 8 < 4) img.data.set([255, 140, 30, 255], (y * img.width + x) * 4);
  return img;
}

describe('date stamp filter', () => {
  it('finds nothing in a plain picture', () => {
    expect(findStamp(picture())).toBeNull();
  });

  it('finds the stamp, with a margin of 6 pixels', () => {
    expect(findStamp(stamp(picture()))).toEqual({ x: 298, y: 254, w: 88, h: 32 });
  });

  it('runs in the filter chain as a check for writing', async () => {
    const img = stamp(picture());
    const { steps, covers } = await runFilters([create()], { width: img.width, height: img.height, pixels: img });
    expect(steps[0]).toMatchObject({ id: 'date-stamp', what: 'writing', ok: true, count: 1 });
    expect(covers[0]).toMatchObject({ kind: 'writing', x: 298, y: 254, w: 88, h: 32, by: 'date-stamp' });
  });
});
```

### Step 6: test the filter in the app

UI tests open the app in Chrome on a phone-sized screen, against a gateway the test starts on its own. Add `test/ui/date-stamp.ui.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Browser, chromium } from 'playwright-core';
import { type Gateway, startGateway } from '../e2e/helpers.ts';
import { pastFirstRun } from './firstrun-seen.ts';

// Share unseen with the date stamp filter, in Chrome on a phone-sized screen, against a local gateway.
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

describe('Share unseen', () => {
  it('covers an orange date stamp', async () => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await pastFirstRun(ctx);
    const page = await ctx.newPage();
    await page.goto(`${g.url}/v2/#/photo`);
    await page.waitForSelector('#photoFile', { state: 'attached' });
    // A photo made in the page: a plain sky with one orange mark where cameras print the date. The writing
    // filter does not take one mark for writing, so the block over it comes from the date stamp filter.
    const jpeg = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 1200;
      c.height = 900;
      const g = c.getContext('2d')!;
      g.fillStyle = '#5A7FA8';
      g.fillRect(0, 0, 1200, 900);
      g.fillStyle = '#FF8C1A';
      g.fillRect(900, 820, 200, 40);
      return c.toDataURL('image/jpeg', 0.92).split(',')[1]!;
    });
    await page.setInputFiles('#photoFile', { name: 'stamp.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(jpeg, 'base64') });
    await page.waitForSelector('#photoChanges');
    const boxes = await page.locator('#coverLayer .cover-box[data-kind=writing]').evaluateAll((n) => n.map((x) => x.getAttribute('data-box')!.split(',').map(Number)));
    expect(boxes).toHaveLength(1);
    const [x, y, w, h] = boxes[0] as [number, number, number, number];
    // The block holds the whole mark.
    expect(x).toBeLessThanOrEqual(900);
    expect(y).toBeLessThanOrEqual(820);
    expect(x + w).toBeGreaterThanOrEqual(1100);
    expect(y + h).toBeGreaterThanOrEqual(860);
    await ctx.close();
  });
});
```

Run it with Chrome installed:

```sh
pnpm exec vitest run test/ui/date-stamp.ui.test.ts
```

Before you send a change to how the app looks, run the UI tests the way the repository's CI does, in Linux: `pnpm test:ui:linux test/ui/date-stamp.ui.test.ts` (it needs Docker with host networking on, and the local mints).

## The app's rules

The app is made for people who may read poorly and who cannot afford to be linked to a question. A module follows the same rules as the app's own screens; reviewers check them.

- **Icons first, few words.** Every button has an icon and one word or a short label. No more than eight words in a row on screen: anything longer goes behind a round info button, where Listen reads it too. `ui.say` and `ui.msgLine` write a message headline first and put the rest behind that button for you. [`test/ui/literacy.ui.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/ui/literacy.ui.test.ts) checks the app's screens this way.
- **Big targets.** Everything a person taps is at least 48 by 48 pixels. The app's `.btn` and `.round` classes are.
- **All words in the string table.** Every word comes from `public/v2/strings/en.js` through `t(key)`, so the app can be translated. Use named slots such as `{amount}`; never build a sentence from pieces.
- **Copy.** Spell it eCash. No long dashes. Short plain sentences. Never say something is private, hidden or deleted unless the code makes it so. [`test/unit/v2/copy-and-looks.test.ts`](https://github.com/ForgeReserve/forge-ai/blob/main/test/unit/v2/copy-and-looks.test.ts) checks the string table.
- **No network of your own.** Reach the engine only through the inputs the app hands your kind. Load your own files (a model, a font) from the app's own address, as Cover faces does. Nothing goes to another site: no fonts, scripts or analytics from elsewhere.
- **Never lose money.** A fund module stores eCash on the phone before it sends it, and shows the price before anything is paid. [Fund modules](fund.md#errors) explains how.
- **Every look, every phone.** Check your screens in Midnight, Light and Dark, at 360 pixels wide, and with reduced motion.
- **New libraries.** Vendor a file with its licence in `public/vendor/licenses/`, or add a package under the repository's pnpm rule: a version at least three days old.

## Check everything

Run these before you send the pull request. All must pass.

```sh
pnpm -s typecheck
pnpm -s test
node scripts/v2-preload.ts
pnpm test:ui:linux
```

## Send it as a pull request

1. Make a branch in your fork: `git switch -c look-contrast`.
2. Commit the module's folder, its line in `BUNDLED`, its words, the preload list in `public/v2/index.html` and its tests. One module a pull request.
3. Push the branch to your fork and open a pull request against `main` of [ForgeReserve/forge-ai](https://github.com/ForgeReserve/forge-ai).
4. In the description say what the module does, on which phones and browsers you tried it, and what you could not try. Add screenshots of its screens in Midnight and in Light.

A module joins the app as part of the bundled set, reviewed like any other code. Until signed modules and their sandbox are built, there is no other way in: see [What is built and what is designed](README.md#what-is-built-and-what-is-designed).
