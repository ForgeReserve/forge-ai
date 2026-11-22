// The privacy page (public/privacy/), at /privacy: the policy the app stores link to. Served under the
// landing page's strict policy, linked from the landing page's and the download page's footers, left
// alone by both service workers, in the house style, and with every section the stores ask about.
import { readFileSync } from 'node:fs';
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
const html = readFileSync(join(PUBLIC, 'privacy', 'index.html'), 'utf8');
const css = readFileSync(join(PUBLIC, 'privacy', 'privacy.css'), 'utf8');
const js = readFileSync(join(PUBLIC, 'privacy', 'privacy.js'), 'utf8');
/** The words a reader sees, tags taken out. */
const words = html
  .replace(/<!--[^]*?-->/g, ' ')
  .replace(/<(script|style)\b[^]*?<\/\1>/g, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/g, ' ')
  .replace(/\s+/g, ' ');

function gateway() {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '' };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog());
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: PUBLIC });
  return (path: string) => app.request(`http://gw.test${path}`);
}

/** The sections, in order: their id and their heading. */
const SECTIONS = [
  ['who', 'Who runs it'],
  ['phone', 'On your phone'],
  ['engine', 'What the engine keeps'],
  ['never', 'Never stored'],
  ['models', 'Private and Standard models'],
  ['voice', 'Voice'],
  ['photos', 'Photos'],
  ['pay', 'Payments'],
  ['ads', 'Ads and tracking'],
  ['children', 'Children'],
  ['delete', 'Questions and deletion'],
  ['changes', 'Changes'],
  ['review', 'Early build'],
] as const;

/** The text of one section. */
const section = (id: string) => {
  const m = new RegExp(`<section class="pv" id="${id}"[^]*?</section>`).exec(html);
  expect(m, id).not.toBeNull();
  return m![0].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
};

describe('GET /privacy', () => {
  const get = gateway();

  it('serves the page at /privacy under the landing page\'s policy', async () => {
    const r = await get('/privacy');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/html/);
    expect(r.headers.get('content-security-policy')).toBe(ABOUT_CSP);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    expect(await r.text()).toBe(html);
  });

  it('has one address: /privacy/ and /privacy/index.html move to /privacy', async () => {
    for (const p of ['/privacy/', '/privacy/index.html']) {
      const r = await get(p);
      expect(r.status, p).toBe(301);
      expect(r.headers.get('location'), p).toBe('/privacy');
    }
    expect(html).toContain('<link rel="canonical" href="https://ai.forge-reserve.com/privacy">');
  });

  it('serves every file it loads, from this origin, its own under the same policy', async () => {
    const loads = [...html.matchAll(/<(?:link|script|img)\b[^>]*(?:src|href)="(\/[^"#]*)"/g)].map((m) => m[1]!);
    expect(loads).toEqual(expect.arrayContaining(['/about/site.css', '/privacy/privacy.css', '/privacy/privacy.js']));
    for (const p of [...loads, '/v2/core/pagelook.js', '/v2/modules/look/midnight/index.js']) expect((await get(p)).status, p).toBe(200);
    for (const p of ['/privacy/privacy.css', '/privacy/privacy.js']) expect((await get(p)).headers.get('content-security-policy'), p).toBe(ABOUT_CSP);
  });

  it('is linked from the landing page\'s footer and the download page\'s footer', async () => {
    for (const page of ['/', '/download']) {
      const text = await (await get(page)).text();
      const foot = /<footer class="foot">[^]*?<\/footer>/.exec(text)?.[0] ?? '';
      expect(foot, page).toContain('href="/privacy"');
    }
    // And the download page from the landing page's and from this one's.
    expect(/<footer class="foot">[^]*?<\/footer>/.exec(await (await get('/')).text())?.[0]).toContain('href="/download"');
    expect(/<footer class="foot">[^]*?<\/footer>/.exec(html)?.[0]).toContain('href="/download"');
  });

  it('is left alone by both service workers: never in the Classic shell, outside the v2 scope', () => {
    const shell = shellFiles(PUBLIC);
    expect(shell.filter((p) => p.startsWith('/privacy'))).toEqual([]);
    expect(shell.filter((p) => p.startsWith('/about') || p.startsWith('/download'))).toEqual([]);
    // The Classic worker answers only its shell and /vendor/ from a cache; a page navigation goes to the network.
    const sw = readFileSync(join(PUBLIC, 'sw.js'), 'utf8');
    expect(sw).toContain('else event.respondWith(fetch(req).catch(() => offline()));');
    expect(sw).toMatch(/\/privacy/);
  });
});

describe('the policy', () => {
  it('has every section, in order, each a heading with an icon', () => {
    const ids = [...html.matchAll(/<section class="pv" id="([a-z]+)" aria-labelledby="h-\1">/g)].map((m) => m[1]);
    expect(ids).toEqual(SECTIONS.map(([id]) => id));
    for (const [id, head] of SECTIONS) {
      expect(html, id).toMatch(new RegExp(`<h2 id="h-${id}"><span class="pv-ico [a-z-]+" aria-hidden="true"><svg class="ico"[^]*?</svg></span>${head}</h2>`));
      // The list of sections on a wide screen names each one.
      expect(html).toContain(`<li><a href="#${id}">${head}</a></li>`);
    }
  });

  it('says who runs it and how to reach them, and invents no company or address', () => {
    expect(section('who')).toMatch(/Forge AI runs this service/);
    expect(html.split('mailto:security@forge-reserve.com').length - 1).toBeGreaterThanOrEqual(2);
    expect(words).not.toMatch(/\b(Inc|LLC|Ltd|GmbH|Corp)\b/);
  });

  it('says what stays on the phone, and how Erase everything removes it', () => {
    const t = section('phone');
    for (const w of ['balance key', 'history', 'settings', 'Erase everything', 'Burn', 'Auto-delete', 'backups off']) expect(t, w).toContain(w);
  });

  it('says what the engine keeps per balance, and what it never has', () => {
    const t = section('engine');
    for (const w of ['SHA-256', 'top-up, charge and payout', 'the model', 'tokens', 'the cost', 'the time', 'no name, email, phone number or device id', 'random key', 'waitlist']) expect(t, w).toContain(w);
    const never = section('never');
    for (const w of ['questions, answers, photos, files and recordings', 'in memory', 'never written', 'network address', 'Tor or a VPN']) expect(never, w).toContain(w);
  });

  it('tells private models from standard ones, and covers voice, photos and payments', () => {
    const m = section('models');
    expect(m).toMatch(/Private models run in sealed hardware/);
    expect(m).toMatch(/may keep what it was sent/);
    const v = section('voice');
    for (const w of ['On this phone', 'Forge Private Voice', 'Engine', 'This browser', 'Reading answers aloud']) expect(v, w).toContain(w);
    expect(section('photos')).toMatch(/Share unseen runs on your phone/);
    const p = section('pay');
    for (const w of ['eCash', 'Lightning', 'On-chain', 'Cards']) expect(p, w).toContain(w);
  });

  it('says no ads, no tracking, no analytics and no sale of data; not for children under 13; how to delete', () => {
    const a = section('ads');
    for (const w of ['No ads', 'No tracking', 'No analytics', 'do not sell']) expect(a, w).toContain(w);
    expect(section('children')).toContain('not directed at children under 13');
    const d = section('delete');
    for (const w of ['Erase everything', 'cannot look a person up', 'security@forge-reserve.com']) expect(d, w).toContain(w);
  });

  it('carries its date, and says it is an early build not yet reviewed', () => {
    expect(html.split('<time datetime="2026-11-21">21 November 2026</time>').length - 1).toBe(2);
    expect(words).toMatch(/Last updated 21 November 2026/);
    expect(section('review')).toMatch(/not been independently reviewed/);
    expect(words).toMatch(/early build/);
  });

  it('follows the house style: no long dashes, eCash, no "crypto", no claim the code does not back', () => {
    for (const [name, text] of [['index.html', html], ['privacy.css', css], ['privacy.js', js]] as const) {
      expect(text, name).not.toMatch(/[\u2014\u2013]/);
      expect(text, name).not.toMatch(/crypto/i);
    }
    for (const m of words.matchAll(/\becash\b/gi)) expect(m[0]).toBe('eCash');
    expect(words).not.toMatch(/\b(anonymous|untraceable|deleted forever|nobody can see|no one can see|military.grade)\b/i);
    // Links out go only to the code; the rest is this site and the contact address.
    for (const u of [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]!)) expect(u).toMatch(/^https:\/\/(github\.com\/ForgeReserve\/forge-ai|ai\.forge-reserve\.com\/privacy)$/);
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/<style\b|\sstyle="|\son[a-z]+="/);
  });
});
