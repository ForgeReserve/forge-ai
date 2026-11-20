/**
 * Scores Share unseen's face filter on the crowd photos in test/unit/fixtures/photos/crowd/: how many of
 * the faces marked by hand in faces.json it covers (recall) and how many face covers land where no face
 * is marked (false covers), per photo and overall, with the time each photo took.
 *
 *   node scripts/face-score.ts                          # the bundled filter, Chrome as it comes
 *   node scripts/face-score.ts --throttle 4             # CPU 4x slower, a stand-in for a low-end phone
 *   node scripts/face-score.ts --cpu                    # WebGL off, so TensorFlow.js runs on the processor
 *   node scripts/face-score.ts --filter <folder>        # another filter under public/v2/modules/filter/
 *   node scripts/face-score.ts --photo protest-wide.jpg # one photo (repeat for more)
 *   node scripts/face-score.ts --runs 3 --json          # median of 3 timed runs; JSON out
 *
 * The filter runs in the installed Chrome (channel 'chrome'), headless, on a page served from public/ by
 * a small static server here, exactly as Share unseen runs it: the photo opened by openPhoto (at most
 * 2,048 pixels on its long side), then analyse(). The model is loaded before the clock starts.
 *
 * A face counts as covered when at least COVERED of its marked box is under the filter's covers. A face
 * cover is false when the box it was made for (`found`) meets no marked face and no "ignore" box (faces too
 * blurred, hidden or turned to call either way) by at least MATCH of the smaller of the two. Faces under
 * faces.json's minFace pixels tall are not marked, so a cover made for something that small counts neither
 * way. `maybe` is how many spots the filter was not sure of (offered on the screen as Cover n more), and
 * `+maybe` how many faces are covered once those are covered too.
 */
import { readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

/** The part of a marked face that must be under covers for it to count as covered. */
export const COVERED = 0.9;
/** How much a cover's found box must meet a marked box (of the smaller one's area) to be about that face. */
export const MATCH = 0.3;

type Box = [number, number, number, number];
interface Marks {
  /** Faces a person could recognise, as [x, y, w, h] in the photo's own pixels. */
  faces: Box[];
  /** Places a cover is neither right nor wrong. */
  ignore?: Box[];
}
interface Cover {
  kind: string;
  shape?: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  found?: { x: number; y: number; w: number; h: number };
}

const ROOT = resolve(import.meta.dirname, '..');
const { coverMask }: { coverMask: (covers: Cover[], W: number, H: number) => Uint8Array } = await import(join(ROOT, 'public/v2/core/covers.js') as string);
const PUBLIC = join(ROOT, 'public');
const CROWD = join(ROOT, 'test/unit/fixtures/photos/crowd');

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const filter = opt('--filter') ?? 'cover-faces';
const throttle = Number(opt('--throttle') ?? 1);
const runs = Number(opt('--runs') ?? 1);
const file = JSON.parse(readFileSync(join(CROWD, 'faces.json'), 'utf8'));
const marks: Record<string, Marks> = file.photos;
const minFace: number = file.minFace;
const only = args.flatMap((a, i) => (args[i - 1] === '--photo' ? [a] : []));
const names = only.length ? only : Object.keys(marks);

const area = (b: { w: number; h: number }) => b.w * b.h;
const meet = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? (w * h) / Math.min(area(a), area(b)) : 0;
};
const box = ([x, y, w, h]: Box) => ({ x, y, w, h });

/** Recall and false covers for one photo's covers against its marks. */
export function score(m: Marks, covers: Cover[], W: number, H: number, min = 0) {
  const mask = coverMask(covers, W, H);
  const missed: Box[] = [];
  for (const f of m.faces) {
    let under = 0;
    for (let y = f[1]; y < f[1] + f[3]; y++) for (let x = f[0]; x < f[0] + f[2]; x++) under += mask[y * W + x] ?? 0;
    if (under < COVERED * f[2] * f[3]) missed.push(f);
  }
  const known = [...m.faces, ...(m.ignore ?? [])].map(box);
  const faces = covers.filter((c) => c.kind === 'face');
  const wrong = faces.filter((c) => (c.found ?? c).h >= min && !known.some((k) => meet(c.found ?? c, k) >= MATCH));
  return { faces: m.faces.length, covered: m.faces.length - missed.length, missed, covers: faces.length, falseCovers: wrong.length, wrong: wrong.map((c) => c.found ?? c) };
}

const TYPES: Record<string, string> = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.html': 'text/html', '.css': 'text/css', '.bin': 'application/octet-stream', '.wasm': 'application/wasm' };

async function main() {
  // public/ as the website serves it, and a blank page for the filter to run in.
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (path === '/score.html') return res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>score</title>');
    const file = normalize(join(PUBLIC, path));
    if (!file.startsWith(PUBLIC + sep) || !statSync(file, { throwIfNoEntry: false })?.isFile()) return res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: args.includes('--cpu') ? ['--disable-webgl', '--disable-webgl2', '--disable-gpu'] : [] });
  const page = await (await browser.newContext()).newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/score.html`);
  if (throttle > 1) await (await page.context().newCDPSession(page)).send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const backend = await page.evaluate(async ({ filter, xopts }) => {
    const w = window as any;
    w.__xopts = xopts;
    const mod = await import(`/v2/modules/filter/${filter}/index.js`);
    w.__filter = mod.create({ t: (k: string) => k });
    await w.__filter.prepare?.();
    const api = await import('/vendor/face-api/face-api.js' as string);
    return api.tf.getBackend() as string;
  }, { filter, xopts: JSON.parse(opt('--xopts') ?? '{}') });

  const rows: (ReturnType<typeof score> & { photo: string; size: string; maybe: number; withMaybe: number; ms: number; covers_: Cover[] })[] = [];
  for (const name of names) {
    const m = marks[name];
    if (!m) throw new Error(`no marks for ${name} in faces.json`);
    const bytes = readFileSync(join(CROWD, name)).toString('base64');
    const times: number[] = [];
    let out: { covers: Cover[]; maybe: Cover[]; W: number; H: number } | null = null;
    for (let i = 0; i < runs; i++) {
      out = await page.evaluate(async ({ bytes, name }) => {
        const P = await import('/v2/core/photo.js' as string);
        const raw = Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
        const photo = await P.openPhoto(new File([raw], name, { type: 'image/jpeg' }));
        const t0 = performance.now();
        const r = await (window as any).__filter.analyse(photo);
        const ms = performance.now() - t0;
        (window as any).__ms = ms;
        return { covers: r.covers, maybe: r.maybe ?? [], W: photo.width, H: photo.height };
      }, { bytes, name });
      times.push(await page.evaluate(() => (window as any).__ms as number));
    }
    const s = score(m, out!.covers, out!.W, out!.H, minFace);
    // With the spots it was not sure of covered too (Cover n more on the screen).
    const all = score(m, [...out!.covers, ...out!.maybe], out!.W, out!.H, minFace).covered;
    rows.push({ photo: name, size: `${out!.W}x${out!.H}`, ...s, maybe: out!.maybe.length, withMaybe: all, ms: Math.round(times.sort((a, b) => a - b)[Math.floor(times.length / 2)]!), covers_: out!.covers });
  }
  await browser.close();
  server.close();
  if (errors.length) console.error(errors.join('\n'));

  const sum = (k: 'faces' | 'covered' | 'falseCovers' | 'covers' | 'maybe' | 'withMaybe' | 'ms') => rows.reduce((n, r) => n + r[k], 0);
  const total = { faces: sum('faces'), covered: sum('covered'), recall: +(sum('covered') / sum('faces')).toFixed(3), covers: sum('covers'), falseCovers: sum('falseCovers'), maybe: sum('maybe'), withMaybe: sum('withMaybe'), ms: sum('ms') };
  if (args.includes('--json')) {
    console.log(JSON.stringify({ filter, backend, throttle, rows: rows.map(({ covers_, ...r }) => (args.includes('--covers') ? { ...r, list: covers_ } : r)), total }, null, 1));
    return;
  }
  console.log(`filter ${filter}, TensorFlow.js on ${backend}, CPU ${throttle}x${runs > 1 ? `, median of ${runs} runs` : ''}`);
  console.log('photo'.padEnd(26) + 'size'.padEnd(11) + 'covered'.padStart(9) + 'recall'.padStart(8) + 'false'.padStart(7) + 'maybe'.padStart(7) + '+maybe'.padStart(8) + 'ms'.padStart(8));
  for (const r of rows) console.log(r.photo.padEnd(26) + r.size.padEnd(11) + `${r.covered}/${r.faces}`.padStart(9) + (r.covered / r.faces).toFixed(2).padStart(8) + String(r.falseCovers).padStart(7) + String(r.maybe).padStart(7) + `${r.withMaybe}`.padStart(8) + String(r.ms).padStart(8));
  console.log('all'.padEnd(37) + `${total.covered}/${total.faces}`.padStart(9) + total.recall.toFixed(2).padStart(8) + String(total.falseCovers).padStart(7) + String(total.maybe).padStart(7) + `${total.withMaybe}`.padStart(8) + String(total.ms).padStart(8));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
