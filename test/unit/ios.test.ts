// The iPhone app (ios/, docs/IOS.md): the Xcode project's identity and permissions, what stays out of
// git, and the web bundle it carries (the APK's, through scripts/lib/android-web.ts).
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bundleFiles, readConfig, writeBundle } from '../../scripts/lib/android-web.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const project = read('ios/App/App.xcodeproj/project.pbxproj');
const plist = read('ios/App/App/Info.plist');
/** The string an Info.plist key holds. */
const plistString = (key: string) => plist.match(new RegExp(`<key>${key}</key>\\s*<string>([^<]*)</string>`))?.[1] ?? null;

describe('iPhone app project', () => {
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

  it('registers its plugins, ForgeBars and ForgeNfc, as the page calls them', () => {
    expect(read('ios/App/App/BarsPlugin.swift')).toContain('public let jsName = "ForgeBars"');
    expect(read('ios/App/App/ForgeViewController.swift')).toContain('registerPluginInstance(BarsPlugin())');
    expect(read('ios/App/App/ForgeViewController.swift')).toContain('registerPluginInstance(NfcPlugin())');
    expect(read('ios/App/App/Base.lproj/Main.storyboard')).toContain('customClass="ForgeViewController" customModule="App"');
    for (const f of ['ForgeViewController.swift', 'BarsPlugin.swift', 'NfcPlugin.swift', 'NfcRules.swift']) expect(project).toContain(`${f} in Sources`);
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

  it('tests NfcRules in a unit test bundle of its own, with no team', () => {
    expect(project).toContain('productType = "com.apple.product-type.bundle.unit-test";');
    expect(project).toContain('NfcRulesTests.swift in Sources');
    expect(project.match(/NfcRules\.swift in Sources/g)).toHaveLength(4);
    expect(read('ios/App/AppTests/NfcRulesTests.swift')).toContain('final class NfcRulesTests: XCTestCase');
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
