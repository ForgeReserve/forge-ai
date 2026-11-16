import { cpSync, mkdtempSync, mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { serviceWorkerScript, shellFiles } from '../../src/sw.ts';

const PUBLIC = resolve(import.meta.dirname, '..', '..', 'public');

describe('service worker script', () => {
  it('lists the app shell and nothing behind the API', () => {
    const shell = shellFiles(PUBLIC);
    expect(shell[0]).toBe('/');
    for (const p of ['/app.js', '/style.css', '/theme.js', '/icon.svg', '/manifest.webmanifest', '/offline.html', '/js/files.js', '/js/extract.js', '/js/wallet.js', '/icons/icon-192.png', '/icons/apple-touch-icon.png']) expect(shell).toContain(p);
    expect(shell).not.toContain('/sw.js');
    expect(shell).not.toContain('/index.html');
    expect(shell.some((p) => p.startsWith('/vendor/') || p.startsWith('/admin') || p.startsWith('/beta') || p.startsWith('/v1'))).toBe(false);
  });

  it('fills in the version and changes it when a shell file or a vendor file changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-sw-'));
    cpSync(join(PUBLIC, 'sw.js'), join(dir, 'sw.js'));
    writeFileSync(join(dir, 'index.html'), '<html>1</html>');
    writeFileSync(join(dir, 'app.js'), 'console.log(1)');
    mkdirSync(join(dir, 'js'));
    writeFileSync(join(dir, 'js', 'a.js'), 'export {}');
    mkdirSync(join(dir, 'vendor'));
    writeFileSync(join(dir, 'vendor', 'lib.js'), 'v1');
    const sw = serviceWorkerScript(dir);
    const a = sw();
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(a.body).not.toContain('__FORGE_');
    expect(a.body).toContain(`const VERSION = "${a.version}"`);
    expect(a.body).toContain('const SHELL = ["/","/app.js","/js/a.js"]');
    expect(sw()).toBe(a); // unchanged files: cached

    writeFileSync(join(dir, 'js', 'a.js'), 'export const x = 2');
    utimesSync(join(dir, 'js', 'a.js'), new Date(), new Date(Date.now() + 5000));
    const b = sw();
    expect(b.version).not.toBe(a.version);

    writeFileSync(join(dir, 'vendor', 'lib.js'), 'v2');
    utimesSync(join(dir, 'vendor', 'lib.js'), new Date(), new Date(Date.now() + 9000));
    const c = sw();
    expect(c.version).toBe(b.version); // the shell did not change
    expect(c.body).not.toBe(b.body); // but the vendor version did, so the script differs
  });
});

describe('the v2 worker script', () => {
  it('carries a build id that changes when an app file changes, and not for the voice files', async () => {
    const { v2WorkerScript } = await import('../../src/sw.ts');
    const dir = mkdtempSync(join(tmpdir(), 'forge-sw2-'));
    mkdirSync(join(dir, 'v2', 'core'), { recursive: true });
    mkdirSync(join(dir, 'v2', 'voice', 'phonon'), { recursive: true });
    cpSync(join(PUBLIC, 'v2', 'sw.js'), join(dir, 'v2', 'sw.js'));
    writeFileSync(join(dir, 'v2', 'app.js'), 'console.log(1)');
    writeFileSync(join(dir, 'v2', 'core', 'ui.js'), 'export {}');
    writeFileSync(join(dir, 'v2', 'voice', 'phonon', 'model.bin'), 'x');
    const sw = v2WorkerScript(dir);
    const a = sw();
    expect(a.version).toMatch(/^[0-9a-f]{16}$/);
    expect(a.body).toContain(`const VERSION = "${a.version}"`);
    expect(a.body).not.toContain('__FORGE_');
    writeFileSync(join(dir, 'v2', 'voice', 'phonon', 'model.bin'), 'changed');
    expect(sw().version).toBe(a.version);
    writeFileSync(join(dir, 'v2', 'core', 'ui.js'), 'export const changed = 1');
    utimesSync(join(dir, 'v2', 'core', 'ui.js'), new Date(), new Date(Date.now() + 5000));
    expect(sw().version).not.toBe(a.version);
  });
});
