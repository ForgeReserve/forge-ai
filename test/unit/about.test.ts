// The landing page at /about (public/about/): served like /docs/, under its own strict policy, with
// nothing from another site, pictures sized as their files are, and the words in the house style.
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

setLogSilent(true);
const PUBLIC = resolve(import.meta.dirname, '..', '..', 'public');
const ABOUT = join(PUBLIC, 'about');
const html = readFileSync(join(ABOUT, 'index.html'), 'utf8');

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

describe('GET /about', () => {
  const get = gateway();

  it('moves /about to /about/ and serves the page with its policy', async () => {
    const r = await get('/about');
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/about/');

    const page = await get('/about/');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('content-security-policy')).toBe(ABOUT_CSP);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    // Not cross-origin isolated: that is for the v2 app only.
    expect(page.headers.get('cross-origin-embedder-policy')).toBeNull();
    expect(await page.text()).toBe(html);
    expect(ABOUT_CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  });

  it('serves every file the page loads, from this origin', async () => {
    const loads = [...html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]!).filter((p) => !/\/$/.test(p));
    loads.push('/v2/core/pagelook.js', '/v2/modules/look/midnight/index.js', '/v2/vendor/inter/InterVariable.woff2');
    for (const p of new Set(loads)) expect((await get(p)).status, p).toBe(200);
    for (const p of ['/about/about.css', '/about/about.js', '/about/shots/home.webp']) expect((await get(p)).headers.get('content-security-policy'), p).toBe(ABOUT_CSP);
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
    expect(shellFiles(PUBLIC).filter((p) => p.startsWith('/about'))).toEqual([]);
  });
});
