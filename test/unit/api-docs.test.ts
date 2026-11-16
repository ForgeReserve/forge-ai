// The public API guide (docs/API.md, served as /docs/) must not rot: the page is the Markdown as built
// by scripts/build-docs.ts, every endpoint it documents is a route of the gateway, and every public /v1
// route is documented. Plus the copy rules the owner enforces on public text.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { API_MD, DOCS_HTML, documentedRoutes, renderApiDocs } from '../../scripts/build-docs.ts';
import { testCatalog } from '../e2e/helpers.ts';

setLogSilent(true);
const md = readFileSync(API_MD, 'utf8');

/** The gateway's own GET and POST routes, as `METHOD /path` with every parameter written {}. */
function appRoutes(): Set<string> {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '', TEST_TINFOIL_KEY: 'k' };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog(1, { audio: true }));
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp(deps);
  deps.db.close();
  return new Set(app.routes.filter((r) => r.method === 'GET' || r.method === 'POST').map((r) => `${r.method} ${r.path.replace(/:[A-Za-z_]+/g, '{}')}`));
}

const documented = documentedRoutes(md).map((r) => `${r.method} ${r.path.replace(/\{[^}]+\}/g, '{}')}`);

describe('API guide', () => {
  it('the page in public/docs is docs/API.md as scripts/build-docs.ts builds it (run node scripts/build-docs.ts)', () => {
    expect(readFileSync(DOCS_HTML, 'utf8') === renderApiDocs(md), 'public/docs/index.html is out of date').toBe(true);
  });

  it('documents a sensible number of endpoints, each once', () => {
    expect(documented.length).toBeGreaterThan(20);
    expect(new Set(documented).size).toBe(documented.length);
  });

  it('every documented endpoint is a route of the gateway', () => {
    const routes = appRoutes();
    const missing = documented.filter((r) => !routes.has(r));
    expect(missing, 'documented but not a route').toEqual([]);
  });

  it('every public /v1 route is documented', () => {
    const doc = new Set(documented);
    const undocumented = [...appRoutes()].filter((r) => / \/v1(\/|$)/.test(r) && !doc.has(r));
    expect(undocumented, 'a /v1 route with no ### `METHOD /path` heading in docs/API.md').toEqual([]);
  });

  it('documents no operator route', () => {
    expect(documented.filter((r) => / \/admin/.test(r))).toEqual([]);
    expect(md).not.toMatch(/\/admin/);
  });

  it('follows the copy rules: eCash spelled so, no em or en dashes, no "crypto"', () => {
    const prose = md.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '').replace(/\]\([^)]*\)/g, ']');
    expect(prose).not.toMatch(/[\u2014\u2013]/);
    expect(prose).not.toMatch(/crypto/i);
    expect(prose.match(/\becash\b/gi)?.filter((w) => w !== 'eCash') ?? []).toEqual([]);
    // Placeholders only: no real balance key, invite or event pass.
    const PLACEHOLDERS = ['sk-forge-YOUR_BALANCE_KEY', 'inv-YOUR_INVITE_CODE'];
    const codes = md.match(/\b(sk-forge-|inv-|pass-)[A-Za-z0-9_-]{16,}/g) ?? [];
    expect(codes.filter((c) => !PLACEHOLDERS.includes(c))).toEqual([]);
  });
});
