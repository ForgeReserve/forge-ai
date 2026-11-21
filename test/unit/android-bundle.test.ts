// scripts/android-bundle.sh: Forge's Play app bundle, signed with an upload key the owner supplies; it never
// makes or prints a key or a password. The real build needs a keystore, so here Gradle is a stand-in in a
// copy of the script's surroundings (docs/ANDROID.md, Google Play).
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '..', '..');
const SCRIPT = resolve(ROOT, 'scripts/android-bundle.sh');
const src = readFileSync(SCRIPT, 'utf8');
/** The environment without any upload key settings the person running the tests may have. */
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('FORGE_UPLOAD_')));
const run = (args: string[], input = '', env: Record<string, string> = {}, script = SCRIPT) =>
  spawnSync('bash', [script, ...args], { input, encoding: 'utf8', cwd: ROOT, timeout: 20_000, env: { ...cleanEnv(), ...env } });
/** A file standing in for a keystore, outside the repository; the script only checks that it is there. */
const fakeKeystore = () => {
  const f = join(mkdtempSync(join(tmpdir(), 'forge-bundle-')), 'upload.jks');
  writeFileSync(f, 'not a keystore');
  return f;
};

describe('the Play bundle script', () => {
  it('is valid bash that stops on the first error', () => {
    expect(spawnSync('bash', ['-n', SCRIPT]).status).toBe(0);
    expect(src).toMatch(/^set -euo pipefail$/m);
  });

  it('builds nothing without a keystore, from the options or the environment', () => {
    const none = run([], '\n');
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('No keystore given. Nothing was built.');
    const missing = run(['--keystore', '/nonexistent/upload.jks']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('No keystore at /nonexistent/upload.jks. Nothing was built.');
    const fromEnv = run([], '', { FORGE_UPLOAD_KEYSTORE: '/nonexistent/env.jks' });
    expect(fromEnv.status).toBe(1);
    expect(fromEnv.stderr).toContain('No keystore at /nonexistent/env.jks.');
    expect(run(['--nope']).status).toBe(2);
  });

  it('refuses a keystore kept inside the repository', () => {
    for (const r of [run(['--keystore', resolve(ROOT, 'package.json')]), run([], '', { FORGE_UPLOAD_KEYSTORE: resolve(ROOT, 'package.json') })]) {
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('inside the repository');
    }
  });

  it('builds nothing without an alias or a password', () => {
    const ks = fakeKeystore();
    const noAlias = run(['--keystore', ks], '\n');
    expect(noAlias.status).toBe(1);
    expect(noAlias.stderr).toContain('No key alias given. Nothing was built.');
    const noPassword = run(['--keystore', ks, '--alias', 'upload'], '\n');
    expect(noPassword.status).toBe(1);
    expect(noPassword.stderr).toContain('No keystore password given. Nothing was built.');
  });

  it('never makes a key, and never puts a password in an argument or on the screen', () => {
    const code = src.replace(/^\s*#.*$/gm, '');
    expect(code).not.toMatch(/keytool -genkey|genkeypair|-storepass|-keypass|--ks-pass|--key-pass/);
    // Asked without echo when it is not in the environment, then handed to Gradle through the environment only.
    expect(code).toMatch(/read -r -s -p "Keystore password \(not shown\): " FORGE_UPLOAD_STORE_PASSWORD/);
    expect(code).toMatch(/export FORGE_UPLOAD_KEYSTORE="\$KEYSTORE" FORGE_UPLOAD_KEY_ALIAS="\$ALIAS" FORGE_UPLOAD_STORE_PASSWORD$/m);
    for (const line of code.split('\n').filter((l) => /\becho\b|printf/.test(l))) expect(line).not.toMatch(/PASSWORD/);
    expect(code).not.toMatch(/set -x/);
  });

  it('builds the universal bundle only, and writes it outside git (dist/)', () => {
    expect(src).toContain('./gradlew --console=plain -q clean bundleUniversalRelease');
    expect(src.replace(/^\s*#.*$/gm, '')).not.toMatch(/privatevoice/i);
    expect(src).toContain('OUT="$ROOT/dist/forge-$VERSION.aab"');
    expect(readFileSync(resolve(ROOT, '.gitignore'), 'utf8')).toMatch(/^dist$/m);
    // What it prints: the path, size, versionCode, SHA-256 and the upload certificate.
    for (const label of ['Signed:', 'Size:', 'versionCode:', 'SHA-256:', 'Upload cert:']) expect(src).toContain(`echo "${label}`);
  });

  describe('with Gradle stood in for', () => {
    /** A copy of the script in a tree of its own, whose android/gradlew records what it was given. */
    const tree = (gradlew: string) => {
      const dir = mkdtempSync(join(tmpdir(), 'forge-bundle-tree-'));
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, 'android/app'), { recursive: true });
      copyFileSync(SCRIPT, join(dir, 'scripts/android-bundle.sh'));
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '9.8.7' }));
      writeFileSync(join(dir, 'android/app/build.gradle'), 'android {\n    defaultConfig {\n        versionCode 42\n    }\n}\n');
      writeFileSync(join(dir, 'android/gradlew'), `#!/usr/bin/env bash\nset -eu\nD="$(cd "$(dirname "$0")" && pwd)"\necho "$*" > "$D/args"\nprintf '%s' "$FORGE_UPLOAD_STORE_PASSWORD" > "$D/pass"\nprintf '%s|%s' "$FORGE_UPLOAD_KEYSTORE" "$FORGE_UPLOAD_KEY_ALIAS" > "$D/key"\n${gradlew}\n`);
      chmodSync(join(dir, 'android/gradlew'), 0o755);
      return dir;
    };
    const secret = 'pass-7f3a-do-not-print';

    it('hands Gradle the key by its environment, and never shows the password it was typed', () => {
      const dir = tree('echo "gradle stand-in: no bundle" >&2; exit 1');
      const ks = fakeKeystore();
      const r = run(['--keystore', ks, '--alias', 'upload'], `${secret}\n`, {}, join(dir, 'scripts/android-bundle.sh'));
      expect(r.status).not.toBe(0);
      expect(r.stdout).toContain('Building the Play bundle (version 9.8.7, versionCode 42).');
      expect(readFileSync(join(dir, 'android/args'), 'utf8').trim()).toBe('--console=plain -q clean bundleUniversalRelease');
      expect(readFileSync(join(dir, 'android/pass'), 'utf8')).toBe(secret);
      expect(readFileSync(join(dir, 'android/key'), 'utf8')).toBe(`${ks}|upload`);
      expect(r.stdout + r.stderr).not.toContain(secret);
    });

    it('takes the password from the environment without asking, and does not print it', () => {
      const dir = tree('exit 1');
      const r = run([], '', { FORGE_UPLOAD_KEYSTORE: fakeKeystore(), FORGE_UPLOAD_KEY_ALIAS: 'upload', FORGE_UPLOAD_STORE_PASSWORD: secret }, join(dir, 'scripts/android-bundle.sh'));
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain('Keystore password');
      expect(readFileSync(join(dir, 'android/pass'), 'utf8')).toBe(secret);
      expect(r.stdout + r.stderr).not.toContain(secret);
    });

    // Needs a JDK's jarsigner (CI's runners have one) and zip.
    const tools = spawnSync('bash', ['-c', 'command -v "${JAVA_HOME:+$JAVA_HOME/bin/}jarsigner" && command -v zip']).status === 0;
    it.skipIf(!tools)('refuses a bundle that is not signed and writes nothing to dist/', () => {
      // The stand-in makes an unsigned zip where Gradle puts the bundle.
      const dir = tree('O="$D/app/build/outputs/bundle/universalRelease"; mkdir -p "$O"; cd "$O"; echo x > a.txt; zip -q app-universal-release.aab a.txt');
      const r = run([], '', { FORGE_UPLOAD_KEYSTORE: fakeKeystore(), FORGE_UPLOAD_KEY_ALIAS: 'upload', FORGE_UPLOAD_STORE_PASSWORD: secret }, join(dir, 'scripts/android-bundle.sh'));
      expect(existsSync(join(dir, 'android/app/build/outputs/bundle/universalRelease/app-universal-release.aab'))).toBe(true);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('is not signed. Nothing was written to dist/.');
      expect(existsSync(join(dir, 'dist'))).toBe(false);
    });
  });
});
