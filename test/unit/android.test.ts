// The Android app's project files (android/): what the APKs may do and carry. The build itself is
// checked by `cd android && ./gradlew assembleUniversalDebug assemblePrivatevoiceDebug
// testUniversalDebugUnitTest testPrivatevoiceDebugUnitTest`.
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { type AsrLock, checkLock as checkAsrLock, LICENSES as ASR_LICENSES, placements as asrPlacements } from '../../scripts/asr-model.ts';
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

  it('never commits a signing key, and signs only the Play bundle, with the upload key the environment names', () => {
    expect(read('android/.gitignore')).toMatch(/\*\.jks[\s\S]*\*\.keystore/);
    const app = code('android/app/build.gradle');
    // No signing config: the APKs stay unsigned for scripts/android-release.sh, and nothing is signed with a debug key.
    expect(app).not.toMatch(/signingConfig|storePassword|keyPassword|debug\.keystore|android\.injected\.signing/);
    // The bundle: universal only, from four environment variables, passwords handed to jarsigner by name.
    for (const v of ['FORGE_UPLOAD_KEYSTORE', 'FORGE_UPLOAD_KEY_ALIAS', 'FORGE_UPLOAD_STORE_PASSWORD', 'FORGE_UPLOAD_KEY_PASSWORD']) expect(app).toContain(`'${v}'`);
    expect(app).toMatch(/'-storepass:env', 'FORGE_UPLOAD_STORE_PASSWORD', '-keypass:env', key\.keyPassEnv/);
    expect(app).not.toMatch(/'-storepass',|'-keypass',/);
    expect(app).toMatch(/if \(t\.name != 'bundleUniversalRelease'\) return/);
    // Checked before any task runs; a keystore inside the repository and a privatevoice bundle are refused.
    expect(app).toMatch(/gradle\.taskGraph\.whenReady[\s\S]*':app:bundlePrivatevoiceRelease'[\s\S]*throw new GradleException[\s\S]*':app:bundleUniversalRelease' \}\) uploadKey\(\)/);
    expect(app).toMatch(/ks\.path\.startsWith\(repoRoot\.canonicalPath \+ File\.separator\)/);
    expect(app).toMatch(/are'\} not set[\s\S]*Nothing was built/);
  });
});

describe('Android 16 (API 36) and Google Play', () => {
  const vars = read('android/variables.gradle');
  const activity = read('android/app/src/main/java/com/forgereserve/ai/MainActivity.kt');
  const bars = read('android/app/src/main/java/com/forgereserve/ai/BarsPlugin.kt');

  it('compiles against and targets API 36, still for Android 9 and up', () => {
    expect(vars).toMatch(/compileSdkVersion = 36\b/);
    expect(vars).toMatch(/targetSdkVersion = 36\b/);
    expect(vars).toMatch(/minSdkVersion = 28\b/);
    // The app's build.gradle takes them from variables.gradle, and so does Capacitor's module.
    const app = read('android/app/build.gradle');
    expect(app).toMatch(/compileSdk rootProject\.ext\.compileSdkVersion/);
    expect(app).toMatch(/targetSdkVersion rootProject\.ext\.targetSdkVersion/);
    expect(readFileSync(join(ROOT, 'node_modules/@capacitor/android/capacitor/build.gradle'), 'utf8')).toMatch(/compileSdk project\.hasProperty\('compileSdkVersion'\) \? rootProject\.ext\.compileSdkVersion/);
  });

  it('builds with an Android Gradle plugin tested with compileSdk 36, on Gradle 8.13 and Capacitor 6', () => {
    const agp = read('android/build.gradle').match(/com\.android\.tools\.build:gradle:(\d+)\.(\d+)\.(\d+)/);
    expect(agp).not.toBeNull();
    // 8.7 was tested up to compileSdk 35 and warns at 36; 8.10 is the first tested with 36. AGP 9 is a larger move.
    expect(Number(agp![1])).toBe(8);
    expect(Number(agp![2])).toBeGreaterThanOrEqual(10);
    expect(read('android/gradle/wrapper/gradle-wrapper.properties')).toContain('gradle-8.13-bin.zip');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.devDependencies['@capacitor/android']).toMatch(/^6\./);
  });

  it('is drawn edge to edge with the page kept clear of the bars, the cutout and the keyboard', () => {
    // Every Android version the same way (Android 15 and up force it; the opt-out is gone at 36, and not used).
    expect(activity).toMatch(/Edge\.fit\(this, frame, BarRules\.forRgb\(ContextCompat\.getColor\(this, R\.color\.forge_bg\)\)\)/);
    expect(bars).toMatch(/WindowCompat\.setDecorFitsSystemWindows\(window, false\)/);
    for (const t of ['systemBars', 'displayCutout', 'ime']) expect(bars).toContain(`WindowInsetsCompat.Type.${t}()`);
    expect(bars).toMatch(/v\.setPadding\(room\.left, room\.top, room\.right, room\.bottom\)\s*WindowInsetsCompat\.CONSUMED/);
    // The bars' colour comes from the frame behind them; no scrim over three-button navigation.
    expect(bars).toMatch(/window\.statusBarColor = Color\.TRANSPARENT/);
    expect(bars).toMatch(/window\.navigationBarColor = Color\.TRANSPARENT/);
    expect(bars).toMatch(/window\.isNavigationBarContrastEnforced = false/);
    expect(bars).toMatch(/frame\.setBackgroundColor\(bars\.argb\)/);
    expect(bars).not.toMatch(/statusBarColor = bars|navigationBarColor = bars/);
    for (const f of [manifest, read('android/app/src/main/res/values/styles.xml')]) expect(f).not.toContain('windowOptOutEdgeToEdgeEnforcement');
    // The keyboard resizes the page, as Android chose for it before (interactive-widget=resizes-content).
    expect(manifest).toContain('android:windowSoftInputMode="adjustResize"');
    expect(read('public/v2/index.html')).toMatch(/interactive-widget=resizes-content/);
  });

  it('handles Back through the dispatcher, as predictive back requires', () => {
    expect(manifest).toMatch(/android:enableOnBackInvokedCallback="true"\s+tools:targetApi="33"/);
    expect(activity).toMatch(/onBackPressedDispatcher\.addCallback\(/);
    expect(activity).toMatch(/BackRule\.Step\.WEB_BACK -> web\?\.goBack\(\)\s*BackRule\.Step\.LEAVE -> moveTaskToBack\(true\)/);
    // Neither is called at API 36.
    const kotlin = readdirSync(join(ROOT, 'android/app/src'), { recursive: true }).map(String).filter((f) => f.endsWith('.kt'));
    for (const f of kotlin) expect(read(`android/app/src/${f}`), f).not.toMatch(/fun onBackPressed\(|KEYCODE_BACK/);
  });

  it('keeps no orientation or resizing limits, which large screens ignore at API 36', () => {
    expect(manifest).not.toMatch(/screenOrientation|resizeableActivity|maxAspectRatio|minAspectRatio/);
  });

  it('calls no Java collection method that compileSdk 35 would pick over Kotlin\'s', () => {
    // List.removeFirst() and friends compile to the Java 21 method at compileSdk 35+, which phones below Android 15 lack.
    const kotlin = readdirSync(join(ROOT, 'android/app/src'), { recursive: true }).map(String).filter((f) => f.endsWith('.kt'));
    expect(kotlin.length).toBeGreaterThan(20);
    for (const f of kotlin) expect(code(`android/app/src/${f}`), f).not.toMatch(/\.(removeFirst|removeLast|getFirst|getLast|addFirst|addLast|reversed)\(\)/);
  });

  it('runs no foreground service in a release build', () => {
    // Only the debug check from adb has one (src/debug); Android 15's foreground service limits do not reach the app.
    expect(manifest).not.toMatch(/FOREGROUND_SERVICE|foregroundServiceType/);
    expect(read('android/app/src/privatevoice/AndroidManifest.xml')).not.toMatch(/FOREGROUND_SERVICE|foregroundServiceType/);
    expect(read('android/app/src/debug/AndroidManifest.xml')).toContain('android:foregroundServiceType="specialUse"');
  });
});

describe('the web bundle in the APK', () => {
  const PUBLIC = join(ROOT, 'public');

  it('carries the v2 app and what it imports, never v1, admin, beta or the website pages', () => {
    for (const p of ['v2/app.js', 'v2/core/engine.js', 'v2/strings/en.js', 'js/ui.js', 'js/files.js', 'vendor/tinfoil.js', 'vendor/face-api/face-api.js', 'icons/icon-192.png', 'icon.svg']) {
      expect(existsSync(join(PUBLIC, p)), p).toBe(true);
      expect(inBundle(p), p).toBe(true);
    }
    for (const p of ['index.html', 'classic/index.html', 'about/index.html', 'about/about.js', 'about/forward.js', 'app.js', 'sw.js', 'style.css', 'offline.html', 'manifest.webmanifest', 'theme.js', 'admin/index.html', 'beta/index.html', 'v2/free/index.html', 'v2/free/free.js', 'v2/download/index.html', 'v2/join/index.html', 'v2/join/join.js', 'v2/sw.js']) {
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


describe('Forge Private Voice (the privatevoice flavour)', () => {
  const lock = JSON.parse(read('scripts/asr/lock.json')) as AsrLock;
  const gradle = read('android/app/build.gradle');
  const flavour = 'android/app/src/privatevoice';
  const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

  it('is a second APK beside today\'s, with its own id and name, both installable side by side', () => {
    expect(gradle).toMatch(/flavorDimensions 'voice'/);
    expect(gradle).toMatch(/universal \{\s*dimension 'voice'\s*\}/);
    expect(gradle).toMatch(/privatevoice \{\s*dimension 'voice'\s*applicationIdSuffix '\.privatevoice'\s*\}/);
    expect(read(`${flavour}/res/values/strings.xml`)).toContain('<string name="app_name">Forge Private Voice</string>');
    // The universal APK has no source set of its own beyond the stand-in that says it carries no model.
    expect(readdirSync(join(ROOT, 'android/app/src/universal'), { recursive: true }).filter((f) => String(f).endsWith('.kt'))).toEqual(['java/com/forgereserve/ai/AsrBundle.kt']);
    expect(read('android/app/src/universal/java/com/forgereserve/ai/AsrBundle.kt')).toMatch(/BUNDLED = false/);
    // Fetched for privatevoice builds only, and the .ort model stored uncompressed (read from the APK in place).
    expect(gradle).toMatch(/commandLine 'node', 'scripts\/asr-model\.ts'/);
    expect(gradle).toContain("if (t.name ==~ /prePrivatevoice\\w*Build/) t.dependsOn asrFiles");
    expect(gradle).toMatch(/noCompress 'gguf', 'safetensors', 'ort'/);
  });

  it('hears in a process of its own that no other app can reach, and asks for no new permission', () => {
    const m = read(`${flavour}/AndroidManifest.xml`);
    expect(m).toMatch(/<service\s+android:name="\.AsrService"\s+android:process=":asr"\s+android:exported="false" \/>/);
    expect(m).not.toMatch(/uses-permission/);
    expect(read('android/app/src/main/java/com/forgereserve/ai/MainActivity.kt')).toContain('registerPlugin(AsrPlugin::class.java)');
    // The debug-only check from adb: a release build has neither the extra nor the service.
    const debug = read('android/app/src/debug/AndroidManifest.xml');
    expect(debug).toMatch(/android:name="\.AsrCheckService"[\s\S]*android:permission="android\.permission\.DUMP"/);
    expect(existsSync(join(ROOT, 'android/app/src/release'))).toBe(false);
  });

  it('pins the runtime and the model: sherpa-onnx 2.x, MIT and Apache-2.0 only, every file by size and SHA-256', () => {
    expect(checkAsrLock(lock)).toEqual([]);
    expect(lock.runtime).toMatchObject({ tag: 'v2.0.1', commit: 'af2d8d81dbfa61c4cea4c568da78f3982edca005', license: 'Apache-2.0', lib: { size: 24177488 } });
    expect(lock.runtime.onnxruntime).toMatchObject({ version: '1.28.2', license: 'MIT' });
    expect(lock.model).toMatchObject({ id: 'moonshine-tiny-en', license: 'MIT', revision: 'd1e6c30921780b8508d04b492dfb3ce8a51605d4' });
    expect(asrPlacements(lock).reduce((n, p) => n + p.pin.size, 0)).toBe(24177488 + 44243206);
    // Refusals: GPL-era sherpa-onnx, a non-MIT model, an unpinned URL, a missing hash.
    const bad = (f: (l: any) => void) => {
      const l = JSON.parse(JSON.stringify(lock));
      f(l);
      return checkAsrLock(l);
    };
    expect(bad((l) => (l.runtime.tag = 'v1.12.0'))).not.toEqual([]);
    expect(bad((l) => (l.model.license = 'Moonshine Community License'))).not.toEqual([]);
    expect(bad((l) => (l.model.files[0].url = 'https://huggingface.co/x/y/resolve/main/encoder_model.ort'))).not.toEqual([]);
    expect(bad((l) => (l.model.files[1].sha256 = ''))).not.toEqual([]);
    expect(bad((l) => (l.model.files = l.model.files.filter((f: any) => f.role !== 'tokens')))).not.toEqual([]);
  });

  it('the app reads the files the lock pins, by the names the lock gives', () => {
    const bundle = read(`${flavour}/java/com/forgereserve/ai/AsrBundle.kt`);
    expect(bundle).toContain(`const val MODEL = "${lock.model.id}"`);
    for (const f of lock.model.files.filter((x) => x.role !== 'license')) expect(bundle, f.name).toContain(`$DIR/${f.name}`);
  });

  it('carries sherpa-onnx\'s Kotlin API files byte for byte from the pinned commit', () => {
    const dir = join(ROOT, flavour, 'java/com/k2fsa/sherpa/onnx');
    expect(readdirSync(dir).sort()).toEqual(lock.runtime.kotlinApi.files.map((f) => f.name).sort());
    for (const f of lock.runtime.kotlinApi.files) {
      const b = readFileSync(join(dir, f.name));
      expect(b.length, f.name).toBe(f.size);
      expect(sha(b), f.name).toBe(f.sha256);
    }
  });

  it('carries the licences, which the universal APK leaves out', () => {
    expect(ASR_LICENSES).toEqual(['sherpa-onnx.txt', 'onnxruntime.txt', 'moonshine.txt']);
    expect(read('public/vendor/licenses/sherpa-onnx.txt')).toMatch(new RegExp(`${lock.runtime.commit}[\\s\\S]*Apache License\\s+Version 2\\.0`));
    const ort = read('public/vendor/licenses/onnxruntime.txt');
    expect(ort).toContain(lock.runtime.onnxruntime.commit);
    expect(ort).toMatch(/MIT License[\s\S]*Copyright \(c\) Microsoft Corporation[\s\S]*ThirdPartyNotices/);
    const moon = read('public/vendor/licenses/moonshine.txt');
    expect(moon).toContain(lock.model.revision);
    // The model's own LICENSE file, unchanged after the header.
    const license = lock.model.files.find((f) => f.role === 'license')!;
    expect(sha(Buffer.from(moon.slice(moon.indexOf('The code in this repo')), 'utf8'))).toBe(license.sha256);
    for (const f of ASR_LICENSES) expect(inBundle(`vendor/licenses/${f}`), f).toBe(false);
    expect(inBundle('vendor/licenses/xn-ptts.txt')).toBe(true);
  });

  it('keeps the downloaded files out of git', () => {
    const ignore = read('.gitignore');
    expect(ignore).toContain('android/app/src/privatevoice/jniLibs/');
    expect(ignore).toContain('android/app/src/privatevoice/assets/');
  });
});
