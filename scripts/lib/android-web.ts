/**
 * The web app as the Android app bundles it (docs/ANDROID.md). The APK carries these files and loads
 * nothing else as code: the v2 app (public/v2), the shared modules it imports (public/js), the vendored
 * libraries with their licences (public/vendor) and the icons. Never v1, the admin page, the beta page,
 * the /free page or the /download page: those are the website's.
 *
 * Capacitor serves the bundle at https://localhost/. Its index.html is the v2 page (every path in it is
 * absolute, so /v2/app.js and the rest load as they do on the website), and an address the bundle does
 * not have opens that same page (Capacitor's single page fallback).
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** Paths (relative to public/, with /) that go in the app. */
const KEEP = /^(v2\/|js\/|vendor\/|icons\/|icon\.svg$)/;
/** Inside those, what stays on the website: its own pages, and the v2 service worker (the app's files are on the phone already). */
const SKIP = /^v2\/(free\/|download\/|sw\.js$)/;

export function inBundle(rel: string): boolean {
  const p = rel.split(sep).join('/');
  return KEEP.test(p) && !SKIP.test(p);
}

function walk(dir: string, root = dir): string[] {
  const out: string[] = [];
  for (const d of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p, root));
    else if (d.isFile() && !d.name.startsWith('.')) out.push(relative(root, p).split(sep).join('/'));
  }
  return out;
}

/** Every file of public/ that the app bundles, as paths relative to public/. */
export function bundleFiles(publicDir: string): string[] {
  return walk(publicDir).filter(inBundle);
}

export interface CapacitorConfig {
  appId: string;
  appName: string;
  webDir?: string;
  [k: string]: unknown;
}

/**
 * Writes the bundle into an Android assets folder: <assets>/public (the web files, with the v2 page as
 * its index.html), <assets>/capacitor.config.json and <assets>/capacitor.plugins.json. What was in
 * <assets>/public before is removed first, so a file deleted from public/ leaves the app too.
 */
/** The natural voice's files (public/v2/voice/phonon), which the APK carries uncompressed (build.gradle noCompress). */
export const isVoiceFile = (rel: string) => rel.split(sep).join('/').startsWith('v2/voice/phonon/');

export function writeBundle(publicDir: string, assetsDir: string, config: CapacitorConfig): { files: number; bytes: number; voiceBytes: number } {
  const out = join(assetsDir, 'public');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  let bytes = 0;
  let voiceBytes = 0;
  const files = bundleFiles(publicDir);
  for (const rel of files) {
    const to = join(out, rel);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(join(publicDir, rel), to);
    const n = statSync(to).size;
    bytes += n;
    if (isVoiceFile(rel)) voiceBytes += n;
  }
  const page = readFileSync(join(publicDir, 'v2', 'index.html'));
  writeFileSync(join(out, 'index.html'), page);
  bytes += page.length;
  // The runtime reads these two. The web folder is the assets folder itself, so webDir is not passed on.
  const { webDir: _webDir, ...runtime } = config;
  writeFileSync(join(assetsDir, 'capacitor.config.json'), JSON.stringify(runtime, null, 2) + '\n');
  // The app's own plugins (ForgeShare, ForgeShareIn) are registered in MainActivity, none from npm.
  writeFileSync(join(assetsDir, 'capacitor.plugins.json'), '[]\n');
  return { files: files.length + 1, bytes, voiceBytes };
}

export function readConfig(file: string): CapacitorConfig {
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const c = JSON.parse(readFileSync(file, 'utf8')) as CapacitorConfig;
  if (c.appId !== 'com.forgereserve.ai') throw new Error(`appId must be com.forgereserve.ai, not ${c.appId}`);
  return c;
}
