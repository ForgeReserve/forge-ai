import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, startGateway } from './helpers.ts';

// The public API guide at /docs/ (public/docs/, built from docs/API.md), served by the real server.
describe('API guide at /docs', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());

  it('redirects /docs to /docs/ and serves the page as HTML', async () => {
    const r = await fetch(`${g.url}/docs`, { redirect: 'manual' });
    expect(r.status).toBe(301);
    expect(r.headers.get('location')).toBe('/docs/');
    const page = await fetch(`${g.url}/docs/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toMatch(/^text\/html/);
    expect(page.headers.get('cache-control')).toBe('no-cache');
    const html = await page.text();
    expect(html).toContain('<title>Forge AI API</title>');
    for (const id of ['quickstart', 'paying', 'errors', 'rate-limits', 'cors', 'modules', 'post-v1-chat-completions']) expect(html, id).toContain(`id="${id}"`);
    // Its script, style and font come from this origin only.
    expect(html).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
    expect(html).not.toMatch(/<script>/);
  });

  it('serves its script, style and the app font, and no policy blocks them', async () => {
    const page = await fetch(`${g.url}/docs/`);
    const csp = page.headers.get('content-security-policy');
    if (csp) expect(csp).toMatch(/script-src[^;]*'self'/);
    const js = await fetch(`${g.url}/docs/docs.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get('content-type')).toMatch(/javascript/);
    const css = await fetch(`${g.url}/docs/docs.css`);
    expect(css.status).toBe(200);
    expect(css.headers.get('content-type')).toMatch(/css/);
    const font = /url\("([^"]+\.woff2)"\)/.exec(await css.text())?.[1];
    expect(font).toBe('/v2/vendor/inter/InterVariable.woff2');
    expect((await fetch(g.url + font)).status).toBe(200);
  });

  it('is linked from the v1 page at the root', async () => {
    const v1 = await (await fetch(`${g.url}/`)).text();
    expect(v1).toContain('href="/docs/"');
  });
});
