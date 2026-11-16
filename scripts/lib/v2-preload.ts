/**
 * The v2 app's preload list (public/v2/index.html, between the preload markers). The app has no build
 * step, so without it the browser finds the modules one import level at a time. Two parts:
 *
 * - the first screen's modules (the app's static imports and those of the looks and the mode, which
 *   are all a screen needs to be drawn): fetched at once, at the browser's normal priority;
 * - every other bundled module's entry and what it imports (fund, voice, filter: core/registry.js
 *   BUNDLED), which the app loads right after the first screen: fetched at the same time, at low
 *   priority, so they never hold up the first paint but no longer wait for the manifest, then the
 *   entry, then its imports.
 *
 * Written by scripts/v2-preload.ts; test/unit/v2/preload.test.ts fails when the page is out of step.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const PUBLIC = resolve(import.meta.dirname, '../../public');
export const START = '<!-- preload:start (scripts/v2-preload.ts writes this list) -->';
export const END = '<!-- preload:end -->';
const IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;

/** The static import closure of the given files, as site paths (/v2/app.js), in the order found. */
export function closure(entries: string[], skip: Set<string> = new Set()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const walk = (file: string) => {
    const site = file.slice(PUBLIC.length);
    if (seen.has(site) || skip.has(site)) return;
    seen.add(site);
    out.push(site);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const spec = (m[1] ?? m[2])!;
      walk(spec.startsWith('/') ? join(PUBLIC, spec) : resolve(dirname(file), spec));
    }
  };
  for (const e of entries) walk(join(PUBLIC, e));
  return out;
}

type Bundled = { kind: string; folder: string };

/** A bundled module's entry file, as a site path, from its manifest. */
function entryOf(m: Bundled): string {
  const manifest = JSON.parse(readFileSync(join(PUBLIC, 'v2/modules', m.kind, m.folder, 'manifest.json'), 'utf8'));
  return `/v2/modules/${m.kind}/${m.folder}/${manifest.entry}`;
}

/** {first, later}: the first screen's modules, and the rest of the bundled modules' graph. */
export async function preloads(): Promise<{ first: string[]; later: string[] }> {
  const REG: any = await import('../../public/v2/core/registry.js' as string);
  const bundled: Bundled[] = REG.BUNDLED;
  const drawFirst = bundled.filter((m) => m.kind === 'look' || m.kind === 'mode');
  const first = closure(['/v2/app.js', ...drawFirst.map(entryOf)]);
  const later = closure(bundled.filter((m) => !drawFirst.includes(m)).map(entryOf), new Set(first));
  return { first, later };
}

/** The lines between the markers. */
export async function preloadBlock(indent = '  '): Promise<string> {
  const { first, later } = await preloads();
  return [...first.map((p) => `${indent}<link rel="modulepreload" href="${p}">`), ...later.map((p) => `${indent}<link rel="modulepreload" href="${p}" fetchpriority="low">`)].join('\n');
}

/** index.html with its block replaced by `block`. */
export function withBlock(html: string, block: string): string {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  if (a < 0 || b < a) throw new Error('index.html has no preload markers');
  return `${html.slice(0, a + START.length)}\n${block}\n  ${html.slice(b)}`;
}
