import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { END, preloadBlock, preloads, START } from '../../../scripts/lib/v2-preload.ts';

// First paint (first mobile feedback, 2026-11-14; owner, 2026-11-15): index.html asks for every module
// the app loads as it opens at once (modulepreload), instead of the browser finding them one import level
// at a time. The first screen's modules (the app's static imports and those of the looks and the mode)
// at the normal priority; the other bundled modules, loaded right after it, at low priority. The list is
// written by scripts/v2-preload.ts (no build step); this test keeps it exactly in step with the imports.
const PUBLIC = join(import.meta.dirname, '../../../public');

describe('first paint', () => {
  const html = readFileSync(join(PUBLIC, 'v2/index.html'), 'utf8');
  const listed = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)"/g)].map((m) => m[1]!);

  it('preloads exactly the modules the app opens with: the first screen first, the rest at low priority', async () => {
    const { first, later } = await preloads();
    const normal = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]!);
    const low = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)" fetchpriority="low">/g)].map((m) => m[1]!);
    expect(normal).toEqual(first);
    expect(low).toEqual(later);
    expect(new Set([...normal, ...low]).size).toBe(normal.length + low.length); // no duplicates
    // The first screen's modules include the app and the mode; every bundled fund and voice module is
    // in the low-priority part.
    expect(first).toContain('/v2/app.js');
    expect(first).toContain('/v2/modules/mode/default/index.js');
    expect(later).toContain('/v2/modules/fund/lightning/index.js');
    expect(later).toContain('/v2/modules/voice-out/phonon/index.js');
  });

  it('is what scripts/v2-preload.ts writes (run it after changing an import)', async () => {
    const block = html.slice(html.indexOf(START) + START.length, html.indexOf(END)).trim();
    expect(block).toBe((await preloadBlock()).trim());
  });

  it('does not wait for markdown (marked and DOMPurify) before the first screen', () => {
    expect(listed).not.toContain('/js/markdown.js');
    expect(listed).not.toContain('/vendor/marked.js');
  });

  it('paints the background and the rings from the page itself, before any file loads', () => {
    expect(html).toMatch(/<style>[\s\S]*--bg:[\s\S]*<\/style>/);
    expect(html).toMatch(/<div id="app"[^>]*>\s*<div class="boot"[\s\S]*<svg/);
    // The stylesheet does not hold up that first paint: it comes after the shell, in the body.
    expect(html.indexOf('rel="stylesheet"')).toBeGreaterThan(html.indexOf('class="boot"'));
  });
});
