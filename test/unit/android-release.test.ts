// scripts/android-release.sh: signs with a keystore the owner supplies and never makes or holds a key.
// The signing itself needs the owner's keystore, so it is not run here (docs/ANDROID.md).
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = resolve(ROOT, 'scripts/android-release.sh');
const src = readFileSync(SCRIPT, 'utf8');
const run = (args: string[], input = '') => spawnSync('bash', [SCRIPT, ...args], { input, encoding: 'utf8', cwd: ROOT, timeout: 20_000 });

describe('the release script', () => {
  it('is valid bash that stops on the first error', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    expect(src).toMatch(/^set -euo pipefail$/m);
  });

  it('builds nothing without a keystore', () => {
    const none = run([], '\n');
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('No keystore given. Nothing was built.');
    const missing = run(['--keystore', '/nonexistent/forge.jks']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('No keystore at /nonexistent/forge.jks. Nothing was built.');
  });

  it('refuses a keystore kept inside the repository', () => {
    const r = run(['--keystore', resolve(ROOT, 'package.json')]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('inside the repository');
  });

  it('never makes a key or handles the password itself', () => {
    const code = src.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/keytool|genkey/);
    expect(code).not.toMatch(/--ks-pass|--key-pass|pass:|\$\{?\w*PASS/i);
    expect(code).not.toMatch(/storePassword|keyPassword/);
    // apksigner signs, and the result is checked and its hashes printed.
    expect(code).toMatch(/apksigner" sign "\$\{SIGN\[@\]\}" --out/);
    expect(code).toMatch(/apksigner" verify --print-certs/);
    expect(code).toMatch(/shasum -a 256/);
  });

  it('writes the signed APK outside git (dist/)', () => {
    expect(src).toContain('OUT="$ROOT/dist/forge-$VERSION.apk"');
    expect(readFileSync(resolve(ROOT, '.gitignore'), 'utf8')).toMatch(/^dist$/m);
  });
});
