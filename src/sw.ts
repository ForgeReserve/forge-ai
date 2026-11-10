import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The service worker script for the chat page, built from public/sw.js at request time.
 *
 * Its version is a SHA-256 over the app shell files (paths and contents) and its vendor version a
 * SHA-256 over public/vendor, so every deploy that changes the page produces a byte-different /sw.js
 * and browsers install the new worker. No build step: the hashes are computed when the gateway starts
 * and again only when a file's size or modification time changes.
 */
export function serviceWorkerScript(publicDir: string): () => { body: string; version: string } {
  let cacheKey = '';
  let cached: { body: string; version: string } | undefined;
  return () => {
    const shell = shellFiles(publicDir);
    const vendor = walk(join(publicDir, 'vendor'));
    const files = [...shell.map((p) => (p === '/' ? join(publicDir, 'index.html') : join(publicDir, p))), ...vendor, join(publicDir, 'sw.js')];
    const key = files.map((f) => `${f}:${stat(f)}`).join('|');
    if (cached && key === cacheKey) return cached;
    const version = hashFiles(publicDir, shell.map((p) => (p === '/' ? join(publicDir, 'index.html') : join(publicDir, p))));
    const vendorVersion = hashFiles(publicDir, vendor);
    const body = readFileSync(join(publicDir, 'sw.js'), 'utf8')
      .replace("'__FORGE_SW_VERSION__'", JSON.stringify(version))
      .replace("'__FORGE_VENDOR_VERSION__'", JSON.stringify(vendorVersion))
      .replace('__FORGE_SW_SHELL__', JSON.stringify(shell));
    cacheKey = key;
    cached = { body, version };
    return cached;
  };
}

/** URL paths of the app shell: the page, its scripts and styles, icons, manifest and offline page. */
export function shellFiles(publicDir: string): string[] {
  const top = readdirSync(publicDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(html|js|css|svg|png|webmanifest)$/.test(d.name) && d.name !== 'sw.js' && d.name !== 'index.html')
    .map((d) => '/' + d.name);
  const sub = (dir: string, re: RegExp) =>
    safeList(join(publicDir, dir))
      .filter((n) => re.test(n))
      .map((n) => `/${dir}/${n}`);
  return ['/', ...top, ...sub('js', /\.js$/), ...sub('icons', /\.png$/)].sort((a, b) => (a === '/' ? -1 : b === '/' ? 1 : a.localeCompare(b)));
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const d of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, d.name);
    if (d.isDirectory()) out.push(...walk(p));
    else if (d.isFile()) out.push(p);
  }
  return out;
}

function stat(f: string): string {
  try {
    const s = statSync(f);
    return `${s.size}:${s.mtimeMs}`;
  } catch {
    return 'missing';
  }
}

function hashFiles(root: string, files: string[]): string {
  const h = createHash('sha256');
  for (const f of files) {
    h.update(relative(root, f).split(sep).join('/'));
    h.update('\0');
    try {
      h.update(readFileSync(f));
    } catch {
      h.update('missing');
    }
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
}
