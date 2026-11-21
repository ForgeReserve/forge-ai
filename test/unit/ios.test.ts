// The iPhone app (ios/, docs/IOS.md): the Xcode project's identity and permissions, what stays out of
// git, and the web bundle it carries (the APK's, through scripts/lib/android-web.ts).
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleFiles, readConfig, writeBundle } from '../../scripts/lib/android-web.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const project = read('ios/App/App.xcodeproj/project.pbxproj');
const plist = read('ios/App/App/Info.plist');
/** The string an Info.plist key holds. */
const plistString = (key: string) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;

describe('iPhone app project', () => {
  it('carries the owner\'s export compliance answer, so App Store Connect does not ask for each build', () => {
    const plist = readFileSync(resolve(import.meta.dirname, '../../ios/App/App/Info.plist'), 'utf8');
    expect(plist).toMatch(/<key>ITSAppUsesNonExemptEncryption<\/key>\s*<false\/>/);
  });

  it('is com.forgereserve.ai, named Forge, at the version in package.json, iPhone only', () => {
    // The app, Debug and Release, and its unit tests' bundle (AppTests).
    expect(project.match(/PRODUCT_BUNDLE_IDENTIFIER = ([^;]+);/g)).toEqual([
      'PRODUCT_BUNDLE_IDENTIFIER = com.forgereserve.ai;',
      'PRODUCT_BUNDLE_IDENTIFIER = com.forgereserve.ai;',
      'PRODUCT_BUNDLE_IDENTIFIER = com.forgereserve.ai.tests;',
      'PRODUCT_BUNDLE_IDENTIFIER = com.forgereserve.ai.tests;',
    ]);
    expect(plistString('CFBundleDisplayName')).toBe('Forge');
    const version = JSON.parse(read('package.json')).version;
    expect(project.match(/MARKETING_VERSION = ([^;]+);/g)).toEqual([`MARKETING_VERSION = ${version};`, `MARKETING_VERSION = ${version};`]);
    expect(project).not.toMatch(/TARGETED_DEVICE_FAMILY = "1,2"/);
    expect(read('package.json')).toMatch(/"@capacitor\/ios": "6\.2\.3"/);
  });

  it('signs nothing in the repository: no team, no profile, no certificate', () => {
    for (const m of project.matchAll(/DEVELOPMENT_TEAM = ([^;]*);/g)) expect(m[1]).toBe('""');
    expect(project).not.toMatch(/PROVISIONING_PROFILE|CODE_SIGN_IDENTITY\[sdk=iphoneos\*\] = "Apple Distribution/);
  });

  it('says plainly why it asks for the camera, the microphone and speech recognition, with no em dash', () => {
    for (const key of ['NSCameraUsageDescription', 'NSMicrophoneUsageDescription', 'NSSpeechRecognitionUsageDescription', 'NSPhotoLibraryAddUsageDescription', 'NFCReaderUsageDescription']) {
      const s = plistString(key);
      expect(s, key).toBeTruthy();
      expect(s!.length, key).toBeLessThan(120);
      expect(s, key).not.toMatch(/—/);
    }
    expect(plistString('NSCameraUsageDescription')).toMatch(/read a code/);
    expect(plistString('NSMicrophoneUsageDescription')).toMatch(/question you speak/);
    // Speech recognition: on the phone (ForgeSpeech), and This browser in Voice (WebKit's, which may send it to Apple).
    expect(plistString('NSSpeechRecognitionUsageDescription')).toMatch(/into words on this phone\. Your voice stays on it, unless you pick This browser\./);
    expect(plistString('NFCReaderUsageDescription')).toMatch(/reads an eCash card only when you hold it to the phone/);
  });

  it('opens dark: Midnight behind the web view and the launch screen, light status bar text', () => {
    const cfg = readConfig(join(ROOT, 'capacitor.config.json'));
    expect(cfg.ios).toEqual({ backgroundColor: '#0B0D10', contentInset: 'never' });
    // Capacitor iOS serves from capacitor://localhost: WKWebView will not hand https to the app.
    expect((cfg as any).server?.iosScheme).toBeUndefined();
    expect(plistString('UIStatusBarStyle')).toBe('UIStatusBarStyleLightContent');
    expect(read('ios/App/App/Base.lproj/LaunchScreen.storyboard')).toContain('red="0.043137254901960784" green="0.050980392156862744" blue="0.062745098039215685"');
  });

  it('registers its plugins, ForgeBars, ForgeNfc, ForgeSpeech and ForgeShare, as the page calls them', () => {
    expect(read('ios/App/App/BarsPlugin.swift')).toContain('public let jsName = "ForgeBars"');
    for (const p of ['BarsPlugin', 'NfcPlugin', 'SpeechPlugin', 'SharePlugin']) expect(read('ios/App/App/ForgeViewController.swift')).toContain(`registerPluginInstance(${p}())`);
    expect(read('ios/App/App/Base.lproj/Main.storyboard')).toContain('customClass="ForgeViewController" customModule="App"');
    for (const f of ['ForgeViewController.swift', 'BarsPlugin.swift', 'NfcPlugin.swift', 'NfcRules.swift', 'SpeechPlugin.swift', 'SpeechRules.swift', 'SharePlugin.swift']) expect(project).toContain(`${f} in Sources`);
  });

  it("ForgeShare saves to Photos with add-only access, the file's exact bytes, and Android's save codes", () => {
    const swift = read('ios/App/App/SharePlugin.swift');
    const kotlin = read('android/app/src/main/java/com/forgereserve/ai/SharePlugin.kt');
    expect(swift).toContain('public let jsName = "ForgeShare"');
    // Save only: the share sheet is the web view's (navigator.share). Android's plugin has save too.
    expect([...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1])).toEqual(['save']);
    expect(kotlin).toMatch(/@PluginMethod\s+fun save\(/);
    expect(swift).toContain('@objc func save(_ call: CAPPluginCall)');
    // Add-only: Forge can add a photo and never sees the library.
    expect(swift).toContain('PHPhotoLibrary.requestAuthorization(for: .addOnly)');
    expect(swift).not.toMatch(/for: \.readWrite|PHAsset\.fetch|PHFetchOptions/);
    // The bytes as they are: no image is decoded or encoded again, so nothing is added to the file.
    expect(swift).toContain('PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: options)');
    expect(swift).not.toMatch(/UIImage|jpegData|pngData|UIImageWriteToSavedPhotosAlbum|creationRequestForAsset\(from|CGImageDestination/);
    expect(swift).not.toMatch(/FileManager|write\(to|UserDefaults|CAPLog/);
    // Saved only on Photos' word.
    expect(swift).toMatch(/if ok \{\s*call\.resolve\(\["saved": true\]\)/);
    // Android's codes for save, and denied for a refused permission (Android's save screen needs none).
    const codes = (src: string) => [...new Set([...src.matchAll(/reject\("[^"]+", "(\w+)"\)/g)].map((m) => m[1]))].sort();
    const kotlinCodes = new Set(codes(kotlin));
    expect(codes(swift)).toEqual(['bad_file', 'bad_type', 'denied', 'save_failed']);
    for (const c of codes(swift).filter((c) => c !== 'denied')) expect(kotlinCodes, c).toContain(c);
    expect(plistString('NSPhotoLibraryAddUsageDescription')).toMatch(/only when you pick Save/);
    // Never asks to read the library.
    expect(plist).not.toContain('NSPhotoLibraryUsageDescription');
  });

  it("ForgeSpeech has the Android plugin's methods, events and error codes", () => {
    const swift = read('ios/App/App/SpeechPlugin.swift');
    const rules = read('ios/App/App/SpeechRules.swift');
    const kotlin = read('android/app/src/main/java/com/forgereserve/ai/SpeechPlugin.kt');
    const kotlinRules = read('android/app/src/main/java/com/forgereserve/ai/SpeechRules.kt');
    expect(swift).toContain('public let jsName = "ForgeSpeech"');
    expect(kotlin).toContain('@CapacitorPlugin(name = "ForgeSpeech"');
    const kotlinMethods = [...kotlin.matchAll(/@PluginMethod\s+fun (\w+)/g)].map((m) => m[1]).sort();
    const swiftMethods = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1]).sort();
    expect(swiftMethods).toEqual(kotlinMethods);
    for (const m of swiftMethods) expect(swift).toContain(`@objc func ${m}(_ call: CAPPluginCall)`);
    // start's refusals: the same codes.
    const codes = (src: string) => [...new Set([...src.matchAll(/reject\([^)]*?"(\w+)"\)/g)].map((m) => m[1]))].sort();
    expect(codes(swift)).toEqual(codes(kotlin));
    // One event, "speech", with the same types; the error codes the page may get are Android's.
    expect(swift).toContain('notifyListeners("speech", data: d)');
    for (const type of ['started', 'level', 'error', 'end']) expect(swift).toContain(`"${type}"`);
    for (const type of ['partial', 'final']) expect(rules).toContain(`"${type}"`);
    const androidCodes = new Set([...kotlinRules.matchAll(/-> "([a-z-]+)"/g)].map((m) => m[1]).concat(['no-speech', 'interrupted']));
    const iosCodes = [...rules.matchAll(/return "([a-z-]+)"/g)].map((m) => m[1]!).filter((c) => !c.startsWith('language-') && !c.startsWith('recognizer-') && c !== 'en-US');
    expect(iosCodes.length).toBeGreaterThan(0);
    for (const c of iosCodes) expect(androidCodes, c).toContain(c);
  });

  it('ForgeSpeech never lets a request leave the phone, and keeps no sound or words', () => {
    const swift = read('ios/App/App/SpeechPlugin.swift');
    // Every request requires the phone, and only one place makes one, behind the guard.
    expect(swift.match(/SFSpeechAudioBufferRecognitionRequest\(\)/g)).toHaveLength(1);
    expect(swift).toContain('request.requiresOnDeviceRecognition = true');
    expect(swift.match(/recognitionTask\(with:/g)).toHaveLength(1);
    const guard = swift.indexOf('guard SpeechRules.onDeviceOnly(recogniserOnDevice: l.recognizer.supportsOnDeviceRecognition, requestRequiresOnDevice: request.requiresOnDeviceRecognition)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(swift.indexOf('recognitionTask(with:'));
    // supportsOnDeviceRecognition can be set in the SDK: the app only ever reads it.
    expect(swift).not.toMatch(/supportsOnDeviceRecognition\s*=[^=]/);
    expect(swift).not.toMatch(/requiresOnDeviceRecognition\s*=\s*false/);
    // No file and no other request kind: the sound goes only to the request, in memory.
    expect(swift).not.toMatch(/SFSpeechURLRecognitionRequest|AVAudioFile|FileManager|write\(to|UserDefaults/);
    // Logged: the availability line and an error's domain and code. Never words or sound.
    for (const line of swift.match(/CAPLog\.print\([^\n]*/g) ?? []) expect(line).not.toMatch(/text|transcription|formattedString|buffer/i);
    // The audio session is let go with others told, and put back as it was.
    expect(swift).toContain('setActive(false, options: .notifyOthersOnDeactivation)');
    expect(swift).toContain('setCategory(saved.category, mode: saved.mode, options: saved.options)');
  });

  it("ForgeNfc has the Android plugin's methods, event and error codes", () => {
    const swift = read('ios/App/App/NfcPlugin.swift');
    const kotlin = read('android/app/src/main/java/com/forgereserve/ai/NfcPlugin.kt');
    expect(swift).toContain('public let jsName = "ForgeNfc"');
    expect(kotlin).toContain('@CapacitorPlugin(name = "ForgeNfc")');
    const kotlinMethods = [...kotlin.matchAll(/@PluginMethod\s+fun (\w+)/g)].map((m) => m[1]).sort();
    const swiftMethods = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1]).sort();
    expect(swiftMethods).toEqual(kotlinMethods);
    for (const m of swiftMethods) expect(swift).toContain(`@objc func ${m}(_ call: CAPPluginCall)`);
    const codes = (src: string) => [...new Set([...src.matchAll(/reject\("[^"]+", "(\w+)"\)/g)].map((m) => m[1]))].sort();
    // Two of Android's never happen on an iPhone: nfc_off (no switch for NFC alone) and short_answer
    // (CoreNFC hands the status word apart, so every answer has one).
    expect(codes(swift)).toEqual(codes(kotlin).filter((c) => c !== 'nfc_off' && c !== 'short_answer'));
    expect(swift).toContain('notifyListeners("card", data: ["id": 0, "isoDep": false])');
    expect(swift).toContain('notifyListeners("card", data: ["id": self.currentId, "isoDep": true])');
    expect(read('ios/App/App/NfcRules.swift')).toContain('static let timeoutMs = 5000');
  });

  it('may read tags, and selects exactly the card applets the page selects, the applet first', async () => {
    for (const config of project.match(/buildSettings = \{[^}]*PRODUCT_BUNDLE_IDENTIFIER = com\.forgereserve\.ai;[^}]*\}/g) ?? []) {
      expect(config).toContain('CODE_SIGN_ENTITLEMENTS = App/App.entitlements;');
    }
    expect(project).toContain('App.entitlements */ = {isa = PBXFileReference;');
    const ent = read('ios/App/App/App.entitlements');
    expect(ent).toMatch(/<key>com\.apple\.developer\.nfc\.readersession\.formats<\/key>\s*<array>\s*<string>TAG<\/string>\s*<\/array>/);
    const aids = [...(plist.match(/<key>com\.apple\.developer\.nfc\.readersession\.iso7816\.select-identifiers<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '').matchAll(/<string>([0-9A-F]+)<\/string>/g)].map((m) => m[1]);
    const apdu: any = await import('../../public/v2/core/card/apdu.js' as string);
    const hexOf = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
    expect(aids).toEqual([apdu.APPLET_AID, apdu.PACKAGE_AID, ...apdu.LEGACY_AIDS].map(hexOf));
    // Not the NDEF application: a tag with it would come as a card.
    expect(aids).not.toContain('D2760000850101');
    // NFC is not required to install the app.
    expect(plist).not.toMatch(/<string>nfc<\/string>/);
  });

  it('tests NfcRules and SpeechRules in a unit test bundle of its own, with no team', () => {
    expect(project).toContain('productType = "com.apple.product-type.bundle.unit-test";');
    expect(project).toContain('NfcRulesTests.swift in Sources');
    expect(project.match(/NfcRules\.swift in Sources/g)).toHaveLength(4);
    expect(read('ios/App/AppTests/NfcRulesTests.swift')).toContain('final class NfcRulesTests: XCTestCase');
    expect(project).toContain('SpeechRulesTests.swift in Sources');
    expect(project.match(/SpeechRules\.swift in Sources/g)).toHaveLength(4);
    expect(read('ios/App/AppTests/SpeechRulesTests.swift')).toContain('final class SpeechRulesTests: XCTestCase');
  });

  it('bundles the web app on every build, before the files are copied in', () => {
    const phases = project.match(/buildPhases = \(([^)]*)\);/)?.[1] ?? '';
    expect(phases.indexOf('Bundle the web app')).toBeGreaterThan(-1);
    expect(phases.indexOf('Bundle the web app')).toBeLessThan(phases.indexOf('Resources'));
    expect(project).toContain('node scripts/ios-web.ts');
    expect(read('package.json')).toMatch(/"ios:web": "node scripts\/ios-web\.ts"/);
  });

  it('keeps built and copied files out of git, the project and Podfile.lock in', () => {
    const ignore = read('ios/.gitignore').replace(/^#.*$/gm, '');
    for (const p of ['App/Pods', 'App/App/public', 'App/App/capacitor.config.json', 'xcuserdata', 'DerivedData']) expect(ignore).toContain(p);
    expect(ignore).not.toMatch(/Podfile\.lock|xcodeproj|xcworkspace/);
    expect(existsSync(join(ROOT, 'ios/App/Podfile.lock'))).toBe(true);
  });

  it('is an iPhone app in portrait that installs without NFC, with its version and build from the project', () => {
    const caps = plist.match(/<key>UIRequiredDeviceCapabilities<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    expect([...caps.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])).toEqual(['arm64']);
    const orient = plist.match(/<key>UISupportedInterfaceOrientations<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? '';
    expect([...orient.matchAll(/<string>([^<]+)<\/string>/g)].map((m) => m[1])).toEqual(['UIInterfaceOrientationPortrait']);
    expect(project.match(/TARGETED_DEVICE_FAMILY = ([^;]+);/g)?.every((s) => s === 'TARGETED_DEVICE_FAMILY = 1;')).toBe(true);
    expect(plistString('CFBundleShortVersionString')).toBe('$(MARKETING_VERSION)');
    expect(plistString('CFBundleVersion')).toBe('$(CURRENT_PROJECT_VERSION)');
    expect(project.match(/CURRENT_PROJECT_VERSION = \d+;/g)).toHaveLength(2);
    expect(plistString('UILaunchStoryboardName')).toBe('LaunchScreen');
    expect(project).not.toMatch(/ENABLE_BITCODE = YES/);
  });

  it('has a privacy manifest in the app: no tracking, no required reason API, what the engine keeps unlinked', () => {
    const manifest = read('ios/App/App/PrivacyInfo.xcprivacy');
    // A file of the App target, copied into the app with its resources.
    const ref = project.match(/(\w{24}) \/\* PrivacyInfo\.xcprivacy \*\/ = \{isa = PBXFileReference;[^}]*path = PrivacyInfo\.xcprivacy;/)?.[1];
    expect(ref).toBeTruthy();
    const build = project.match(new RegExp(`(\\w{24}) /\\* PrivacyInfo\\.xcprivacy in Resources \\*/ = \\{isa = PBXBuildFile; fileRef = ${ref} `))?.[1];
    expect(build).toBeTruthy();
    const appResources = project.match(/504EC3021FED79650016851F \/\* Resources \*\/ = \{[^}]*files = \(([^)]*)\)/)?.[1] ?? '';
    expect(appResources).toContain(`${build} /* PrivacyInfo.xcprivacy in Resources */`);
    expect(project.match(/PrivacyInfo\.xcprivacy in Resources \*\/,/g)).toHaveLength(1);

    const key = (k: string) => manifest.match(new RegExp(`<key>${k}</key>\\s*(<false/>|<true/>|<array/>|<array>)`))?.[1];
    expect(key('NSPrivacyTracking')).toBe('<false/>');
    expect(key('NSPrivacyTrackingDomains')).toBe('<array/>');
    // The app's own code calls none of Apple's required reason APIs (UserDefaults, file timestamps, disk
    // space, system boot time, active keyboards): add one, and it must be declared here with its reason.
    expect(key('NSPrivacyAccessedAPITypes')).toBe('<array/>');
    for (const f of readdirSync(join(ROOT, 'ios/App/App')).filter((f) => f.endsWith('.swift'))) {
      expect(read(`ios/App/App/${f}`), f).not.toMatch(
        /UserDefaults|creationDate|modificationDate|attributesOfItem|getattrlist|\bf?stat\(|systemUptime|mach_absolute_time|volumeAvailableCapacity|systemFreeSize|systemSize|activeInputModes/,
      );
    }
    // What the engine keeps for a balance (docs/PRIVACY.md): its top-ups and charges, and a metering row
    // per request. For the app to work, never tracking, and not linked to a person.
    const types = [...manifest.matchAll(/<dict>\s*<key>NSPrivacyCollectedDataType<\/key>\s*<string>(\w+)<\/string>([\s\S]*?)<\/dict>/g)];
    expect(types.map((m) => m[1])).toEqual(['NSPrivacyCollectedDataTypePurchaseHistory', 'NSPrivacyCollectedDataTypeProductInteraction']);
    for (const [, , body = ''] of types) {
      expect(body).toMatch(/<key>NSPrivacyCollectedDataTypeLinked<\/key>\s*<false\/>/);
      expect(body).toMatch(/<key>NSPrivacyCollectedDataTypeTracking<\/key>\s*<false\/>/);
      expect([...body.matchAll(/<string>(\w+)<\/string>/g)].map((m) => m[1])).toEqual(['NSPrivacyCollectedDataTypePurposeAppFunctionality']);
    }
    // Capacitor's pods ship their own manifests.
    for (const p of ['Capacitor', 'CapacitorCordova']) {
      expect(read(`node_modules/@capacitor/ios/${p}.podspec`)).toContain(`${p}/${p}/PrivacyInfo.xcprivacy`);
      expect(existsSync(join(ROOT, `node_modules/@capacitor/ios/${p}/${p}/PrivacyInfo.xcprivacy`))).toBe(true);
    }
  });

  it('has an opaque 1024 icon, as App Store Connect wants', () => {
    const png = readFileSync(join(ROOT, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png'));
    expect(png.readUInt32BE(16)).toBe(1024);
    expect(png.readUInt32BE(20)).toBe(1024);
    // IHDR colour type 2: RGB, no alpha channel.
    expect(png[25]).toBe(2);
  });
});

describe('the web bundle in the iPhone app', () => {
  it("is the APK's, with the runtime config Capacitor iOS reads and no npm plugins", () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ios-'));
    const r = writeBundle(join(ROOT, 'public'), dir, readConfig(join(ROOT, 'capacitor.config.json')), 'ios');
    expect(r.files).toBe(bundleFiles(join(ROOT, 'public')).length + 1);
    expect(readFileSync(join(dir, 'public/index.html'), 'utf8')).toBe(read('public/v2/index.html'));
    const cfg = JSON.parse(readFileSync(join(dir, 'capacitor.config.json'), 'utf8'));
    expect(cfg).toMatchObject({ appId: 'com.forgereserve.ai', appName: 'Forge', packageClassList: [] });
    expect(cfg.webDir).toBeUndefined();
    expect(existsSync(join(dir, 'capacitor.plugins.json'))).toBe(false);
  });
});

describe('the Share unseen filters in the iPhone app', () => {
  /**
   * Every file a filter module loads, as paths under public/: its manifest and entry, what they import,
   * what they open with new URL(..., import.meta.url) (a folder: each file in it, and for a model, each
   * file its weights manifest names), followed through every module found.
   */
  function loads(folder: string): Set<string> {
    const out = new Set<string>([`${folder}/manifest.json`]);
    const todo = [`${folder}/index.js`];
    while (todo.length) {
      const f = todo.pop()!;
      if (out.has(f)) continue;
      out.add(f);
      const src = read(`public/${f}`);
      const here = posix.dirname(f);
      for (const [, ref = ''] of src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s+'([^']+)'/g)) {
        todo.push(posix.join(here, ref));
      }
      for (const [, ref = ''] of src.matchAll(/new URL\('([^']+)', import\.meta\.url\)/g)) {
        const p = posix.join(here, ref);
        if (!ref.endsWith('/')) {
          todo.push(p);
          continue;
        }
        for (const name of readdirSync(join(ROOT, 'public', p))) {
          out.add(posix.join(p, name));
          if (name.endsWith('-weights_manifest.json'))
            for (const group of JSON.parse(read(`public/${p}${name}`))) for (const w of group.paths) out.add(posix.join(p, w));
        }
      }
    }
    return out;
  }

  it('carries every file the three filters load: their modules, face-api and the face model', () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ios-filters-'));
    writeBundle(join(ROOT, 'public'), dir, readConfig(join(ROOT, 'capacitor.config.json')), 'ios');
    const all = new Set<string>();
    for (const f of ['strip-details', 'cover-faces', 'cover-numbers']) for (const p of loads(`v2/modules/filter/${f}`)) all.add(p);
    // The walk found the detector and its model, so it would see them go missing.
    for (const p of ['vendor/face-api/face-api.js', 'vendor/yunet/yunet.json', 'vendor/yunet/yunet.bin', 'v2/modules/filter/cover-faces/yunet.js', 'v2/core/covers.js', 'v2/core/photometa.js', 'v2/modules/filter/cover-numbers/textfind.js']) expect(all, p).toContain(p);
    const missing = [...all].filter((p) => !existsSync(join(dir, 'public', p)));
    expect(missing).toEqual([]);
  });
});
