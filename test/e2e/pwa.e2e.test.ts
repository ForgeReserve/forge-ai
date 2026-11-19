import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, startGateway } from './helpers.ts';

// The installable Classic app (at /classic/): manifest, icons, service worker and offline page, served by
// the gateway. The front page (/) is the landing page, which the worker never keeps.
describe('PWA files', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());

  it('serves /sw.js as JavaScript with no-cache and a filled-in version', async () => {
    const r = await fetch(`${g.url}/sw.js`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    const version = r.headers.get('x-forge-sw-version')!;
    expect(version).toMatch(/^[0-9a-f]{16}$/);
    const body = await r.text();
    expect(body).toContain(`const VERSION = "${version}"`);
    expect(body).not.toContain('__FORGE_');
    const shell = JSON.parse(/const SHELL = (\[.*\]);/.exec(body)![1]!);
    expect(shell[0]).toBe('/classic/');
    expect(shell).not.toContain('/');
    expect(shell).toContain('/offline.html');
    // Everything precached must exist.
    for (const p of shell) expect((await fetch(g.url + p)).status, p).toBe(200);
  });

  it('serves a valid manifest with the required fields, icons and shortcuts', async () => {
    const r = await fetch(`${g.url}/manifest.webmanifest`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toMatch(/manifest\+json/);
    expect(r.headers.get('cache-control')).toBe('no-cache');
    const m = JSON.parse(await r.text());
    // The same id as before the move, so an installed Classic app stays the same app; it opens at /classic/.
    expect(m).toMatchObject({ id: '/', name: 'Forge AI', short_name: 'Forge AI', start_url: '/classic/', scope: '/', display: 'standalone' });
    expect(m.theme_color).toMatch(/^#[0-9a-f]{6}$/i);
    expect(m.background_color).toMatch(/^#[0-9a-f]{6}$/i);
    const sizes = m.icons.map((i: any) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']));
    for (const i of m.icons) {
      const ir = await fetch(g.url + i.src);
      expect(ir.status, i.src).toBe(200);
      expect(ir.headers.get('content-type')).toMatch(new RegExp('^' + i.type.replace('+', '\\+')));
    }
    expect(m.shortcuts.map((s: any) => [s.name, s.url])).toEqual([
      ['New chat', '/classic/#new'],
      ['Add funds', '/classic/#fund'],
    ]);
    const touch = await fetch(`${g.url}/icons/apple-touch-icon.png`);
    expect(touch.status).toBe(200);
  });

  it('links the manifest and iOS meta from the page, and serves the offline page', async () => {
    const html = await (await fetch(`${g.url}/classic/`)).text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest">');
    expect(html).toContain('<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">');
    expect(html).toContain('name="apple-mobile-web-app-capable" content="yes"');
    expect(html).toContain('name="apple-mobile-web-app-status-bar-style" content="black-translucent"');
    expect(html).toContain('name="apple-mobile-web-app-title" content="Forge AI"');
    const off = await fetch(`${g.url}/offline.html`);
    expect(off.status).toBe(200);
    const offline = await off.text();
    expect(offline).toContain("You're offline. Your chats are saved on this device.");
    expect(offline).toContain('<a href="/classic/">Open Forge AI</a>');
    // The landing page at / is no app to install.
    expect(await (await fetch(`${g.url}/`)).text()).not.toContain('rel="manifest"');
  });

  it('serves the pdf.js worker and its licenses from our own origin', async () => {
    const w = await fetch(`${g.url}/vendor/pdfjs/pdf.worker.min.mjs`, { method: 'HEAD' });
    expect(w.status).toBe(200);
    expect(w.headers.get('content-type')).toMatch(/javascript/);
    const wasm = await fetch(`${g.url}/vendor/pdfjs/wasm/openjpeg.wasm`, { method: 'HEAD' });
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    for (const f of ['pdfjs-dist.txt', 'pdfjs-dist-assets.txt']) expect(existsSync(resolve(import.meta.dirname, '../../public/vendor/licenses', f))).toBe(true);
  });

  it('serves the first-run voice clips as audio/ogg, which Safari needs to play them', async () => {
    const r = await fetch(`${g.url}/v2/voice/en/welcome.ogg`, { method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/ogg');
  });
});
