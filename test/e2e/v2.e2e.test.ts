import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, startGateway } from './helpers.ts';

// The v2 app served beside v1: its shell, its own worker scope and manifest, and its bundled modules.
const BUNDLED = ['look/light', 'look/dark', 'look/midnight', 'mode/default', 'fund/ecash', 'fund/lightning', 'fund/onchain'];

describe('v2 shell', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());

  it('redirects /v2 to /v2/ and serves the page', async () => {
    const r = await fetch(`${g.url}/v2`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/v2/');
    const page = await fetch(`${g.url}/v2/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const html = await page.text();
    expect(html).toContain('<link rel="manifest" href="/v2/manifest.webmanifest">');
    expect(html).toContain('<script type="module" src="/v2/app.js"></script>');
    // Nothing from another origin: no remote fonts, scripts or styles.
    expect(html).not.toMatch(/https?:\/\//);
  });

  it('serves its own worker and a manifest scoped to /v2/', async () => {
    const sw = await fetch(`${g.url}/v2/sw.js`);
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toMatch(/javascript/);
    const m = await (await fetch(`${g.url}/v2/manifest.webmanifest`)).json();
    expect(m).toMatchObject({ id: '/v2/', start_url: '/v2/', scope: '/v2/', display: 'standalone' });
    for (const i of m.icons) expect((await fetch(g.url + i.src)).status, i.src).toBe(200);
  });

  it('serves every bundled module and the v1 modules v2 imports', async () => {
    for (const m of BUNDLED) {
      const man = await fetch(`${g.url}/v2/modules/${m}/manifest.json`);
      expect(man.status, m).toBe(200);
      const j = await man.json();
      expect((await fetch(`${g.url}/v2/modules/${m}/${j.entry}`)).status, m).toBe(200);
    }
    for (const p of ['/js/ui.js', '/js/files.js', '/js/extract.js', '/js/markdown.js', '/js/qr.js', '/js/scan.js', '/js/lockkey.js', '/vendor/marked.js', '/vendor/purify.js']) expect((await fetch(g.url + p)).status, p).toBe(200);
  });

  it('leaves v1 at /classic/, with its worker passing /v2/ by', async () => {
    const v1 = await (await fetch(`${g.url}/classic/`)).text();
    expect(v1).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    const sw = await (await fetch(`${g.url}/sw.js`)).text();
    expect(sw).toContain('v2\\/|v2$');
    const shell = JSON.parse(/const SHELL = (\[.*\]);/.exec(sw)![1]!);
    expect(shell.some((p: string) => p.startsWith('/v2'))).toBe(false);
  });
});
