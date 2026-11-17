/**
 * Deals the UI test files (test/ui) into parts of about the same running time, from the times recorded
 * in test/ui/timings.json. CI runs one part per job (.github/workflows/ci.yml, docs/CI.md).
 *
 *   node scripts/ui-split.ts plan [parts]              # each part's files and expected time
 *   node scripts/ui-split.ts files <part> [parts]      # one part's files, one per line (what a CI job runs)
 *   node scripts/ui-split.ts verify [parts]            # asks Vitest which files each part runs: every file once
 *   node scripts/ui-split.ts refresh <report.json | folder>...   # new times from Vitest JSON reports
 *
 * Longest first, each file into the part with the least time so far. A file with no recorded time goes
 * into the lightest part at the median time, so a new test file always runs; a recorded file that is
 * gone is left out and reported. Vitest's own --shard deals files by a hash of their path, the same
 * number of files to each part, whatever they take; that left one part 2 minutes longer than the other.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How many parts CI runs the UI tests in. The workflow's matrix comes from this number. */
export const PARTS = 6;

const ROOT = resolve(import.meta.dirname, '..');
export const UI_DIR = 'test/ui';
export const TIMINGS = 'test/ui/timings.json';
/** What Vitest runs as a test file (its default include), so a test file not named *.ui.test.ts is dealt too. */
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;

export interface Timings {
  /** Where the times came from. */
  source: string;
  /** Seconds per test file, by path from the repository root. */
  files: Record<string, number>;
}

export interface Part {
  files: string[];
  seconds: number;
}

export interface Plan {
  parts: Part[];
  /** Test files with no recorded time: dealt at the assumed time. */
  unknown: string[];
  /** Recorded files that no longer exist: ignored. */
  stale: string[];
  /** The time assumed for a file with no record (the median of the recorded ones). */
  assumed: number;
}

/** Every test file under test/ui, by path from the repository root, sorted. */
export function uiFiles(root = ROOT): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else if (d.isFile() && TEST_FILE.test(d.name)) out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(join(root, UI_DIR));
  return out.sort();
}

export function readTimings(root = ROOT): Timings {
  const file = join(root, TIMINGS);
  if (!existsSync(file)) return { source: 'none', files: {} };
  return JSON.parse(readFileSync(file, 'utf8')) as Timings;
}

const median = (xs: number[]) => {
  if (!xs.length) return 60;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

/** Deals files into n parts: longest first into the lightest part, then the unrecorded ones. */
export function split(files: string[], times: Record<string, number>, n: number): Plan {
  if (!Number.isInteger(n) || n < 1) throw new Error(`parts must be a whole number of 1 or more, not ${n}`);
  const present = new Set(files);
  const known = files.filter((f) => typeof times[f] === 'number' && times[f]! >= 0);
  const unknown = files.filter((f) => !known.includes(f)).sort();
  const stale = Object.keys(times)
    .filter((f) => !present.has(f))
    .sort();
  const assumed = Math.round(median(known.map((f) => times[f]!)) * 10) / 10;
  const parts: Part[] = Array.from({ length: n }, () => ({ files: [], seconds: 0 }));
  const lightest = () => parts.reduce((best, p, i) => (p.seconds < parts[best]!.seconds ? i : best), 0);
  const deal = (f: string, s: number) => {
    const p = parts[lightest()]!;
    p.files.push(f);
    p.seconds = Math.round((p.seconds + s) * 10) / 10;
  };
  for (const f of [...known].sort((a, b) => times[b]! - times[a]! || a.localeCompare(b))) deal(f, times[f]!);
  for (const f of unknown) deal(f, assumed);
  for (const p of parts) p.files.sort();
  return { parts, unknown, stale, assumed };
}

export function plan(n = PARTS, root = ROOT): Plan {
  return split(uiFiles(root), readTimings(root).files, n);
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

export function describePlan(p: Plan, times: Record<string, number>): string {
  const lines: string[] = [];
  const total = p.parts.reduce((s, x) => s + x.seconds, 0);
  lines.push(`${p.parts.length} parts, ${p.parts.reduce((s, x) => s + x.files.length, 0)} files, ${mmss(total)} of tests in all (recorded times; ${mmss(p.assumed)} assumed for a file with none)`);
  p.parts.forEach((part, i) => {
    lines.push(`part ${i + 1}: ${mmss(part.seconds)}`);
    for (const f of part.files) lines.push(`  ${f}  ${f in times ? mmss(times[f]!) : `${mmss(p.assumed)} (no record)`}`);
  });
  if (p.unknown.length) lines.push(`no recorded time, dealt at ${mmss(p.assumed)}: ${p.unknown.join(', ')}`);
  if (p.stale.length) lines.push(`recorded but gone, ignored: ${p.stale.join(', ')}`);
  return lines.join('\n');
}

interface VitestReport {
  testResults?: { name: string; startTime?: number; endTime?: number }[];
}

/** Seconds per test file from Vitest JSON reports (--reporter=json): each file's end time less its start. */
export function reportTimes(reports: VitestReport[], root = ROOT): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of reports) {
    for (const t of r.testResults ?? []) {
      if (typeof t.startTime !== 'number' || typeof t.endTime !== 'number') continue;
      let rel = relative(root, resolve(root, t.name)).split(sep).join('/');
      // A report from another checkout (the Linux container mounts the repository at /work): from test/ on.
      if (rel.startsWith('..')) rel = /(?:^|\/)(test\/.+)$/.exec(t.name.split('\\').join('/'))?.[1] ?? rel;
      out[rel] = Math.round((t.endTime - t.startTime) / 100) / 10;
    }
  }
  return out;
}

/** The record with new times laid over it, without files that no longer exist. */
export function refreshed(old: Record<string, number>, fresh: Record<string, number>, files: string[]): Record<string, number> {
  const present = new Set(files);
  const merged: Record<string, number> = {};
  for (const f of Object.keys({ ...old, ...fresh }).sort()) {
    if (!present.has(f)) continue;
    merged[f] = fresh[f] ?? old[f]!;
  }
  return merged;
}

/** Which test files Vitest itself would run for these arguments (no test is run). */
function vitestList(args: string[]): string[] {
  const out = execFileSync(join(ROOT, 'node_modules/.bin/vitest'), ['list', '--filesOnly', ...args], { cwd: ROOT, encoding: 'utf8' });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => TEST_FILE.test(l))
    .sort();
}

function main(argv: string[]): number {
  const [cmd, ...rest] = argv;
  const num = (s: string | undefined, d: number) => (s === undefined ? d : Number(s));
  if (cmd === 'plan') {
    const p = plan(num(rest[0], PARTS));
    console.log(describePlan(p, readTimings().files));
    return 0;
  }
  if (cmd === 'files') {
    const n = num(rest[1], PARTS);
    const k = num(rest[0], NaN);
    if (!Number.isInteger(k) || k < 1 || k > n) {
      console.error(`usage: node scripts/ui-split.ts files <part 1..${n}> [parts]`);
      return 2;
    }
    const p = plan(n);
    for (const f of p.unknown) console.error(`no recorded time for ${f}: dealt at ${p.assumed} s`);
    for (const f of p.stale) console.error(`recorded but gone, ignored: ${f}`);
    console.log(p.parts[k - 1]!.files.join('\n'));
    return 0;
  }
  if (cmd === 'verify') {
    const n = num(rest[0], PARTS);
    const p = plan(n);
    const all = vitestList([UI_DIR]);
    const seen = new Map<string, number[]>();
    let ok = true;
    p.parts.forEach((part, i) => {
      const ran = vitestList(part.files);
      console.log(`part ${i + 1}: Vitest runs ${ran.length} files: ${ran.join(' ')}`);
      if (ran.join('\n') !== [...part.files].sort().join('\n')) {
        console.error(`part ${i + 1}: Vitest would run ${ran.join(', ')}, the plan says ${part.files.join(', ')}`);
        ok = false;
      }
      for (const f of ran) seen.set(f, [...(seen.get(f) ?? []), i + 1]);
    });
    for (const f of all) {
      const parts = seen.get(f) ?? [];
      if (parts.length !== 1) {
        console.error(`${f} runs in ${parts.length} parts (${parts.join(', ') || 'none'})`);
        ok = false;
      }
    }
    for (const f of seen.keys()) {
      if (all.includes(f)) continue;
      console.error(`${f} is in a part but not in vitest list ${UI_DIR}`);
      ok = false;
    }
    console.log(ok ? `every one of the ${all.length} UI test files runs in exactly one of ${n} parts` : 'the parts do not cover the UI test files once each');
    return ok ? 0 : 1;
  }
  if (cmd === 'refresh') {
    if (!rest.length) {
      console.error('usage: node scripts/ui-split.ts refresh <vitest json report or folder of them>...');
      return 2;
    }
    const files: string[] = [];
    for (const a of rest) {
      if (statSync(a).isDirectory()) {
        const walk = (d: string) => {
          for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p);
            else if (e.name.endsWith('.json')) files.push(p);
          }
        };
        walk(a);
      } else files.push(a);
    }
    const fresh = reportTimes(files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as VitestReport));
    const old = readTimings();
    const present = uiFiles();
    const merged = refreshed(old.files, fresh, present);
    for (const f of Object.keys(old.files)) if (!present.includes(f)) console.log(`dropped (file gone): ${f}`);
    for (const f of present) if (!(f in fresh)) console.log(`no new time, kept the old one: ${f}${f in old.files ? '' : ' (none recorded)'}`);
    const record: Timings = { source: `Vitest JSON reports, ${new Date().toISOString().slice(0, 10)}: ${rest.join(' ')}`, files: merged };
    writeFileSync(join(ROOT, TIMINGS), JSON.stringify(record, null, 2) + '\n');
    console.log(`${Object.keys(fresh).length} new times written to ${TIMINGS}`);
    console.log(describePlan(plan(), merged));
    return 0;
  }
  console.error('usage: node scripts/ui-split.ts plan [parts] | files <part> [parts] | verify [parts] | refresh <report.json | folder>...');
  return 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
