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

  it('serves the module guide as HTML at /docs/modules/ and one address per page', async () => {
    const pages: Array<[string, string, string[]]> = [
      ['/docs/modules/', '<title>Modules | Forge AI</title>', ['the-six-kinds', 'what-is-built-and-what-is-designed']],
      ['/docs/modules/fund', '<title>Fund modules | Forge AI</title>', ['inputs', 'wallet', 'available-methods', 'a-minimal-fund-module']],
      ['/docs/modules/voice-in', '<title>Voice-in modules | Forge AI</title>', ['inputs', 'how-the-app-picks-one']],
      ['/docs/modules/voice-out', '<title>Voice-out modules | Forge AI</title>', ['inputs', 'how-the-app-picks-one']],
      ['/docs/modules/filter', '<title>Filter modules | Forge AI</title>', ['the-photo', 'analyse-photo']],
      ['/docs/modules/look', '<title>Look modules | Forge AI</title>', ['tokens']],
      ['/docs/modules/mode', '<title>Mode modules | Forge AI</title>', ['actions', 'the-screen']],
      ['/docs/modules/list', '<title>Module list | Forge AI</title>', ['at-a-glance', 'scan-a-note', 'natural-voice']],
      ['/docs/modules/first-module', '<title>Write your first module | Forge AI</title>', ['run-the-app-on-your-computer', 'send-it-as-a-pull-request']],
      ['/docs/modules/engine', '<title>Engine modules | Forge AI</title>', ['suppliers', 'funding-methods']],
    ];
    for (const [path, title, ids] of pages) {
      const r = await fetch(`${g.url}${path}`);
      expect(r.status, path).toBe(200);
      expect(r.headers.get('content-type'), path).toMatch(/^text\/html/);
      expect(r.headers.get('cache-control'), path).toBe('no-cache');
      const html = await r.text();
      expect(html, path).toContain(title);
      for (const id of ids) expect(html, `${path} #${id}`).toContain(`id="${id}"`);
      // The same script and style as the API guide, from this origin only, and no script in the page.
      expect(html, path).toContain('<script src="/docs/docs.js" defer></script>');
      expect(html, path).toContain('<link rel="stylesheet" href="/docs/docs.css">');
      expect(html, path).not.toMatch(/<(script|link)[^>]+(src|href)="https?:/);
      expect(html, path).not.toMatch(/<script>/);
      // Every page lists every other page.
      for (const [other] of pages) expect(html, `${path} links ${other}`).toContain(`href="${other}"`);
    }
    // The API guide links the module guide, in its Modules section and in its list of pages.
    const api = await (await fetch(`${g.url}/docs/`)).text();
    expect(api).toContain('href="/docs/modules/"');
    expect(api).toContain('href="/docs/modules/first-module"');
  });

  it('is linked from the v1 page at the root', async () => {
    const v1 = await (await fetch(`${g.url}/`)).text();
    expect(v1).toContain('href="/docs/"');
  });
});
