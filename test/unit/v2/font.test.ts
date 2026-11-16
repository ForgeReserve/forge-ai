import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inBundle } from '../../../scripts/lib/android-web.ts';

// The app's font is served from our origin, so text is laid out alike on every phone and test browser
// (scripts/vendor-inter.sh). Without it the same screen fit 360 by 640 on a Mac and scrolled on Linux.
const ROOT = resolve(import.meta.dirname, '../../..');
const read = (f: string) => readFileSync(resolve(ROOT, f), 'utf8');
const FONT = 'v2/vendor/inter/InterVariable.woff2';

describe('the app font (Inter)', () => {
  const pin = JSON.parse(read('public/v2/vendor/inter/VERSION.json')) as { version: string; sha256: string; license: string };
  const script = read('scripts/vendor-inter.sh');

  it('is the pinned official file, with its licence', () => {
    const bytes = readFileSync(resolve(ROOT, 'public', FONT));
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(pin.sha256);
    expect(script).toContain(`VERSION=${pin.version}\n`);
    expect(script).toContain(`WOFF2_SHA256=${pin.sha256}\n`);
    expect(pin.license).toBe('OFL-1.1');
    expect(read('public/vendor/licenses/inter.txt')).toMatch(/SIL Open Font License, Version 1\.1/);
  });

  it('is the first family of the stylesheet, served from our origin and never blocking text', () => {
    const css = read('public/v2/style.css');
    const face = /@font-face\s*\{([^}]*)\}/.exec(css)?.[1] ?? '';
    expect(face).toMatch(/font-family: Inter;/);
    expect(face).toContain(`url("/${FONT}") format("woff2")`);
    expect(face).toMatch(/font-weight: 100 900;/);
    expect(face).toMatch(/font-display: swap;/);
    expect(css).toMatch(/--font: Inter, /);
    expect(css).not.toMatch(/https?:\/\/[^)"']*\.woff2?/);
  });

  it('is asked for with the page, kept offline by the v2 worker, and carried by the Android app', () => {
    expect(read('public/v2/index.html')).toContain(`<link rel="preload" href="/${FONT}" as="font" type="font/woff2" crossorigin>`);
    const shell = /const SHELL = (\[[^\]]*\]);/.exec(read('public/v2/sw.js'))![1]!;
    expect(JSON.parse(shell.replace(/'/g, '"'))).toContain(`/${FONT}`);
    expect(inBundle(FONT)).toBe(true);
    expect(inBundle('vendor/licenses/inter.txt')).toBe(true);
  });
});
