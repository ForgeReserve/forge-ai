/**
 * Decides which CI jobs a change needs, and which changed UI test files to run again (docs/CI.md). The
 * first job of .github/workflows/ci.yml runs it; the last one (ci-ok) runs it with `verdict`.
 *
 *   node scripts/ci-changes.ts                       # in CI: diffs the pull request, writes the job outputs and summary
 *   node scripts/ci-changes.ts --base origin/main    # locally: what would run for this branch's changes
 *   node scripts/ci-changes.ts --paths a.md src/x.ts # locally: what would run for these changed paths
 *   node scripts/ci-changes.ts verdict               # in ci-ok: did every job this change needs pass
 *
 * Coarse on purpose. A path decides which jobs run, never which tests: the app loads modules by name at
 * run time, so following imports would miss things. Pushes to main, anything this script cannot read,
 * and any change to the build or the tooling run everything.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PARTS, readTimings, uiFiles } from './ui-split.ts';

const ROOT = resolve(import.meta.dirname, '..');

/** Extra runs of each changed UI test file on a pull request, on top of the normal run. */
export const REPEATS = 5;
/** At most this many changed UI test files are run again: the ones with the largest diff. */
export const MAX_REPEAT_FILES = 6;
/** Seconds of tests one repeat job aims for: a long file's runs are spread over several jobs. */
export const REPEAT_BUDGET = 240;
/** At most this many repeat jobs. */
export const MAX_REPEAT_JOBS = 12;

/**
 * all: the build, the tooling or CI itself, so everything runs. docs: words only. android, ios: the
 * native apps. web: what the Android bundle is made from (public/ and capacitor.config.json), which the
 * browser tests also serve. other: everything else (the gateway, the tests, ...).
 */
export type Kind = 'all' | 'docs' | 'android' | 'ios' | 'web' | 'other';

export function kindOf(path: string): Kind {
  const p = path.replace(/^\.\//, '');
  const base = posix.basename(p);
  if (p.startsWith('.github/') || p.startsWith('scripts/')) return 'all';
  if (['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'docker-compose.test.yml'].includes(p)) return 'all';
  if (/^vitest\.config\.[^/]+$/.test(p) || /^tsconfig[^/]*\.json$/.test(base)) return 'all';
  if (p.startsWith('docs/') || p.startsWith('public/docs/')) return 'docs';
  // A Markdown file under public/ is served and bundled with the app (licences, sources): not docs.
  if (p.endsWith('.md') && !p.startsWith('public/')) return 'docs';
  if (p.startsWith('android/')) return 'android';
  if (p.startsWith('ios/')) return 'ios';
  if (p.startsWith('public/') || p === 'capacitor.config.json') return 'web';
  return 'other';
}

export interface Change {
  path: string;
  /** git's letter: A added, M modified, D deleted, T type changed. */
  status: string;
  /** Lines added plus lines removed (0 for a binary file). */
  lines: number;
}

export interface RepeatEntry {
  file: string;
  runs: number;
  label: string;
}

export interface Decision {
  everything: boolean;
  reasons: string[];
  e2e: 'all' | 'docs' | 'none';
  ui: 'all' | 'docs' | 'none';
  android: boolean;
  /** The ui job's matrix: part numbers, or "docs" for the docs page's test alone. */
  uiParts: (number | 'docs')[];
  repeat: RepeatEntry[];
  repeatNotes: string[];
  changes: (Change & { kind: Kind })[];
}

/** Reads a test/ui file's text, or null when it is not there. */
export type ReadFile = (path: string) => string | null;

export interface RepeatInput {
  changes: Change[];
  /** Every .ts and .js file under test/ui, by path from the repository root. */
  uiSources: string[];
  read: ReadFile;
  /** Every test file under test/ui (what the UI parts run). */
  testFiles: string[];
  times: Record<string, number>;
}

const SAFE_UI_PATH = /^test\/ui\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const IMPORT = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/gm;

/** Relative files a source imports, by path from the repository root. */
export function importsOf(path: string, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    if (!spec || !spec.startsWith('.')) continue;
    out.add(normalize(join(dirname(path), spec)).split('\\').join('/'));
  }
  return [...out];
}

/** The UI test files to run again, and how the runs are spread over jobs. */
export function repeatPlan(input: RepeatInput): { entries: RepeatEntry[]; notes: string[] } {
  const notes: string[] = [];
  const score = new Map<string, number>();
  const direct = new Set<string>();
  const bump = (f: string, s: number) => score.set(f, Math.max(score.get(f) ?? 0, s));
  const testSet = new Set(input.testFiles);
  let graph: Map<string, string[]> | undefined;
  /** Which sources import each file (read once, when the first helper changed). */
  const importersOf = () => {
    if (graph) return graph;
    graph = new Map();
    for (const src of input.uiSources) {
      const text = input.read(src);
      if (text === null) continue;
      for (const dep of importsOf(src, text)) graph.set(dep, [...(graph.get(dep) ?? []), src]);
    }
    return graph;
  };
  const changed = input.changes.filter((c) => c.path.startsWith('test/ui/') && c.status !== 'D');
  for (const c of changed) {
    if (!SAFE_UI_PATH.test(c.path) || c.path.includes('..')) {
      notes.push(`${c.path}: an unusual file name, not run again (the normal run still runs it)`);
      continue;
    }
    if (TEST_FILE.test(c.path)) {
      if (testSet.has(c.path)) {
        bump(c.path, c.lines);
        direct.add(c.path);
      }
      continue;
    }
    // A helper: every test file that imports it, directly or through another helper.
    const importers = importersOf();
    const seen = new Set<string>([c.path]);
    const queue = [c.path];
    const users: string[] = [];
    while (queue.length) {
      for (const user of importers.get(queue.shift()!) ?? []) {
        if (seen.has(user)) continue;
        seen.add(user);
        queue.push(user);
        if (testSet.has(user)) users.push(user);
      }
    }
    if (users.length) notes.push(`${c.path} is a helper: run again with the ${users.length} test file${users.length === 1 ? '' : 's'} that import it (${users.sort().join(', ')})`);
    else notes.push(`${c.path}: no UI test file imports it`);
    for (const u of users) bump(u, c.lines);
  }
  // Test files changed themselves first, then those using a changed helper; larger diffs first in each.
  const ranked = [...score.entries()]
    .sort((a, b) => Number(direct.has(b[0])) - Number(direct.has(a[0])) || b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([f]) => f);
  const chosen = ranked.slice(0, MAX_REPEAT_FILES);
  if (ranked.length > MAX_REPEAT_FILES) {
    notes.push(`${ranked.length} UI test files changed or use a changed helper: only ${MAX_REPEAT_FILES} are run again (files changed themselves first, then the largest diff). Not run again: ${ranked.slice(MAX_REPEAT_FILES).join(', ')}`);
  }
  const known = Object.values(input.times).sort((a, b) => a - b);
  const assumed = known.length ? known[Math.floor(known.length / 2)]! : 60;
  // As many runs in a job as fit in the budget (at least one), so no job runs much more than the budget.
  const jobsFor = (f: string) => Math.min(REPEATS, Math.ceil(REPEATS / Math.max(1, Math.floor(REPEAT_BUDGET / (input.times[f] ?? assumed)))));
  const chunks = new Map(chosen.map((f) => [f, jobsFor(f)]));
  const total = () => [...chunks.values()].reduce((s, n) => s + n, 0);
  while (total() > MAX_REPEAT_JOBS) {
    const [f, n] = [...chunks.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]!;
    chunks.set(f, n - 1);
  }
  const entries: RepeatEntry[] = [];
  for (const f of chosen) {
    const n = chunks.get(f)!;
    const name = posix.basename(f);
    for (let i = 0; i < n; i++) {
      const runs = Math.floor(REPEATS / n) + (i < REPEATS % n ? 1 : 0);
      entries.push({ file: f, runs, label: n > 1 ? `${name} ${i + 1}/${n}` : name });
    }
  }
  return { entries, notes };
}

/** Which jobs run. changes is null when the pull request's changes could not be read. */
export function decide(event: string, changes: Change[] | null, repeatInput?: Omit<RepeatInput, 'changes'>): Decision {
  const everything = (reason: string): Decision => ({
    everything: true,
    reasons: [reason],
    e2e: 'all',
    ui: 'all',
    android: true,
    uiParts: Array.from({ length: PARTS }, (_, i) => i + 1),
    repeat: [],
    repeatNotes: [],
    changes: (changes ?? []).map((c) => ({ ...c, kind: kindOf(c.path) })),
  });
  if (event !== 'pull_request') return everything(event === 'push' ? 'a push to main runs everything' : `a ${event} event runs everything`);
  if (changes === null) return everything("the pull request's changed files could not be read, so everything runs");
  if (changes.length === 0) return everything('the pull request changes no file that git lists, so everything runs');
  const kinds = changes.map((c) => ({ ...c, kind: kindOf(c.path) }));
  const has = (k: Kind) => kinds.some((c) => c.kind === k);
  const global = kinds.filter((c) => c.kind === 'all');
  const withRepeats = (d: Decision): Decision => {
    if (d.ui !== 'all' || !repeatInput) return d;
    const r = repeatPlan({ ...repeatInput, changes });
    return { ...d, repeat: r.entries, repeatNotes: r.notes };
  };
  if (global.length) {
    return withRepeats(everything(`build, tooling or CI files changed (${global.map((c) => c.path).slice(0, 5).join(', ')}${global.length > 5 ? ', ...' : ''}), so everything runs`));
  }
  const reasons: string[] = [];
  // The browser tests and the end to end tests serve the gateway and public/: anything but docs and the
  // native apps can change what they see.
  const code = has('other') || has('web');
  const browser: Decision['ui'] = code ? 'all' : has('docs') ? 'docs' : 'none';
  if (browser === 'all') reasons.push('code, tests or the web app changed: the end to end tests and every UI part run');
  else if (browser === 'docs') reasons.push('docs changed and no code: only the docs pages are checked in a browser (test/e2e/docs.e2e.test.ts, test/ui/docs.ui.test.ts), with the unit tests that compare the docs with the code');
  else reasons.push('only the native apps changed: no browser or end to end test reads them, so those are skipped');
  const android = has('android') || has('web');
  reasons.push(android ? 'android/ or what the Android bundle is made from (public/, capacitor.config.json) changed: the Android build runs' : 'nothing under android/ or what the Android bundle is made from changed: the Android build is skipped');
  if (has('ios')) reasons.push('ios/ changed: CI builds no iPhone app; the unit tests check its project files (test/unit/ios.test.ts)');
  return withRepeats({
    everything: false,
    reasons,
    e2e: browser,
    ui: browser,
    android,
    uiParts: browser === 'all' ? Array.from({ length: PARTS }, (_, i) => i + 1) : browser === 'docs' ? ['docs'] : [],
    repeat: [],
    repeatNotes: [],
    changes: kinds,
  });
}

const RUNS = (d: Decision) => ({
  check: true,
  e2e: d.e2e !== 'none',
  ui: d.ui !== 'none',
  android: d.android,
  repeat: d.repeat.length > 0,
});

/** The step outputs the workflow reads. A matrix is never empty: a skipped job's matrix is a placeholder. */
export interface Outputs {
  e2e: string;
  ui: string;
  android: string;
  ui_parts: string;
  repeat: string;
  repeat_count: string;
}

export function outputs(d: Decision): Outputs {
  return {
    e2e: d.e2e,
    ui: d.ui,
    android: String(d.android),
    ui_parts: JSON.stringify(d.uiParts.length ? d.uiParts : [0]),
    repeat: JSON.stringify(d.repeat.length ? d.repeat : [{ file: '', runs: 0, label: 'none' }]),
    repeat_count: String(d.repeat.length),
  };
}

const md = (s: string) => s.replace(/[`|<>]/g, '');

export function summary(d: Decision): string {
  const run = RUNS(d);
  const lines = ['## What CI runs for this change', ''];
  lines.push('| Job | Runs |', '| --- | --- |');
  lines.push('| check (type-check, unit tests, the UI split) | yes |');
  lines.push(`| e2e | ${d.e2e === 'all' ? 'yes' : d.e2e === 'docs' ? 'docs page only (test/e2e/docs.e2e.test.ts)' : 'skipped'} |`);
  lines.push(`| ui | ${d.ui === 'all' ? `yes, in ${d.uiParts.length} parts` : d.ui === 'docs' ? 'docs page only (test/ui/docs.ui.test.ts)' : 'skipped'} |`);
  lines.push(`| android | ${run.android ? 'yes' : 'skipped'} |`);
  lines.push(`| repeat | ${run.repeat ? `${new Set(d.repeat.map((r) => r.file)).size} changed UI test file(s), ${REPEATS} extra runs each, in ${d.repeat.length} job(s)` : 'nothing to run again'} |`);
  lines.push('', '**Why:**', '', ...d.reasons.map((r) => `- ${md(r)}`));
  if (d.repeat.length || d.repeatNotes.length) {
    lines.push('', '**Run again:**', '');
    for (const r of d.repeat) lines.push(`- ${md(r.label)}: ${r.runs} run(s) of ${md(r.file)}`);
    for (const n of d.repeatNotes) lines.push(`- ${md(n)}`);
  }
  if (d.changes.length) {
    lines.push('', `<details><summary>${d.changes.length} changed file(s)</summary>`, '');
    for (const c of d.changes.slice(0, 200)) lines.push(`- ${md(c.path)} (${c.status}, ${c.kind})`);
    if (d.changes.length > 200) lines.push(`- and ${d.changes.length - 200} more`);
    lines.push('', '</details>');
  }
  lines.push('', 'The check to require is ci-ok: it passes when every job this change needs passed and the others were skipped by these rules (docs/CI.md).');
  return lines.join('\n') + '\n';
}

export interface Need {
  result: string;
  outputs?: Record<string, string>;
}

/** ci-ok: every job the change needs passed; a job skipped by the rules is fine, a job skipped by a failure is not. */
export function verdict(needs: Record<string, Need>): { ok: boolean; lines: string[] } {
  const lines: string[] = [];
  let ok = true;
  const changes = needs.changes;
  if (changes?.result !== 'success') {
    lines.push(`changes: ${changes?.result ?? 'missing'}: the rules did not run, so nothing can be skipped`);
    ok = false;
  }
  const o = changes?.outputs ?? {};
  const wanted: Record<string, boolean> = {
    check: true,
    e2e: o.e2e !== 'none',
    ui: o.ui !== 'none',
    android: o.android !== 'false',
    repeat: (o.repeat_count ?? '0') !== '0',
  };
  for (const [job, want] of Object.entries(wanted)) {
    const r = needs[job]?.result ?? 'missing';
    if (r === 'success') lines.push(`${job}: passed`);
    else if (r === 'skipped' && !want && changes?.result === 'success') lines.push(`${job}: skipped by the rules (not needed for this change)`);
    else {
      lines.push(`${job}: ${r}${r === 'skipped' ? ', but this change needs it' : ''}`);
      ok = false;
    }
  }
  return { ok, lines };
}

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** The changes between two commits: name, status and size, renames as a delete plus an add. */
export function parseDiff(nameStatus: string, numstat: string): Change[] {
  const lines = new Map<string, number>();
  for (const l of numstat.split('\n')) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(l);
    if (m) lines.set(m[3]!, (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2])));
  }
  const out: Change[] = [];
  for (const l of nameStatus.split('\n')) {
    const m = /^([A-Z])\d*\t(.+)$/.exec(l);
    if (m) out.push({ path: m[2]!, status: m[1]!, lines: lines.get(m[2]!) ?? 0 });
  }
  return out;
}

function diff(base: string, head: string): Change[] {
  return parseDiff(git(['diff', '--name-status', '--no-renames', base, head]), git(['diff', '--numstat', '--no-renames', base, head]));
}

/** In a pull request, actions/checkout gives the merge commit: its first parent is the base branch. */
function pullRequestChanges(): Change[] | null {
  try {
    const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/);
    if (parents.length !== 3) return null;
    return diff('HEAD^1', 'HEAD');
  } catch {
    return null;
  }
}

function repeatContext(): Omit<RepeatInput, 'changes'> {
  const sources = git(['ls-files', '-co', '--exclude-standard', 'test/ui'])
    .split('\n')
    .filter((p) => /\.[cm]?[jt]sx?$/.test(p));
  return {
    uiSources: sources,
    read: (p) => (existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : null),
    testFiles: uiFiles(ROOT),
    times: readTimings(ROOT).files,
  };
}

function main(argv: string[]): number {
  if (argv[0] === 'verdict') {
    const needs = JSON.parse(process.env.NEEDS ?? '{}') as Record<string, Need>;
    const v = verdict(needs);
    for (const l of v.lines) console.log(l);
    const out = `## ci-ok: ${v.ok ? 'passed' : 'failed'}\n\n${v.lines.map((l) => `- ${md(l)}`).join('\n')}\n`;
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, out);
    return v.ok ? 0 : 1;
  }
  let event = process.env.GITHUB_EVENT_NAME ?? 'local';
  let changes: Change[] | null = null;
  if (argv[0] === '--paths') {
    event = 'pull_request';
    changes = argv.slice(1).map((path) => ({ path, status: existsSync(join(ROOT, path)) ? 'M' : 'D', lines: 1 }));
  } else if (argv[0] === '--base' && argv[1]) {
    event = 'pull_request';
    changes = diff(git(['merge-base', argv[1], 'HEAD']).trim(), 'HEAD');
  } else if (event === 'pull_request') {
    changes = pullRequestChanges();
  }
  const d = decide(event, changes, repeatContext());
  const text = summary(d);
  console.log(text);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs(d)).map(([k, v]) => `${k}=${v}\n`).join(''));
  } else {
    for (const [k, v] of Object.entries(outputs(d))) console.log(`${k}=${v}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) process.exit(main(process.argv.slice(2)));
