import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8');

/** A readable version tag plus the registry digest that decides what is pulled. */
const PINNED = /^[a-z0-9][a-z0-9._/-]*:[A-Za-z0-9][A-Za-z0-9._-]*@sha256:[0-9a-f]{64}$/;

function references(): { file: string; ref: string }[] {
  const out: { file: string; ref: string }[] = [];
  for (const line of read('Dockerfile').split('\n')) {
    const m = /^FROM\s+(\S+)/i.exec(line.trim());
    if (m) out.push({ file: 'Dockerfile', ref: m[1]! });
  }
  for (const file of ['docker-compose.yml', 'docker-compose.test.yml', 'deploy/credit-mint/docker-compose.yml']) {
    for (const line of read(file).split('\n')) {
      const m = /^\s*image:\s*(\S+)/.exec(line);
      if (m) out.push({ file, ref: m[1]!.replace(/^["']|["']$/g, '') });
    }
  }
  // The Linux image the UI tests run in on a Mac (pnpm test:ui:linux).
  for (const m of read('scripts/ui-linux.sh').matchAll(/^IMAGE=(\S+)$/gm)) out.push({ file: 'scripts/ui-linux.sh', ref: m[1]! });
  for (const file of ['docs/ADMIN.md', '.env.example']) {
    for (const m of read(file).matchAll(/docker run (?:--?\S+ )*(\S+:\S+)/g)) out.push({ file, ref: m[1]! });
  }
  return out;
}

describe('container images (report section 9)', () => {
  it('finds the image references it guards', () => {
    const files = new Set(references().map((r) => r.file));
    expect(files).toEqual(new Set(['Dockerfile', 'docker-compose.yml', 'docker-compose.test.yml', 'deploy/credit-mint/docker-compose.yml', 'docs/ADMIN.md', '.env.example', 'scripts/ui-linux.sh']));
  });

  it('pins every image to a version and a digest, never a moving tag alone', () => {
    for (const { file, ref } of references()) expect(ref, `${file}: ${ref}`).toMatch(PINNED);
  });

  it('builds both Dockerfile stages from the same base image', () => {
    const froms = references().filter((r) => r.file === 'Dockerfile');
    expect(froms).toHaveLength(2);
    expect(new Set(froms.map((r) => r.ref)).size).toBe(1);
  });
});

describe('CI workflow', () => {
  const ci = read('.github/workflows/ci.yml');

  it('pins every action by commit and grants no permission by default', () => {
    const uses = [...ci.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]!);
    expect(uses.length).toBeGreaterThan(0);
    for (const u of uses) expect(u).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/);
    expect(ci).toMatch(/^permissions: \{\}$/m);
    expect(ci.match(/^ {6}contents: (\w+)$/gm)).toEqual(['      contents: read', '      contents: read', '      contents: read', '      contents: read']);
  });

  it('runs read-only, without credentials, and covers every suite', () => {
    expect(ci).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ci).not.toMatch(/persist-credentials: true/);
    for (const step of ['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm mint:up', 'pnpm test:e2e', 'pnpm test:ui', './gradlew assembleUniversalDebug assemblePrivatevoiceDebug testUniversalDebugUnitTest testPrivatevoiceDebugUnitTest']) {
      expect(ci, step).toContain(step);
    }
    // Both APKs are checked for 16 KB pages, and the universal one for carrying no speech to text model.
    expect(ci).toContain('app/build/outputs/apk/universal/debug/app-universal-debug.apk app/build/outputs/apk/privatevoice/debug/app-privatevoice-debug.apk');
    expect(ci).toMatch(/zipalign[\s\S]*-c -P 16/);
  });

  it('runs the UI suite in parallel parts that together cover every file', () => {
    // The natural voice's file on its own, and every other file in one of the --shard parts.
    expect(ci).toMatch(/^ {8}part: \[voice, 1\/2, 2\/2\]$/m);
    expect(ci).toContain('pnpm test:ui --exclude test/ui/phonon.ui.test.ts --shard="$PART"');
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['test:ui:voice']).toBe('vitest run test/ui/phonon.ui.test.ts');
    expect(ci).toContain('pnpm test:ui:voice');
    // Every job has a time limit, so a hung browser fails in minutes rather than hours.
    expect(ci.match(/^ {2}\w+:\n {4}runs-on:/gm)?.length).toBe(ci.match(/^ {4}timeout-minutes: \d+$/gm)?.length);
  });
});
