// CI's own rules (docs/CI.md): how the UI files are dealt into parts (scripts/ui-split.ts), which jobs a
// change needs and which UI files run again (scripts/ci-changes.ts), and the workflow that uses them.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Change, decide, importsOf, kindOf, MAX_REPEAT_FILES, outputs, parseDiff, REPEATS, repeatPlan, type RepeatInput, summary, verdict } from '../../scripts/ci-changes.ts';
import { PARTS, readTimings, refreshed, reportTimes, split, uiFiles } from '../../scripts/ui-split.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

/** Every file in exactly one part. */
function once(parts: { files: string[] }[], files: string[]) {
  const seen = parts.flatMap((p) => p.files);
  expect([...seen].sort()).toEqual([...files].sort());
  expect(new Set(seen).size).toBe(seen.length);
}

describe('the UI split (scripts/ui-split.ts)', () => {
  const files = uiFiles();
  const times = readTimings().files;

  it('finds every UI test file, and the record has a time for each', () => {
    expect(files.length).toBeGreaterThan(20);
    for (const f of files) expect(f).toMatch(/^test\/ui\/.+\.test\.ts$/);
    expect(files).toContain('test/ui/phonon.ui.test.ts');
    expect(files).toContain('test/ui/phonon-lab.ui.test.ts');
    // A helper is not a test file.
    expect(files).not.toContain('test/ui/ways.ts');
    expect(files.filter((f) => !(f in times))).toEqual([]);
    expect(Object.keys(times).filter((f) => !existsSync(join(ROOT, f)))).toEqual([]);
  });

  it.each([1, 2, 3, 4, 5, 6, 7, 8, 12, 40])('puts every UI test file in exactly one of %i parts', (n) => {
    const p = split(files, times, n);
    expect(p.parts).toHaveLength(n);
    once(p.parts, files);
    expect(p.unknown).toEqual([]);
    expect(p.stale).toEqual([]);
  });

  it('keeps the parts within one file of each other: no part ends later than the lightest part plus its last file', () => {
    for (const n of [2, 4, 6]) {
      const p = split(files, times, n);
      const light = Math.min(...p.parts.map((x) => x.seconds));
      const longest = Math.max(...files.map((f) => times[f]!));
      for (const part of p.parts) expect(part.seconds).toBeLessThanOrEqual(light + longest);
    }
  });

  it('deals longest first into the lightest part', () => {
    const p = split(['a', 'b', 'c', 'd', 'e'], { a: 10, b: 9, c: 6, d: 5, e: 1 }, 2);
    expect(p.parts.map((x) => [x.files, x.seconds])).toEqual([
      [['a', 'd', 'e'], 16],
      [['b', 'c'], 15],
    ]);
  });

  it('puts a file with no recorded time in the lightest part, at the median time, and says so', () => {
    const all = [...files, 'test/ui/brand-new.ui.test.ts', 'test/ui/also-new.ui.test.ts'];
    for (const n of [1, 3, 6]) {
      const p = split(all, times, n);
      once(p.parts, all);
      expect(p.unknown).toEqual(['test/ui/also-new.ui.test.ts', 'test/ui/brand-new.ui.test.ts']);
    }
    const p = split(['x', 'y', 'new'], { x: 30, y: 10 }, 2);
    expect(p.assumed).toBe(20);
    expect(p.parts.find((x) => x.files.includes('new'))!.files).toEqual(['new', 'y']);
    // With nothing recorded at all, every file still runs.
    once(split(files, {}, 6).parts, files);
  });

  it('ignores a recorded file that no longer exists, and reports it', () => {
    const p = split(files, { ...times, 'test/ui/gone.ui.test.ts': 500 }, 6);
    once(p.parts, files);
    expect(p.stale).toEqual(['test/ui/gone.ui.test.ts']);
    expect(Math.max(...p.parts.map((x) => x.seconds))).toBeLessThan(500);
  });

  it('keeps pnpm test:ui:voice running both of the natural voice files', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:ui:voice']).toBe('vitest run test/ui/phonon');
    expect(files.filter((f) => f.includes('test/ui/phonon'))).toEqual(['test/ui/phonon-lab.ui.test.ts', 'test/ui/phonon.ui.test.ts']);
  });

  it('refuses a part count that is not a whole number of 1 or more', () => {
    expect(() => split(files, times, 0)).toThrow();
    expect(() => split(files, times, 2.5)).toThrow();
  });

  it("reads each file's time from Vitest JSON reports, and refreshes the record without files that are gone", () => {
    const report = {
      testResults: [
        { name: join(ROOT, 'test/ui/game.ui.test.ts'), startTime: 1000, endTime: 87_450 },
        { name: join(ROOT, 'test/ui/new.ui.test.ts'), startTime: 0, endTime: 12_000 },
        { name: join(ROOT, 'test/ui/broken.ui.test.ts') },
        // From the Linux container of pnpm test:ui:linux, which mounts the repository at /work.
        { name: '/work/test/ui/card.ui.test.ts', startTime: 0, endTime: 20_460 },
      ],
    };
    const fresh = reportTimes([report], ROOT);
    expect(fresh).toEqual({ 'test/ui/game.ui.test.ts': 86.5, 'test/ui/new.ui.test.ts': 12, 'test/ui/card.ui.test.ts': 20.5 });
    const merged = refreshed({ 'test/ui/game.ui.test.ts': 80, 'test/ui/v2.ui.test.ts': 58, 'test/ui/gone.ui.test.ts': 9 }, fresh, ['test/ui/game.ui.test.ts', 'test/ui/v2.ui.test.ts', 'test/ui/new.ui.test.ts']);
    expect(merged).toEqual({ 'test/ui/game.ui.test.ts': 86.5, 'test/ui/new.ui.test.ts': 12, 'test/ui/v2.ui.test.ts': 58 });
  });

  it('with the chosen number of parts, no part has much more than its share', () => {
    const p = split(files, times, PARTS);
    const total = p.parts.reduce((s, x) => s + x.seconds, 0);
    const longestFile = Math.max(...files.map((f) => times[f]!));
    expect(Math.max(...p.parts.map((x) => x.seconds))).toBeLessThanOrEqual(Math.max(longestFile, total / PARTS) + 15);
  });
});

const ch = (path: string, status = 'M', lines = 10): Change => ({ path, status, lines });

describe('which jobs a change needs (scripts/ci-changes.ts)', () => {
  it('sorts paths into kinds', () => {
    const cases: [string, string][] = [
      ['.github/workflows/ci.yml', 'all'],
      ['package.json', 'all'],
      ['pnpm-lock.yaml', 'all'],
      ['pnpm-workspace.yaml', 'all'],
      ['docker-compose.test.yml', 'all'],
      ['vitest.config.ts', 'all'],
      ['tsconfig.json', 'all'],
      ['tsconfig.build.json', 'all'],
      ['scripts/ui-split.ts', 'all'],
      ['scripts/README.md', 'all'],
      ['docs/API.md', 'docs'],
      ['docs/design/screen.png', 'docs'],
      ['README.md', 'docs'],
      ['deploy/credit-mint/README.md', 'docs'],
      ['public/docs/index.html', 'docs'],
      ['public/vendor/licenses/phonon-tts-THIRD_PARTY_LICENSES.md', 'web'],
      ['public/v2/app.js', 'web'],
      ['capacitor.config.json', 'web'],
      ['android/app/build.gradle', 'android'],
      ['ios/App/App/AppDelegate.swift', 'ios'],
      ['src/app.ts', 'other'],
      ['test/ui/ways.ts', 'other'],
      ['docker-compose.yml', 'other'],
      ['Dockerfile', 'other'],
      ['services/fedimint-receiver/src/wallet.rs', 'receiver'],
      ['services/fedimint-receiver/Cargo.lock', 'receiver'],
      ['services/fedimint-receiver/Dockerfile', 'receiver'],
      ['services/other-thing/main.rs', 'other'],
      ['docs/FEDIMINT-RECEIVER.md', 'docs'],
    ];
    for (const [p, k] of cases) expect(kindOf(p), p).toBe(k);
  });

  it('runs everything on a push to main, on any event but a pull request, and when the changes cannot be read', () => {
    for (const d of [decide('push', null), decide('push', [ch('docs/API.md')]), decide('workflow_dispatch', null), decide('pull_request', null), decide('pull_request', [])]) {
      expect(d).toMatchObject({ everything: true, e2e: 'all', ui: 'all', android: true, receiver: true, uiParts: Array.from({ length: PARTS }, (_, i) => i + 1) });
    }
    expect(decide('push', [ch('test/ui/game.ui.test.ts')], ctx()).repeat).toEqual([]);
  });

  it('runs everything when the build, the tooling or CI changes, even beside docs', () => {
    for (const p of ['.github/workflows/ci.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'docker-compose.test.yml', 'vitest.config.ts', 'tsconfig.json', 'scripts/android-web.ts']) {
      const d = decide('pull_request', [ch('docs/API.md'), ch(p)]);
      expect(d, p).toMatchObject({ everything: true, e2e: 'all', ui: 'all', android: true, receiver: true });
      expect(d.reasons.join(' ')).toContain(p);
    }
  });

  it("checks a docs-only change with the unit tests and the docs pages' own browser and end to end tests, and skips Android", () => {
    const d = decide('pull_request', [ch('docs/API.md'), ch('README.md'), ch('public/docs/index.html'), ch('docs/modules/fund.md', 'A')]);
    expect(d).toMatchObject({ everything: false, e2e: 'docs', ui: 'docs', android: false, receiver: false, uiParts: ['docs'], repeat: [] });
    expect(outputs(d)).toMatchObject({ e2e: 'docs', ui: 'docs', android: 'false', receiver: 'false', ui_parts: '["docs"]', repeat_count: '0' });
  });

  it('builds and tests the Fedimint receiver only when its directory changes, and nothing else for it alone', () => {
    const alone = decide('pull_request', [ch('services/fedimint-receiver/src/wallet.rs')]);
    expect(alone).toMatchObject({ everything: false, receiver: true, e2e: 'none', ui: 'none', android: false, uiParts: [] });
    expect(outputs(alone)).toMatchObject({ receiver: 'true', e2e: 'none', ui: 'none' });
    expect(summary(alone)).toContain('| receiver | yes |');
    // Its docs page alone is docs; the gateway, the app or the compose file alone do not build it.
    expect(decide('pull_request', [ch('docs/FEDIMINT-RECEIVER.md')]).receiver).toBe(false);
    for (const p of ['src/app.ts', 'public/v2/app.js', 'docker-compose.yml', 'android/app/build.gradle']) {
      expect(decide('pull_request', [ch(p)]).receiver, p).toBe(false);
    }
    // With a gateway change beside it, both run.
    expect(decide('pull_request', [ch('src/app.ts'), ch('services/fedimint-receiver/Cargo.toml')])).toMatchObject({ receiver: true, e2e: 'all', ui: 'all' });
    expect(summary(decide('pull_request', [ch('src/app.ts')]))).toContain('| receiver | skipped |');
  });

  it('runs Android only for android/ or what its bundle is made from', () => {
    expect(decide('pull_request', [ch('src/app.ts')]).android).toBe(false);
    expect(decide('pull_request', [ch('test/e2e/card.e2e.test.ts')]).android).toBe(false);
    expect(decide('pull_request', [ch('ios/App/App/Info.plist')]).android).toBe(false);
    for (const p of ['android/app/src/main/java/com/forgereserve/ai/MainActivity.kt', 'public/v2/app.js', 'public/js/extract.js', 'capacitor.config.json', 'scripts/lib/android-web.ts']) {
      expect(decide('pull_request', [ch('src/app.ts'), ch(p)]).android, p).toBe(true);
    }
  });

  it('skips the browser and end to end tests for a change to the native apps alone', () => {
    const d = decide('pull_request', [ch('android/app/build.gradle'), ch('ios/App/App/NfcPlugin.swift')]);
    expect(d).toMatchObject({ e2e: 'none', ui: 'none', android: true, uiParts: [] });
    expect(outputs(d)).toMatchObject({ ui_parts: '[0]', repeat_count: '0' });
    expect(decide('pull_request', [ch('ios/App/App/NfcPlugin.swift')])).toMatchObject({ e2e: 'none', ui: 'none', android: false });
    // Native and docs together: the docs pages are still checked.
    expect(decide('pull_request', [ch('ios/App/App/NfcPlugin.swift'), ch('docs/IOS.md')])).toMatchObject({ e2e: 'docs', ui: 'docs', android: false });
  });

  it('runs every UI part and the end to end tests for any code, test or web change', () => {
    for (const p of ['src/app.ts', 'public/v2/app.js', 'test/ui/ways.ts', 'test/e2e/helpers.ts', 'config/models.json', 'Dockerfile', 'a-new-top-level-file']) {
      expect(decide('pull_request', [ch(p)]), p).toMatchObject({ e2e: 'all', ui: 'all', uiParts: Array.from({ length: PARTS }, (_, i) => i + 1) });
    }
  });

  it('writes a summary that says what runs and why', () => {
    const s = summary(decide('pull_request', [ch('docs/API.md')]));
    expect(s).toContain('| android | skipped |');
    expect(s).toContain('docs page only');
    expect(s).toContain('ci-ok');
    expect(s).not.toMatch(/\u2014/);
  });

  it('reads git diff output, a rename as a delete and an add', () => {
    const changes = parseDiff('M\tsrc/app.ts\nA\ttest/ui/new.ui.test.ts\nD\ttest/ui/old.ui.test.ts\n', '3\t1\tsrc/app.ts\n40\t0\ttest/ui/new.ui.test.ts\n0\t12\ttest/ui/old.ui.test.ts\n-\t-\tpublic/icon.png\n');
    expect(changes).toEqual([ch('src/app.ts', 'M', 4), ch('test/ui/new.ui.test.ts', 'A', 40), ch('test/ui/old.ui.test.ts', 'D', 12)]);
  });
});

/** A small test/ui: three tests, two helpers (one imports the other), times recorded. */
function ctx(extra: Record<string, string> = {}): Omit<RepeatInput, 'changes'> {
  const src: Record<string, string> = {
    'test/ui/a.ui.test.ts': "import { x } from './ways.ts';\nimport { g } from '../e2e/helpers.ts';",
    'test/ui/b.ui.test.ts': "import { y } from './camera.ts';",
    'test/ui/c.ui.test.ts': "import { describe } from 'vitest';",
    'test/ui/long.ui.test.ts': '',
    'test/ui/ways.ts': "export { y } from './camera.ts';",
    'test/ui/camera.ts': 'export const y = 1;',
    ...extra,
  };
  return {
    uiSources: Object.keys(src),
    read: (p) => src[p] ?? null,
    testFiles: Object.keys(src).filter((p) => p.endsWith('.ui.test.ts')),
    times: { 'test/ui/a.ui.test.ts': 30, 'test/ui/b.ui.test.ts': 40, 'test/ui/c.ui.test.ts': 20, 'test/ui/long.ui.test.ts': 185 },
  };
}
const repeated = (changes: Change[], c = ctx()) => {
  const r = repeatPlan({ ...c, changes });
  const runs: Record<string, number> = {};
  for (const e of r.entries) runs[e.file] = (runs[e.file] ?? 0) + e.runs;
  return { ...r, runs };
};

describe('which changed UI test files run again', () => {
  it('runs each added or changed UI test file 5 more times, and nothing for a deleted one or for other tests', () => {
    const r = repeated([ch('test/ui/a.ui.test.ts', 'A'), ch('test/ui/c.ui.test.ts'), ch('test/ui/gone.ui.test.ts', 'D'), ch('test/e2e/card.e2e.test.ts'), ch('src/app.ts')]);
    expect(REPEATS).toBe(5);
    expect(r.runs).toEqual({ 'test/ui/a.ui.test.ts': 5, 'test/ui/c.ui.test.ts': 5 });
  });

  it('runs again the test files that import a changed helper, directly or through another helper', () => {
    expect(repeated([ch('test/ui/ways.ts')]).runs).toEqual({ 'test/ui/a.ui.test.ts': 5 });
    const r = repeated([ch('test/ui/camera.ts')]);
    expect(r.runs).toEqual({ 'test/ui/a.ui.test.ts': 5, 'test/ui/b.ui.test.ts': 5 });
    expect(r.notes.join(' ')).toContain('test/ui/camera.ts is a helper');
    expect(repeated([ch('test/ui/timings.json')]).runs).toEqual({});
  });

  it('finds relative imports, exports and dynamic imports', () => {
    expect(importsOf('test/ui/x.ts', "import a from './a.ts';\nexport { b } from '../support/b.ts';\nconst c = await import('./c.ts');\nimport './d.ts';\nimport e from 'vitest';").sort()).toEqual(['test/support/b.ts', 'test/ui/a.ts', 'test/ui/c.ts', 'test/ui/d.ts']);
  });

  it(`runs at most ${MAX_REPEAT_FILES} files again, those changed themselves first and then the largest diff, and says which were left out`, () => {
    const extra: Record<string, string> = {};
    const changes: Change[] = [ch('test/ui/camera.ts', 'M', 500)];
    for (let i = 1; i <= 8; i++) {
      extra[`test/ui/f${i}.ui.test.ts`] = '';
      changes.push(ch(`test/ui/f${i}.ui.test.ts`, 'M', i * 10));
    }
    const r = repeated(changes, ctx(extra));
    expect(Object.keys(r.runs).sort()).toEqual(['test/ui/f3.ui.test.ts', 'test/ui/f4.ui.test.ts', 'test/ui/f5.ui.test.ts', 'test/ui/f6.ui.test.ts', 'test/ui/f7.ui.test.ts', 'test/ui/f8.ui.test.ts']);
    expect(r.notes.join(' ')).toContain('Not run again: test/ui/f2.ui.test.ts, test/ui/f1.ui.test.ts, test/ui/a.ui.test.ts, test/ui/b.ui.test.ts');
  });

  it("spreads a long file's runs over several jobs, always 5 runs in all", () => {
    const r = repeated([ch('test/ui/long.ui.test.ts'), ch('test/ui/new.ui.test.ts', 'A')], ctx({ 'test/ui/new.ui.test.ts': '' }));
    expect(r.runs).toEqual({ 'test/ui/long.ui.test.ts': 5, 'test/ui/new.ui.test.ts': 5 });
    const long = r.entries.filter((e) => e.file === 'test/ui/long.ui.test.ts');
    expect(long.length).toBeGreaterThan(1);
    expect(long.map((e) => e.label)).toEqual(long.map((_, i) => `long.ui.test.ts ${i + 1}/${long.length}`));
    expect(r.entries.find((e) => e.file === 'test/ui/new.ui.test.ts')).toEqual({ file: 'test/ui/new.ui.test.ts', runs: 5, label: 'new.ui.test.ts' });
  });

  it('leaves a file with an unusual name to the normal run', () => {
    const r = repeated([ch('test/ui/we ird.ui.test.ts'), ch('test/ui/$(x).ui.test.ts')], ctx({ 'test/ui/we ird.ui.test.ts': '', 'test/ui/$(x).ui.test.ts': '' }));
    expect(r.entries).toEqual([]);
    expect(r.notes).toHaveLength(2);
  });

  it('repeats only on a pull request that runs the UI parts, and the matrix is never empty', () => {
    const pr = decide('pull_request', [ch('test/ui/a.ui.test.ts')], ctx());
    expect(pr.repeat.length).toBeGreaterThan(0);
    expect(JSON.parse(outputs(pr).repeat)).toEqual(pr.repeat);
    expect(outputs(pr).repeat_count).toBe(String(pr.repeat.length));
    // A global change still repeats the changed UI file.
    expect(decide('pull_request', [ch('package.json'), ch('test/ui/a.ui.test.ts')], ctx()).repeat.length).toBeGreaterThan(0);
    const none = decide('pull_request', [ch('src/app.ts')], ctx());
    expect(JSON.parse(outputs(none).repeat)).toEqual([{ file: '', runs: 0, label: 'none' }]);
    expect(outputs(none).repeat_count).toBe('0');
  });
});

describe('ci-ok, the one check to require', () => {
  const changes = (o: Record<string, string>) => ({ result: 'success', outputs: { e2e: 'all', ui: 'all', android: 'true', receiver: 'true', repeat_count: '0', ...o } });
  const all = (r: string) => ({ check: { result: r }, e2e: { result: r }, ui: { result: r }, android: { result: r }, receiver: { result: r }, repeat: { result: r } });

  it('passes when every job passed', () => {
    expect(verdict({ changes: changes({ repeat_count: '2' }), ...all('success') }).ok).toBe(true);
  });

  it('passes when the jobs a change does not need were skipped by the rules', () => {
    const v = verdict({ changes: changes({ e2e: 'docs', ui: 'docs', android: 'false', receiver: 'false' }), ...all('success'), android: { result: 'skipped' }, receiver: { result: 'skipped' }, repeat: { result: 'skipped' } });
    expect(v.ok).toBe(true);
    expect(v.lines).toContain('android: skipped by the rules (not needed for this change)');
    expect(v.lines).toContain('receiver: skipped by the rules (not needed for this change)');
  });

  it('fails when a needed job failed, was cancelled or was skipped', () => {
    for (const r of ['failure', 'cancelled', 'skipped']) {
      for (const job of ['check', 'e2e', 'ui', 'android', 'receiver']) expect(verdict({ changes: changes({}), ...all('success'), [job]: { result: r } }).ok, `${job} ${r}`).toBe(false);
      expect(verdict({ changes: changes({ repeat_count: '1' }), ...all('success'), repeat: { result: r } }).ok).toBe(false);
    }
  });

  it('fails when the rules did not run, whatever the other jobs did', () => {
    expect(verdict({ changes: { result: 'failure' }, ...all('skipped') }).ok).toBe(false);
    expect(verdict({ changes: { result: 'failure' }, ...all('success') }).ok).toBe(false);
    expect(verdict({}).ok).toBe(false);
  });

  it('fails a job that failed even when the rules did not need it', () => {
    expect(verdict({ changes: changes({ android: 'false' }), ...all('success'), android: { result: 'failure' } }).ok).toBe(false);
    expect(verdict({ changes: changes({ receiver: 'false' }), ...all('success'), receiver: { result: 'failure' } }).ok).toBe(false);
  });
});

describe('the CI workflow uses these rules', () => {
  const ci = read('.github/workflows/ci.yml');
  const job = (name: string) => {
    const m = new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [\\w-]+:\\n|(?![\\s\\S]))`, 'm').exec(ci);
    if (!m) throw new Error(`no job ${name}`);
    return m[1]!;
  };

  it('decides first, gates every heavy job on it and ends with ci-ok, which needs every job and always runs', () => {
    expect(job('changes')).toContain('run: node scripts/ci-changes.ts');
    expect(job('changes')).toContain('fetch-depth: 2');
    expect(job('check')).not.toContain('needs:');
    expect(job('e2e')).toContain("if: needs.changes.outputs.e2e != 'none'");
    expect(job('ui')).toContain("if: needs.changes.outputs.ui != 'none'");
    expect(job('ui')).toContain('part: ${{ fromJSON(needs.changes.outputs.ui_parts) }}');
    expect(job('android')).toContain("if: needs.changes.outputs.android == 'true'");
    expect(job('receiver')).toContain("if: needs.changes.outputs.receiver == 'true'");
    expect(job('changes')).toContain('receiver: ${{ steps.rules.outputs.receiver }}');
    expect(job('repeat')).toContain("if: github.event_name == 'pull_request' && needs.changes.outputs.repeat_count != '0'");
    expect(job('repeat')).toContain('include: ${{ fromJSON(needs.changes.outputs.repeat) }}');
    const ok = job('ci-ok');
    expect(ok).toContain('if: always()');
    expect(ok).toContain('needs: [changes, check, e2e, ui, android, receiver, repeat]');
    expect(ok).toContain('NEEDS: ${{ toJSON(needs) }}');
    expect(ok).toContain('run: node scripts/ci-changes.ts verdict');
  });

  it('runs each UI part from the split, checks the split covers every file, and keeps the times', () => {
    expect(job('ui')).toContain('FILES=$(node scripts/ui-split.ts files "$PART")');
    expect(job('ui')).toContain('--reporter=json --outputFile.json="$RUNNER_TEMP/ui-times/ui-part-$PART.json"');
    expect(job('ui')).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40} # v\d/);
    expect(job('check')).toContain('run: node scripts/ui-split.ts verify');
  });

  it('starts the mints in the background with the Docker Hub retry, as pnpm mint:up does, in every job that needs them', () => {
    const script = read('scripts/ci-mints.sh');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['mint:up']).toBe('docker compose -f docker-compose.test.yml up -d --wait');
    expect(script).toContain('COMPOSE=(docker compose -f docker-compose.test.yml)');
    expect(script).toContain('"${COMPOSE[@]}" up -d --wait');
    expect(script).toMatch(/for i in 1 2 3; do[\s\S]*sleep \$\(\(i \* 15\)\)/);
    for (const name of ['e2e', 'ui', 'repeat']) {
      const j = job(name);
      expect(j, name).toContain('run: scripts/ci-mints.sh start');
      expect(j, name).toContain('run: scripts/ci-mints.sh wait');
      expect(j.indexOf('ci-mints.sh start'), name).toBeLessThan(j.indexOf('pnpm install --frozen-lockfile'));
      expect(j.indexOf('ci-mints.sh wait'), name).toBeLessThan(j.indexOf('vitest run'));
    }
  });

  it('runs a docs-only change through the docs pages alone, by exact file', () => {
    expect(job('e2e')).toContain('pnpm exec vitest run test/e2e/docs.e2e.test.ts');
    expect(job('ui')).toContain('pnpm exec vitest run test/ui/docs.ui.test.ts');
    expect(existsSync(join(ROOT, 'test/e2e/docs.e2e.test.ts'))).toBe(true);
    expect(existsSync(join(ROOT, 'test/ui/docs.ui.test.ts'))).toBe(true);
  });

  it('checks the Fedimint receiver with fmt, clippy and its tests, in its own directory, with the dependency build cached by its lockfile', () => {
    const j = job('receiver');
    expect(j).toContain('working-directory: services/fedimint-receiver');
    for (const step of ['cargo fmt --check', 'cargo clippy --profile ci --locked --all-targets -- -D warnings', 'cargo test --profile ci --locked']) expect(j, step).toContain(step);
    expect(j).toMatch(/uses: actions\/cache@[0-9a-f]{40} # v\d/);
    expect(j).toContain("hashFiles('services/fedimint-receiver/Cargo.lock'");
    expect(existsSync(join(ROOT, 'services/fedimint-receiver/Cargo.lock'))).toBe(true);
  });
});
