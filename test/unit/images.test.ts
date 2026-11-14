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
  for (const file of ['docs/ADMIN.md', '.env.example']) {
    for (const m of read(file).matchAll(/docker run (?:--?\S+ )*(\S+:\S+)/g)) out.push({ file, ref: m[1]! });
  }
  return out;
}

describe('container images (report section 9)', () => {
  it('finds the image references it guards', () => {
    const files = new Set(references().map((r) => r.file));
    expect(files).toEqual(new Set(['Dockerfile', 'docker-compose.yml', 'docker-compose.test.yml', 'deploy/credit-mint/docker-compose.yml', 'docs/ADMIN.md', '.env.example']));
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
    expect(ci.match(/^ {6}contents: (\w+)$/gm)).toEqual(['      contents: read', '      contents: read', '      contents: read']);
  });

  it('runs read-only, without credentials, and covers every suite', () => {
    expect(ci).not.toMatch(/\$\{\{\s*secrets\./);
    expect(ci).not.toMatch(/persist-credentials: true/);
    for (const step of ['pnpm install --frozen-lockfile', 'pnpm typecheck', 'pnpm test', 'pnpm mint:up', 'pnpm test:e2e', 'pnpm test:ui', './gradlew assembleDebug testDebugUnitTest']) {
      expect(ci, step).toContain(step);
    }
  });
});
