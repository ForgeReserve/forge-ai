/**
 * Vendors the Playful mode's two typefaces (docs/PLAYFUL.md) into public/v2/vendor: Baloo 2 for the
 * display words and Nunito for the text, both SIL Open Font License 1.1. The files come from the
 * fontsource npm packages pinned exactly in package.json (devDependencies, installed with pnpm under the
 * repo's minimum release age), never from Google at run time: the app is offline first and the Android
 * app carries these files.
 *
 * Only the Latin and Latin Extended variable files are copied (the weights 400 to 800 in one file each).
 * The licence goes in public/vendor/licenses with the others, and each folder gets a VERSION.json with the
 * package, its version and each file's SHA-256, which test/unit/v2/playful.test.ts checks.
 *
 *   pnpm install && node scripts/vendor-playful-fonts.ts
 */
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LIC = join(ROOT, 'public/vendor/licenses');

/** The fonts: their npm package, the folder in public/v2/vendor, and the files copied from its files/ folder. */
const FONTS = [
  { id: 'baloo-2', name: 'Baloo 2', pkg: '@fontsource-variable/baloo-2', files: ['baloo-2-latin-wght-normal.woff2', 'baloo-2-latin-ext-wght-normal.woff2'] },
  { id: 'nunito', name: 'Nunito', pkg: '@fontsource-variable/nunito', files: ['nunito-latin-wght-normal.woff2', 'nunito-latin-ext-wght-normal.woff2'] },
];

const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const pins = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).devDependencies as Record<string, string>;
mkdirSync(LIC, { recursive: true });
for (const f of FONTS) {
  const src = join(ROOT, 'node_modules', f.pkg);
  const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version as string;
  if (pins[f.pkg] !== version) throw new Error(`${f.pkg}: installed ${version}, package.json pins ${pins[f.pkg]}: run pnpm install`);
  const out = join(ROOT, 'public/v2/vendor', f.id);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const file of f.files) {
    copyFileSync(join(src, 'files', file), join(out, file));
    hashes[file] = sha(readFileSync(join(out, file)));
  }
  writeFileSync(join(out, 'VERSION.json'), JSON.stringify({ name: f.name, version, license: 'OFL-1.1', source: `npm ${f.pkg}@${version}`, files: hashes }) + '\n');
  writeFileSync(join(LIC, `${f.id}.txt`), `${f.name} (${f.files.join(', ')}), from npm ${f.pkg}@${version}\n\n${readFileSync(join(src, 'LICENSE'), 'utf8')}`);
  console.log(`vendored ${f.name} ${version} into ${out}`);
}
