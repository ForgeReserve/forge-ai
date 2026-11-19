import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * The service worker script for the Classic chat page (/classic/), built from public/sw.js at request time.
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
    const shellOnDisk = shell.map((p) => join(publicDir, p.endsWith('/') ? p + 'index.html' : p));
    const files = [...shellOnDisk, ...vendor, join(publicDir, 'sw.js')];
    const key = files.map((f) => `${f}:${stat(f)}`).join('|');
    if (cached && key === cacheKey) return cached;
    const version = hashFiles(publicDir, shellOnDisk);
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

/**
 * The v2 app's worker (public/v2/sw.js) with its build id filled in: a SHA-256 over the v2 app's own
 * files (its pages, scripts, styles, strings and icons; not the vendored libraries or the voice files,
 * which carry their versions in their paths). Each deploy that changes the app changes the script, so
 * the browser installs the new worker and the page reloads into the new files (public/v2/core/updates.js).
 */
export function v2WorkerScript(publicDir: string): () => { body: string; version: string } {
  const root = join(publicDir, 'v2');
  let cacheKey = '';
  let cached: { body: string; version: string } | undefined;
  return () => {
    const files = walk(root).filter((f) => {
      const rel = relative(root, f).split(sep).join('/');
      return !rel.startsWith('vendor/') && !rel.startsWith('voice/') && /\.(html|js|css|json|svg|png|webmanifest)$/.test(rel);
    });
    const key = files.map((f) => `${f}:${stat(f)}`).join('|');
    if (cached && key === cacheKey) return cached;
    const version = hashFiles(root, files);
    const body = readFileSync(join(root, 'sw.js'), 'utf8').replace("'__FORGE_V2_VERSION__'", JSON.stringify(version));
    cacheKey = key;
    cached = { body, version };
    return cached;
  };
}

/** The Classic chat page's address (public/classic/index.html). Its worker precaches it and answers it offline. */
export const CLASSIC_PAGE = '/classic/';

/**
 * URL paths of the Classic app shell: the page (/classic/), its scripts and styles at the root, icons,
 * manifest and offline page. Never / (the landing page, always from the network) or /index.html.
 */
export function shellFiles(publicDir: string): string[] {
  const top = readdirSync(publicDir, { withFileTypes: true })
    .filter((d) => d.isFile() && /\.(html|js|css|svg|png|webmanifest)$/.test(d.name) && d.name !== 'sw.js' && d.name !== 'index.html')
    .map((d) => '/' + d.name);
  const sub = (dir: string, re: RegExp) =>
    safeList(join(publicDir, dir))
      .filter((n) => re.test(n))
      .map((n) => `/${dir}/${n}`);
  return [CLASSIC_PAGE, ...top, ...sub('js', /\.js$/), ...sub('icons', /\.png$/)].sort((a, b) => (a === CLASSIC_PAGE ? -1 : b === CLASSIC_PAGE ? 1 : a.localeCompare(b)));
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
