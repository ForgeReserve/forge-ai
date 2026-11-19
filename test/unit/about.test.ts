// The landing page (public/about/), the site's front page at /: under its own strict policy (the page and
// its files under /about/, nothing else), with nothing from another site, pictures sized as their files
// are, the words in the house style, and a title whose last words turn. The Classic chat page it took
// the place of is at /classic/, and what was meant for it at / goes on there (forward.js).
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ABOUT_CSP, createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { shellFiles } from '../../src/sw.ts';
import { testCatalog } from '../e2e/helpers.ts';

const { classicAddress }: { classicAddress: (hash: string, standalone: boolean) => string | null } = await import('../../public/about/forward.js' as string);

setLogSilent(true);
const PUBLIC = resolve(import.meta.dirname, '..', '..', 'public');
const ABOUT = join(PUBLIC, 'about');
const html = readFileSync(join(ABOUT, 'index.html'), 'utf8');
const classic = readFileSync(join(PUBLIC, 'classic', 'index.html'), 'utf8');
/** The sentence the title says, as it read before it turned. */
const SENTENCE = 'Private AI for activists and anyone who cannot risk being linked to a question.';

function gateway() {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '' };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog());
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: PUBLIC });
  return (path: string) => app.request(`http://gw.test${path}`);
}

/** Width and height of a WebP file (lossy VP8, lossless VP8L or extended VP8X). */
function webpSize(b: Buffer): { width: number; height: number } {
  expect(b.toString('ascii', 0, 4)).toBe('RIFF');
  expect(b.toString('ascii', 8, 12)).toBe('WEBP');
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
  }
  expect(chunk).toBe('VP8 ');
  return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
}

describe('GET /', () => {
  const get = gateway();

  it('serves the landing page at / with its policy', async () => {
    for (const path of ['/', '/index.html']) {
      const page = await get(path);
      expect(page.status, path).toBe(200);
      expect(page.headers.get('content-type')).toMatch(/^text\/html/);
      expect(page.headers.get('content-security-policy'), path).toBe(ABOUT_CSP);
      expect(page.headers.get('cache-control')).toBe('no-cache');
      expect(page.headers.get('x-content-type-options')).toBe('nosniff');
      expect(page.headers.get('referrer-policy')).toBe('no-referrer');
      // Not cross-origin isolated: that is for the v2 app only.
      expect(page.headers.get('cross-origin-embedder-policy')).toBeNull();
      expect(await page.text()).toBe(html);
    }
    expect(ABOUT_CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  });

  it('moves its old address, /about/, to /', async () => {
    for (const path of ['/about', '/about/', '/about/index.html']) {
      const r = await get(path);
      expect(r.status, path).toBe(301);
      expect(r.headers.get('location'), path).toBe('/');
    }
  });

  it('serves every file the page loads, from this origin, its own under the same policy', async () => {
    const loads = [...html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]!).filter((p) => !/\/$/.test(p));
    loads.push('/about/forward.js', '/v2/core/pagelook.js', '/v2/modules/look/midnight/index.js', '/v2/vendor/inter/InterVariable.woff2');
    for (const p of new Set(loads)) expect((await get(p)).status, p).toBe(200);
    for (const p of ['/about/about.css', '/about/about.js', '/about/forward.js', '/about/shots/home.webp']) expect((await get(p)).headers.get('content-security-policy'), p).toBe(ABOUT_CSP);
  });

  it('keeps its policy to the landing page: the apps and their files have none of it', async () => {
    for (const p of ['/classic/', '/app.js', '/style.css', '/sw.js', '/manifest.webmanifest', '/offline.html', '/v2/', '/docs/', '/v1/models']) expect((await get(p)).headers.get('content-security-policy'), p).toBeNull();
  });
});

describe('GET /classic/', () => {
  const get = gateway();

  it('serves the Classic chat page there, and moves /classic to it', async () => {
    const r = await get('/classic');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/classic/');
    const page = await get('/classic/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(await page.text()).toBe(classic);
    expect(classic).toContain('<link rel="manifest" href="/manifest.webmanifest">');
  });

  it('loads everything from the root, so its files resolve from /classic/ as they did from /', async () => {
    const refs = [...classic.matchAll(/<(?:script|link|img)\b[^>]*?(?:src|href)="([^"]*)"/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThan(5);
    for (const r of refs) expect(r, r).toMatch(/^\//);
    for (const r of new Set(refs)) expect((await get(r)).status, r).toBe(200);
    // Its own brand link opens it again, and its links into the site are absolute.
    expect(classic).toContain('<a class="brand" href="/classic/" aria-label="Forge AI home">');
    for (const [, href] of classic.matchAll(/<a\b[^>]*\shref="([^"#][^"]*)"/g)) expect(href, href).toMatch(/^(\/|https:)/);
  });
});

describe('what was meant for the Classic page at / (forward.js)', () => {
  it('sends a chat link and the shortcuts on to /classic/, with their hash', () => {
    expect(classicAddress('#/c/c_abc123', false)).toBe('/classic/#/c/c_abc123');
    expect(classicAddress('#new', false)).toBe('/classic/#new');
    expect(classicAddress('#fund', false)).toBe('/classic/#fund');
    expect(classicAddress('#/c/c_abc123', true)).toBe('/classic/#/c/c_abc123');
  });

  it('sends the Classic app put on a home screen to /classic/', () => {
    expect(classicAddress('', true)).toBe('/classic/');
    expect(classicAddress('#moments', true)).toBe('/classic/');
  });

  it('leaves everyone else on the landing page', () => {
    for (const hash of ['', '#', '#moments', '#main', '#/c/', '#/c', '#newer', '#/funds', '#/more/look']) expect(classicAddress(hash, false), hash).toBeNull();
  });

  it('runs first in the page script', () => {
    const js = readFileSync(join(ABOUT, 'about.js'), 'utf8');
    const code = js.replace(/^\/\/.*\n/gm, '');
    expect(code.trimStart()).toMatch(/^import \{ classicAddress \} from '\/about\/forward\.js';\nimport [^\n]+\n\nconst classic = classicAddress\(location\.hash, matchMedia\('\(display-mode: standalone\)'\)\.matches \|\| navigator\.standalone === true\);\nif \(classic\) location\.replace\(classic\);/);
  });
});

describe('the page source', () => {
  it('loads nothing from another site and has no inline code or styles the policy would block', () => {
    // Every script, stylesheet, picture and font is a path on this site.
    for (const m of html.matchAll(/<(script|img|link)\b[^>]*>/g)) {
      const tag = m[0];
      if (/rel="canonical"/.test(tag)) continue;
      const url = /(?:src|href)="([^"]*)"/.exec(tag)?.[1];
      if (url !== undefined) expect(url, tag).toMatch(/^\//);
    }
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/);
    // Links out go only to the code and to Bellows; the meta tags name this site.
    const away = [...html.matchAll(/https?:\/\/[^"\s<]+/g)].map((m) => m[0]);
    for (const u of away) expect(u).toMatch(/^https:\/\/(github\.com\/ForgeReserve\/forge-ai|bellows\.forgereserve\.org|ai\.forge-reserve\.com\/)/);
    for (const f of ['about.css', 'about.js']) expect(readFileSync(join(ABOUT, f), 'utf8'), f).not.toMatch(/https?:\/\//);
  });

  it('gives every picture its alt text and the size of its file', () => {
    const imgs = [...html.matchAll(/<img\b[^>]*>/g)].map((m) => m[0]);
    expect(imgs.length).toBeGreaterThanOrEqual(3);
    for (const tag of imgs) {
      const src = /src="\/about\/([^"]+)"/.exec(tag)?.[1];
      expect(src, tag).toMatch(/^shots\/[a-z-]+\.webp$/);
      expect(/alt="([^"]{20,})"/.test(tag), tag).toBe(true);
      const file = readFileSync(join(ABOUT, src!));
      expect(file.length, src).toBeLessThan(150 * 1024);
      const { width, height } = webpSize(file);
      expect(tag).toContain(`width="${width}"`);
      expect(tag).toContain(`height="${height}"`);
    }
    // Every shot on disk is on the page.
    for (const f of readdirSync(join(ABOUT, 'shots'))) expect(html).toContain(`/about/shots/${f}`);
  });

  it('has a title, a description and social cards', () => {
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    for (const name of ['name="description"', 'property="og:title"', 'property="og:description"', 'property="og:image"', 'name="twitter:card"']) expect(html).toContain(name);
    expect(/property="og:image" content="https:\/\/ai\.forge-reserve\.com(\/[^"]+)"/.exec(html)?.[1]).toBe('/icons/icon-512.png');
  });

  it('keeps the download links in one place, empty until the apps are public', () => {
    const dls = [...html.matchAll(/<a class="dl"[^>]*>/g)].map((m) => m[0]);
    expect(dls).toHaveLength(2);
    for (const tag of dls) {
      expect(tag).toMatch(/data-download="(android|iphone)"/);
      expect(tag).toContain('data-href=""');
      expect(tag).not.toMatch(/\shref=/);
    }
  });

  it('has four moments, each a tab with its words and its screens in the phone', () => {
    const tabs = [...html.matchAll(/<button class="tab"[^>]*>/g)].map((m) => m[0]);
    expect(tabs.map((t) => /data-moment="([a-z]+)"/.exec(t)?.[1])).toEqual(['talk', 'private', 'pay', 'share']);
    for (const t of tabs) {
      const moment = /data-moment="([a-z]+)"/.exec(t)![1];
      expect(t).toContain('role="tab"');
      expect(t).toContain(`aria-controls="cap-${moment}"`);
      expect(html).toContain(`id="cap-${moment}" role="tabpanel" aria-labelledby="tab-${moment}"`);
      expect(html, moment).toMatch(new RegExp(`<img class="frame" data-frame="${moment}(-a)?"`));
    }
    // Pause, and the way to Bellows in the words for paying.
    expect(html).toMatch(/<button class="play" type="button" id="play" aria-label="Pause"/);
    expect(/<div class="cap" id="cap-pay"[^]*?<\/div>/.exec(html)?.[0]).toContain('href="https://bellows.forgereserve.org"');
    // The page and its style keep no inline style, and the moving parts move by transform and opacity.
    const css = readFileSync(join(ABOUT, 'about.css'), 'utf8');
    for (const [, body] of css.matchAll(/@keyframes [a-z0-9-]+ \{([^]*?)\n?\}\n/g)) expect(body).not.toMatch(/\b(top|left|right|bottom|width|height|margin|padding)\s*:/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('follows the house style: eCash, no long dashes, no "crypto"', () => {
    const words = html.replace(/<[^>]+>/g, ' ');
    expect(words).not.toMatch(/[\u2014\u2013]/);
    expect(words).not.toMatch(/crypto/i);
    // Bellows is never said to run in sealed hardware; cards are for the Android app.
    expect(words).not.toMatch(/enclave/i);
    expect(words).toMatch(/Card\s*<small>Android app<\/small>|Card\s+Android app/);
    for (const m of words.matchAll(/\becash\b/gi)) expect(m[0]).toBe('eCash');
  });

  it('is left alone by the Classic page worker: none of it is in the app shell', () => {
    const shell = shellFiles(PUBLIC);
    expect(shell.filter((p) => p.startsWith('/about'))).toEqual([]);
    expect(shell).not.toContain('/');
    expect(shell).not.toContain('/index.html');
  });

  it('names the site root as its address, and its brand goes there', () => {
    expect(html).toContain('<link rel="canonical" href="https://ai.forge-reserve.com/">');
    expect(html).toContain('<meta property="og:url" content="https://ai.forge-reserve.com/">');
    expect(html).toContain('<a class="brand" href="/" aria-label="Forge AI">');
    expect(html).not.toMatch(/href="\/about\/?"/);
    // It is not an app to install: no manifest.
    expect(html).not.toContain('rel="manifest"');
    // One quiet way to the Classic page, in the download panel.
    expect(/<div class="dl-pop"[^]*?<\/div>\n<\/header>/.exec(html)?.[0]).toContain('<a class="dl-classic" id="dlClassic" href="/classic/">Classic app</a>');
  });

  it('has a title that says one sentence and turns its last words, in the order of the list', () => {
    const h1 = /<h1 id="title">([^]*?)<\/h1>/.exec(html)![1]!;
    const text = (s: string) => s.replace(/<!--[^]*?-->/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    // What a screen reader reads, and what shows under reduced motion: the whole sentence, as before.
    const still = /<span class="t-still">([^]*?<\/span>)<\/span>/.exec(h1)![1]!;
    expect(text(still)).toBe(SENTENCE);
    expect(still).toContain('<span class="t-a">Private AI for activists</span>');
    // The part that turns is hidden from screen readers and holds no live region.
    const turn = /<span class="t-turn" aria-hidden="true">([^]*)<\/span>$/.exec(h1)![1]!;
    expect(turn).not.toMatch(/aria-live|role=/);
    expect(text(/<span class="t-for">([^<]*)<\/span>/.exec(turn)![1]!)).toBe('Private AI for');
    const whos = [...turn.matchAll(/<span class="(who[^"]*)">([^<]*)<\/span>/g)].map((m) => ({ cls: m[1]!, words: m[2]! }));
    expect(whos.map((w) => w.words)).toEqual(['activists', 'journalists', 'researchers', 'survivors', 'organizers', 'whistleblowers', 'lawyers', 'anyone who cannot risk being linked to a question']);
    // The first shows before the page moves; only the phrase is long; every word fits the width it is set for.
    expect(whos.map((w) => w.cls)).toEqual(['who on', 'who', 'who', 'who', 'who', 'who', 'who', 'who long']);
    for (const w of whos.filter((w) => w.cls !== 'who long')) expect(w.words, w.words).toMatch(/^[a-z]{1,14}$/);
    // The title, the description and the social cards stay as they were.
    expect(html).toContain('<title>Forge AI, private AI for activists</title>');
    expect(html).toContain(`<meta name="description" content="${SENTENCE.replace(/\.$/, '')}. Ask by voice. Pay for each question with eCash. No account.">`);
    expect(html).toContain('<meta property="og:title" content="Forge AI, private AI for activists">');
  });
});
