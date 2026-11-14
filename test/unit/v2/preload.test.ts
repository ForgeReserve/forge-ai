import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// First paint (first mobile feedback, 2026-11-14): index.html asks for every module the first screen
// needs at once (modulepreload), instead of the browser finding them one import level at a time. These
// are the app's static imports and those of the modules drawn first (the looks and the mode). The list
// is written by hand (no build step), so this test keeps it exactly in step with the imports.
const PUBLIC = join(import.meta.dirname, '../../../public');
const IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

/** The static import closure of the given files, as site paths (/v2/app.js). */
function closure(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const walk = (file: string) => {
    const site = file.slice(PUBLIC.length);
    if (seen.has(site)) return;
    seen.add(site);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2])!;
      walk(spec.startsWith('/') ? join(PUBLIC, spec) : resolve(dirname(file), spec));
    }
  };
  for (const e of entries) walk(join(PUBLIC, e));
  return seen;
}

describe('first paint', () => {
  const html = readFileSync(join(PUBLIC, 'v2/index.html'), 'utf8');
  const preloads = [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1]!);

  it('preloads exactly the modules the first screen needs', async () => {
    const REG: any = await import('../../../public/v2/core/registry.js' as string);
    const first = REG.BUNDLED.filter((m: any) => m.kind === 'look' || m.kind === 'mode').map((m: any) => {
      const manifest = JSON.parse(readFileSync(join(PUBLIC, 'v2/modules', m.kind, m.folder, 'manifest.json'), 'utf8'));
      return `/v2/modules/${m.kind}/${m.folder}/${manifest.entry}`;
    });
    const need = closure(['/v2/app.js', ...first]);
    expect(new Set(preloads)).toEqual(need);
    expect(preloads.length).toBe(need.size); // no duplicates
  });

  it('does not wait for markdown (marked and DOMPurify) before the first screen', () => {
    expect(preloads).not.toContain('/js/markdown.js');
    expect(preloads).not.toContain('/vendor/marked.js');
  });

  it('paints the background and the rings from the page itself, before any file loads', () => {
    expect(html).toMatch(/<style>[\s\S]*--bg:[\s\S]*<\/style>/);
    expect(html).toMatch(/<div id="app"[^>]*>\s*<div class="boot"[\s\S]*<svg/);
    // The stylesheet does not hold up that first paint: it comes after the shell, in the body.
    expect(html.indexOf('rel="stylesheet"')).toBeGreaterThan(html.indexOf('class="boot"'));
  });
});
