// The waitlist is gone (owner, 2026-11-21): its old addresses (/beta, /beta/ and anything under it) move
// to the front page so no old link breaks, its sign-up route is gone, and no page, script, guide or
// site links to it any more. A new balance opens with an invite code or an event pass.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { testCatalog } from '../e2e/helpers.ts';

setLogSilent(true);
const ROOT = resolve(import.meta.dirname, '..', '..');
const PUBLIC = join(ROOT, 'public');

function gateway() {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '' };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog());
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: PUBLIC });
  return (path: string, init?: RequestInit) => app.request(`http://gw.test${path}`, init);
}

/** Every file under dir with one of these endings, the vendored libraries and the voice files left out. */
function files(dir: string, ends: RegExp): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (!/^(vendor|voice|node_modules)$/.test(n)) out.push(...files(p, ends));
    } else if (ends.test(n)) out.push(p);
  }
  return out;
}

/** A link to the waitlist: an address that goes to /beta, here or on the hosted site. */
const LINK = /(href|src|action)=["'](https:\/\/ai\.forge-reserve\.com)?\/beta\b|fetch\(['"`]\/v1\/beta|\]\((https:\/\/ai\.forge-reserve\.com)?\/beta\b|https:\/\/ai\.forge-reserve\.com\/beta\b/;

describe('the old waitlist', () => {
  const get = gateway();

  it('moves /beta, /beta/ and anything under it to the front page', async () => {
    for (const p of ['/beta', '/beta/', '/beta/index.html', '/beta/x']) {
      const r = await get(p);
      expect(r.status, p).toBe(301);
      expect(r.headers.get('location'), p).toBe('/');
    }
    // The front page is there to land on.
    expect((await get('/')).status).toBe(200);
  });

  it('no longer takes sign-ups', async () => {
    const r = await get('/v1/beta/signup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ contact: 'ana@example.org' }) });
    expect(r.status).toBe(404);
  });

  it('is linked from no page, script or style the site serves', () => {
    const found = files(PUBLIC, /\.(html|js|css|webmanifest|json)$/).filter((f) => LINK.test(readFileSync(f, 'utf8')));
    expect(found.map((f) => relative(ROOT, f))).toEqual([]);
    // The admin page has no Waitlist section and the service workers keep no rule for it.
    for (const f of ['admin/index.html', 'admin/admin.js', 'sw.js', 'v2/sw.js']) expect(readFileSync(join(PUBLIC, f), 'utf8'), f).not.toMatch(/waitlist|\bbeta\|/i);
  });

  it('is linked from no guide, the README or the Forge website\'s worker', () => {
    const docs = [join(ROOT, 'README.md'), join(ROOT, 'deploy', 'forge-site', 'worker.js'), ...files(join(ROOT, 'docs'), /\.md$/)];
    const found = docs.filter((f) => LINK.test(readFileSync(f, 'utf8')));
    expect(found.map((f) => relative(ROOT, f))).toEqual([]);
    // The site worker asks no one to join a waitlist.
    expect(readFileSync(join(ROOT, 'deploy', 'forge-site', 'worker.js'), 'utf8')).not.toMatch(/waitlist/i);
  });
});
