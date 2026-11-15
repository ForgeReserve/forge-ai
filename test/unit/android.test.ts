// The Android app's project files (android/): what the APK may do and carry. The build itself is
// checked by `cd android && ./gradlew assembleDebug testDebugUnitTest`.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleFiles, inBundle, readConfig, writeBundle } from '../../scripts/lib/android-web.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
/** The file without its comments, so a comment that says "no Firebase" does not count as Firebase. */
const code = (p: string) => read(p).replace(/<!--[\s\S]*?-->/g, '').replace(/^\s*\/\/.*$/gm, '');
const manifest = read('android/app/src/main/AndroidManifest.xml');
const gradleFiles = ['android/build.gradle', 'android/app/build.gradle', 'android/settings.gradle', 'android/variables.gradle'];

describe('Android app project', () => {
  it('is com.forgereserve.ai, named Forge, for Android 9 and up', () => {
    const app = read('android/app/build.gradle');
    expect(app).toMatch(/applicationId "com\.forgereserve\.ai"/);
    expect(read('android/variables.gradle')).toMatch(/minSdkVersion = 28\b/);
    expect(read('android/app/src/main/res/values/strings.xml')).toContain('<string name="app_name">Forge</string>');
    expect(readConfig(join(ROOT, 'capacitor.config.json'))).toMatchObject({ appId: 'com.forgereserve.ai', appName: 'Forge' });
  });

  it('has no Google services, no Firebase and no analytics', () => {
    const banned = /google-services|com\.google\.gms|com\.google\.firebase|firebase|crashlytics|analytics|play-services|com\.android\.installreferrer/i;
    for (const f of gradleFiles) expect(code(f), f).not.toMatch(banned);
    expect(code('android/app/src/main/AndroidManifest.xml')).not.toMatch(banned);
    expect(existsSync(join(ROOT, 'android/app/google-services.json'))).toBe(false);
    // The Capacitor runtime it builds on brings none either.
    expect(readFileSync(join(ROOT, 'node_modules/@capacitor/android/capacitor/build.gradle'), 'utf8')).not.toMatch(banned);
  });

  it('asks only for what it uses, and treats camera, microphone and NFC as optional', () => {
    const perms = [...manifest.matchAll(/<uses-permission android:name="([^"]+)"/g)].map((m) => m[1]).sort();
    expect(perms).toEqual(['android.permission.CAMERA', 'android.permission.INTERNET', 'android.permission.MODIFY_AUDIO_SETTINGS', 'android.permission.NFC', 'android.permission.RECORD_AUDIO', 'android.permission.VIBRATE']);
    for (const f of ['android.hardware.camera', 'android.hardware.microphone', 'android.hardware.nfc']) {
      expect(manifest).toMatch(new RegExp(`<uses-feature android:name="${f.replaceAll('.', '\\.')}" android:required="false" />`));
    }
    expect(manifest).not.toMatch(/required="true"/);
  });

  it('keeps nothing in backups and talks to the engine over HTTPS only', () => {
    expect(manifest).toContain('android:allowBackup="false"');
    expect(manifest).toContain('android:usesCleartextTraffic="false"');
    // Nothing to Google from the WebView: no Safe Browsing checks, no usage metrics.
    expect(manifest).toContain('<meta-data android:name="android.webkit.WebView.EnableSafeBrowsing" android:value="false" />');
    expect(manifest).toContain('<meta-data android:name="android.webkit.WebView.MetricsOptOut" android:value="true" />');
    const rules = read('android/app/src/main/res/xml/data_extraction_rules.xml');
    expect(rules.match(/<exclude /g)?.length).toBe(10);
    expect(readConfig(join(ROOT, 'capacitor.config.json'))).toMatchObject({ loggingBehavior: 'none', android: { allowMixedContent: false } });
  });

  it('receives shared photos, and lets other apps read only what it hands them', () => {
    expect(manifest).toMatch(/<action android:name="android\.intent\.action\.SEND" \/>\s*<category android:name="android\.intent\.category\.DEFAULT" \/>\s*<data android:mimeType="image\/\*" \/>/);
    expect(manifest).not.toContain('SEND_MULTIPLE');
    const paths = read('android/app/src/main/res/xml/file_paths.xml');
    expect([...paths.matchAll(/path="([^"]*)"/g)].map((m) => m[1])).toEqual(['shared-out/', 'Pictures/']);
    expect(manifest).toMatch(/android:exported="false"\s+android:grantUriPermissions="true"/);
  });

  it('never commits a signing key and signs nothing in the build', () => {
    expect(read('android/.gitignore')).toMatch(/\*\.jks[\s\S]*\*\.keystore/);
    expect(read('android/app/build.gradle')).not.toMatch(/signingConfig|storePassword|keyPassword/);
  });
});

describe('the web bundle in the APK', () => {
  const PUBLIC = join(ROOT, 'public');

  it('carries the v2 app and what it imports, never v1, admin, beta or the website pages', () => {
    for (const p of ['v2/app.js', 'v2/core/engine.js', 'v2/strings/en.js', 'js/ui.js', 'js/files.js', 'vendor/tinfoil.js', 'vendor/face-api/face-api.js', 'icons/icon-192.png', 'icon.svg']) {
      expect(existsSync(join(PUBLIC, p)), p).toBe(true);
      expect(inBundle(p), p).toBe(true);
    }
    for (const p of ['index.html', 'app.js', 'sw.js', 'style.css', 'offline.html', 'manifest.webmanifest', 'theme.js', 'admin/index.html', 'beta/index.html', 'v2/free/index.html', 'v2/free/free.js', 'v2/download/index.html', 'v2/sw.js']) {
      expect(inBundle(p), p).toBe(false);
    }
    const files = bundleFiles(PUBLIC);
    expect(files).toContain('v2/app.js');
    expect(files.some((f) => !inBundle(f))).toBe(false);
    // The vendored libraries' licences go with them.
    expect(files.filter((f) => f.startsWith('vendor/licenses/')).length).toBeGreaterThan(0);
  });

  it('every module the v2 app imports is in the bundle', () => {
    const files = new Set(bundleFiles(PUBLIC));
    const missing: string[] = [];
    let checked = 0;
    for (const f of files) {
      if (!f.endsWith('.js') || f.startsWith('vendor/')) continue;
      const src = readFileSync(join(PUBLIC, f), 'utf8');
      for (const m of src.matchAll(/(?:import\s[^'"]*|import\(|loadScript\()\s*['"]([./][^'"]+)['"]/g)) {
        const spec = m[1]!;
        const target = spec.startsWith('/') ? spec.slice(1) : join(f, '..', spec).split('\\').join('/');
        checked++;
        if (!files.has(target)) missing.push(`${f} -> ${spec}`);
      }
    }
    expect(missing).toEqual([]);
    expect(checked).toBeGreaterThan(100);
  });

  it('writes the v2 page as the start page, the runtime config and no npm plugins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-android-'));
    const r = writeBundle(PUBLIC, dir, readConfig(join(ROOT, 'capacitor.config.json')));
    expect(readFileSync(join(dir, 'public/index.html'), 'utf8')).toBe(readFileSync(join(PUBLIC, 'v2/index.html'), 'utf8'));
    expect(existsSync(join(dir, 'public/v2/app.js'))).toBe(true);
    expect(existsSync(join(dir, 'public/app.js'))).toBe(false);
    const cfg = JSON.parse(readFileSync(join(dir, 'capacitor.config.json'), 'utf8'));
    expect(cfg.appId).toBe('com.forgereserve.ai');
    expect(cfg.webDir).toBeUndefined();
    expect(readFileSync(join(dir, 'capacitor.plugins.json'), 'utf8').trim()).toBe('[]');
    expect(r.files).toBe(bundleFiles(PUBLIC).length + 1);
    // Small enough to install over a slow connection, apart from the natural voice (about 67 MB),
    // which the app carries so it reads aloud offline from the first open.
    expect(r.bytes - r.voiceBytes).toBeLessThan(30 * 1024 * 1024);
    if (existsSync(join(PUBLIC, 'v2/voice/phonon/index.json'))) {
      const index = JSON.parse(readFileSync(join(PUBLIC, 'v2/voice/phonon/index.json'), 'utf8'));
      for (const f of index.files) expect(existsSync(join(dir, 'public/v2/voice/phonon', f.path)), f.path).toBe(true);
      expect(r.voiceBytes).toBe(index.files.reduce((s: number, f: any) => s + f.size, 0) + statSync(join(PUBLIC, 'v2/voice/phonon/index.json')).size);
    }
    // The voice package, which the app imports from its own files.
    expect(existsSync(join(dir, 'public/v2/vendor/phonon-tts/worker.js'))).toBe(true);
  });

  it('removes files that left public/ on the next bundle', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-android-'));
    writeBundle(PUBLIC, dir, readConfig(join(ROOT, 'capacitor.config.json')));
    const stale = join(dir, 'public/v2/old.js');
    writeFileSync(stale, 'x');
    writeBundle(PUBLIC, dir, readConfig(join(ROOT, 'capacitor.config.json')));
    expect(existsSync(stale)).toBe(false);
    expect(statSync(join(dir, 'public/index.html')).isFile()).toBe(true);
  });

  it('refuses a config for another app id', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-android-'));
    const f = join(dir, 'c.json');
    writeFileSync(f, JSON.stringify({ appId: 'com.example.other', appName: 'X' }));
    expect(() => readConfig(f)).toThrow(/appId/);
  });
});

describe("the native natural voice's libraries (scripts/android-ptts.sh)", () => {
  const lock = JSON.parse(read('scripts/ptts/lock.json'));
  const libs = join(ROOT, 'android/app/src/main/jniLibs');

  it('are the ones built from the pinned xn-ptts commit, byte for byte', () => {
    expect(lock).toMatchObject({ repo: 'https://github.com/gradium-ai/xn-ptts', tag: 'v0.7.0', commit: '32c1554a8ce442d672de90fc82700bbdcf08d918', license: 'MIT OR Apache-2.0' });
    expect(read('scripts/android-ptts.sh')).toContain(`COMMIT=${lock.commit}`);
    for (const f of lock.files) {
      const b = readFileSync(join(libs, f.name));
      expect(b.length, f.name).toBe(f.size);
      expect(createHash('sha256').update(b).digest('hex'), f.name).toBe(f.sha256);
    }
    // Nothing else: every native file in the APK is in the lock.
    const all = readdirSync(libs, { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => `${d.parentPath.slice(libs.length + 1)}/${d.name}`).sort();
    expect(all).toEqual(lock.files.map((f: any) => f.name).sort());
  });

  it('are 64-bit ARM with a placeholder for every other ABI, so the app still installs on 32-bit and x86 phones', () => {
    const abis = readdirSync(libs).sort();
    expect(abis).toEqual(['arm64-v8a', 'armeabi-v7a', 'x86', 'x86_64']);
    // ELF, and the machine each folder says (183 aarch64, 40 arm, 3 x86, 62 x86-64).
    const machine = { 'arm64-v8a': 183, 'armeabi-v7a': 40, x86: 3, x86_64: 62 } as Record<string, number>;
    for (const f of lock.files) {
      const b = readFileSync(join(libs, f.name));
      expect(b.subarray(0, 4).toString('latin1')).toBe('\x7fELF');
      expect(b.readUInt16LE(18), f.name).toBe(machine[f.name.split('/')[0]]);
    }
  });

  it('run in a voice process of their own, which no other app can reach', () => {
    expect(manifest).toMatch(/<service\s+android:name="\.VoiceService"\s+android:process=":voice"\s+android:exported="false" \/>/);
    expect(read('android/app/src/main/java/com/forgereserve/ai/MainActivity.kt')).toContain('registerPlugin(VoicePlugin::class.java)');
    // The debug-only lab run from adb is refused by a release build.
    expect(read('android/app/src/main/java/com/forgereserve/ai/MainActivity.kt')).toMatch(/FLAG_DEBUGGABLE == 0\) return/);
  });

  it('carry their licences', () => {
    expect(read('public/vendor/licenses/xn-ptts.txt')).toContain(lock.commit);
    expect(read('public/vendor/licenses/xn-ptts.txt')).toMatch(/Permission is hereby granted[\s\S]*Apache License/);
    const third = read('public/vendor/licenses/xn-ptts-THIRD_PARTY_LICENSES.md');
    for (const crate of ['tokenizers', 'serde_json', 'rayon']) expect(third, crate).toMatch(new RegExp(`^- ${crate} `, 'm'));
  });
});

