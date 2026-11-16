/**
 * Writes the v2 app's preload list into public/v2/index.html (scripts/lib/v2-preload.ts). Run it after
 * adding, moving or removing a module import:
 *
 *   node scripts/v2-preload.ts
 *
 * test/unit/v2/preload.test.ts fails while the page and the imports disagree.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { preloadBlock, PUBLIC, withBlock } from './lib/v2-preload.ts';

const file = join(PUBLIC, 'v2/index.html');
const html = readFileSync(file, 'utf8');
const next = withBlock(html, await preloadBlock());
if (next === html) console.log('public/v2/index.html: preload list up to date');
else {
  writeFileSync(file, next);
  console.log('public/v2/index.html: preload list written');
}
