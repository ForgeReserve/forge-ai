// /download: the Android app's APK from FORGE_APK_PATH, its SHA-256 and version, the store links
// (FORGE_IOS_URL, FORGE_PLAY_URL), and the page that offers every way to get Forge.
import { createHash } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, DOWNLOAD_CSP } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { APK_TYPE, apkSource, apkVersion, PRIVATE_VOICE_APK_URL } from '../../src/download.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { testCatalog } from '../e2e/helpers.ts';
import { manifestXml, zip } from '../support/apk.ts';

setLogSilent(true);
const V: any = await import('../../public/v2/download/view.js' as string);
const PUBLIC = resolve(import.meta.dirname, '..', '..', 'public');
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

function apkFile(bytes: Buffer) {
  const f = join(mkdtempSync(join(tmpdir(), 'forge-apk-')), 'forge.apk');
  writeFileSync(f, bytes);
  return f;
}

function gateway(env: Record<string, string> = {}) {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '', ...env };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog());
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: PUBLIC });
  return (path: string, init?: RequestInit) => app.request(`http://gw.test${path}`, init);
}

describe('the APK source', () => {
  it('is not available when unset or when no file is there', () => {
    expect(apkSource(undefined).info()).toEqual({ available: false });
    expect(apkSource('/nonexistent/forge.apk').info()).toEqual({ available: false });
    expect(apkSource(mkdtempSync(join(tmpdir(), 'forge-apk-'))).info()).toEqual({ available: false });
    expect(apkSource(apkFile(Buffer.alloc(0))).info()).toEqual({ available: false });
  });

  it('reads the version from the APK\'s own manifest, and gives none when it cannot', () => {
    const apk = zip({ 'classes.dex': Buffer.from('dex\n035'), 'AndroidManifest.xml': manifestXml('0.1.0', 2), 'res/a.xml': Buffer.from('x') });
    expect(apkVersion(apk)).toEqual({ version: '0.1.0', versionCode: 2 });
    expect(apkSource(apkFile(apk)).info()).toMatchObject({ available: true, size: apk.length, sha256: sha(apk), version: '0.1.0', versionCode: 2 });
    // Not a zip, a zip with no manifest, a manifest that is not binary XML, a version that is not a plain version.
    expect(apkVersion(Buffer.from('PK\u0003\u0004 not really'))).toEqual({});
    expect(apkVersion(zip({ 'classes.dex': Buffer.from('dex') }))).toEqual({});
    expect(apkVersion(zip({ 'AndroidManifest.xml': Buffer.from('<manifest/>') }))).toEqual({});
    expect(apkVersion(zip({ 'AndroidManifest.xml': manifestXml('1.0 <b>', 3) }))).toEqual({ versionCode: 3 });
    expect(apkSource(apkFile(Buffer.from('PK\u0003\u0004 no version'))).info()).not.toHaveProperty('version');
  });

  it('gives the size and SHA-256, and picks up a new file put in its place', () => {
    const a = Buffer.from('PK\u0003\u0004 first apk');
    const f = apkFile(a);
    const src = apkSource(f);
    expect(src.info()).toEqual({ available: true, url: '/download/forge.apk', size: a.length, sha256: sha(a) });
    const b = Buffer.from('PK\u0003\u0004 the second, longer apk');
    writeFileSync(f, b);
    utimesSync(f, new Date(), new Date(Date.now() + 5000));
    expect(src.info()).toMatchObject({ size: b.length, sha256: sha(b) });
  });
});

describe('GET /download', () => {
  it('serves the APK with its type, length and hash when FORGE_APK_PATH is set', async () => {
    const bytes = Buffer.from('PK\u0003\u0004'.padEnd(5000, 'x'));
    const call = gateway({ FORGE_APK_PATH: apkFile(bytes) });
    const info = await (await call('/download/info')).json();
    expect(info).toEqual({ available: true, url: '/download/forge.apk', size: bytes.length, sha256: sha(bytes) });
    const r = await call('/download/forge.apk');
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(APK_TYPE);
    expect(r.headers.get('content-length')).toBe(String(bytes.length));
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="forge.apk"');
    expect(r.headers.get('x-forge-apk-sha256')).toBe(sha(bytes));
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await r.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('says the app is coming when FORGE_APK_PATH is unset, and has no file to give', async () => {
    const call = gateway({ FORGE_APK_PATH: '' });
    expect(await (await call('/download/info')).json()).toEqual({ available: false });
    expect((await call('/download/forge.apk')).status).toBe(404);
  });

  it('offers Forge Private Voice beside it when FORGE_APK_PRIVATE_VOICE_PATH is set, and only then', async () => {
    const bytes = Buffer.from('PK\u0003\u0004'.padEnd(3000, 'u'));
    const pv = Buffer.from('PK\u0003\u0004'.padEnd(7000, 'p'));
    const call = gateway({ FORGE_APK_PATH: apkFile(bytes), FORGE_APK_PRIVATE_VOICE_PATH: apkFile(pv) });
    expect(await (await call('/download/info')).json()).toEqual({
      available: true,
      url: '/download/forge.apk',
      size: bytes.length,
      sha256: sha(bytes),
      privateVoice: { available: true, url: PRIVATE_VOICE_APK_URL, size: pv.length, sha256: sha(pv) },
    });
    const r = await call(PRIVATE_VOICE_APK_URL);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe(APK_TYPE);
    expect(r.headers.get('content-disposition')).toBe('attachment; filename="forge-private-voice.apk"');
    expect(r.headers.get('x-forge-apk-sha256')).toBe(sha(pv));
    expect(Buffer.from(await r.arrayBuffer()).equals(pv)).toBe(true);
    expect(Buffer.from(await (await call('/download/forge.apk')).arrayBuffer()).equals(bytes)).toBe(true);
    // Unset, or no file there: no choice offered, and nothing at its address.
    const envs: Record<string, string>[] = [{ FORGE_APK_PATH: apkFile(bytes) }, { FORGE_APK_PATH: apkFile(bytes), FORGE_APK_PRIVATE_VOICE_PATH: '/nonexistent/pv.apk' }];
    for (const env of envs) {
      const c = gateway(env);
      expect(await (await c('/download/info')).json()).not.toHaveProperty('privateVoice');
      expect((await c(PRIVATE_VOICE_APK_URL)).status).toBe(404);
    }
  });

  it('carries the iPhone app\'s link when FORGE_IOS_URL is set, and only then', async () => {
    const link = 'https://testflight.apple.com/join/AbCd1234';
    expect(await (await gateway({ FORGE_APK_PATH: '', FORGE_IOS_URL: link })('/download/info')).json()).toEqual({ available: false, ios: { available: true, url: link } });
    const bytes = Buffer.from('PK\u0003\u0004'.padEnd(2000, 'i'));
    expect(await (await gateway({ FORGE_APK_PATH: apkFile(bytes), FORGE_IOS_URL: link })('/download/info')).json()).toMatchObject({ available: true, sha256: sha(bytes), ios: { available: true, url: link } });
    for (const env of [{}, { FORGE_IOS_URL: '' }] as Record<string, string>[]) expect(await (await gateway(env)('/download/info')).json()).not.toHaveProperty('ios');
  });

  it('carries Google Play\'s link when FORGE_PLAY_URL is set, and only then', async () => {
    const link = 'https://play.google.com/store/apps/details?id=com.forgereserve.ai';
    expect(await (await gateway({ FORGE_APK_PATH: '', FORGE_PLAY_URL: link })('/download/info')).json()).toEqual({ available: false, play: { available: true, url: link } });
    const ios = 'https://testflight.apple.com/join/AbCd1234';
    expect(await (await gateway({ FORGE_APK_PATH: '', FORGE_PLAY_URL: link, FORGE_IOS_URL: ios })('/download/info')).json()).toEqual({ available: false, ios: { available: true, url: ios }, play: { available: true, url: link } });
    for (const env of [{}, { FORGE_PLAY_URL: '' }] as Record<string, string>[]) expect(await (await gateway(env)('/download/info')).json()).not.toHaveProperty('play');
  });

  it('takes only an https link for FORGE_PLAY_URL', () => {
    const load = (v: string) => loadConfig({ FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_PLAY_URL: v } as NodeJS.ProcessEnv, testCatalog()).env.FORGE_PLAY_URL;
    expect(load('https://play.google.com/store/apps/details?id=com.forgereserve.ai')).toBe('https://play.google.com/store/apps/details?id=com.forgereserve.ai');
    expect(load('')).toBeUndefined();
    for (const bad of ['http://play.google.com/store/apps/details?id=x', 'play.google.com/store', 'javascript:alert(1)']) expect(() => load(bad), bad).toThrow(/FORGE_PLAY_URL/);
  });

  it('takes only an https link for FORGE_IOS_URL', () => {
    const load = (v: string) => loadConfig({ FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_IOS_URL: v } as NodeJS.ProcessEnv, testCatalog()).env.FORGE_IOS_URL;
    expect(load('https://apps.apple.com/app/id1234567890')).toBe('https://apps.apple.com/app/id1234567890');
    expect(load('')).toBeUndefined();
    for (const bad of ['http://testflight.apple.com/join/AbCd1234', 'testflight.apple.com/join/AbCd1234', 'javascript:alert(1)']) expect(() => load(bad), bad).toThrow(/FORGE_IOS_URL/);
  });

  it('serves the page at /download and /download/', async () => {
    const call = gateway();
    for (const p of ['/download', '/download/']) {
      const r = await call(p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get('content-security-policy'), p).toBe(DOWNLOAD_CSP);
      const html = await r.text();
      expect(html).toContain('/v2/download/download.js');
      // The landing page's look and parts, and a way to the privacy page.
      expect(html).toContain('<link rel="stylesheet" href="/about/site.css">');
      expect(html).toContain('href="/privacy"');
    }
    expect(DOWNLOAD_CSP).toBe("default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    // Every file it loads is here.
    for (const f of ['/v2/download/view.js', '/v2/download/download.css', '/about/site.css', '/icons/icon-192.png']) expect((await call(f)).status, f).toBe(200);
  });
});

describe('the download page', () => {
  it('offers Android first, and GrapheneOS only when the site has Forge Private Voice', () => {
    const h = 'b'.repeat(64);
    const one = V.apkChoices({ available: true, url: '/download/forge.apk', size: 92_000_000, sha256: h });
    expect(one.map((c: any) => [c.id, c.icon, c.file, c.url, c.name])).toEqual([['android', 'phone', 'forge.apk', '/download/forge.apk', 'Forge']]);
    const both = V.apkChoices({ available: true, url: '/download/forge.apk', size: 92_000_000, sha256: h, privateVoice: { available: true, size: 160_000_000, sha256: 'c'.repeat(64) } });
    expect(both.map((c: any) => [c.id, c.icon, c.file, c.url, c.mb])).toEqual([
      ['android', 'phone', 'forge.apk', '/download/forge.apk', '87.7'],
      ['graphene', 'shield', 'forge-private-voice.apk', '/download/forge-private-voice.apk', '152.6'],
    ]);
    expect(V.apkChoices(null)).toEqual([]);
    expect(V.apkChoices({ available: false, privateVoice: { available: false } })).toEqual([]);
  });

  it('shows the size and the hash in groups, only for a complete answer', () => {
    const h = 'a'.repeat(56) + '0123abcd';
    expect(V.apkView({ available: true, url: '/download/forge.apk', size: 12_345_678, sha256: h })).toEqual({
      available: true,
      url: '/download/forge.apk',
      mb: '11.8',
      hash: `${'aaaaaaaa '.repeat(7)}0123abcd`,
      version: null,
    });
    expect(V.apkView({ available: true, size: 1000, sha256: h, version: '0.1.0' }).version).toBe('0.1.0');
    expect(V.apkView({ available: true, size: 1000, sha256: h, version: '<b>x</b>' }).version).toBeNull();
    expect(V.apkView({ available: true, size: 1000, sha256: h }).mb).toBe('0.1');
    expect(V.apkView({ available: true, url: 'https://elsewhere.example/x.apk', size: 1000, sha256: h }).url).toBe('/download/forge.apk');
    for (const bad of [null, {}, { available: false }, { available: true, size: 10 }, { available: true, size: 10, sha256: 'xyz' }, { available: true, size: 0, sha256: h }]) {
      expect(V.apkView(bad)).toEqual({ available: false });
    }
  });
});

describe('the ways to get Forge', () => {
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1';
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36';
  const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36';

  it('tells an iPhone, an iPad asking for computer pages, Android and a computer apart', () => {
    expect(V.deviceOf({ ua: IPHONE })).toBe('ios');
    expect(V.deviceOf({ ua: MAC, platform: 'MacIntel', touchPoints: 5 })).toBe('ios');
    expect(V.deviceOf({ ua: ANDROID })).toBe('android');
    expect(V.deviceOf({ ua: MAC, platform: 'MacIntel', touchPoints: 0 })).toBe('computer');
    expect(V.deviceOf({})).toBe('computer');
  });

  it('leads with the ways for this phone, and puts the rest under Other ways, the ones there first', () => {
    const all = { apk: true, play: true, iphone: true };
    // Android: the APK, then Google Play once it is set; with neither, the web app and the APK's card saying so.
    expect(V.waysPlan('android', { apk: true })).toEqual({ lead: ['apk'], other: ['web', 'play', 'iphone'] });
    expect(V.waysPlan('android', all)).toEqual({ lead: ['apk', 'play'], other: ['web', 'iphone'] });
    expect(V.waysPlan('android', { play: true })).toEqual({ lead: ['play'], other: ['web', 'apk', 'iphone'] });
    expect(V.waysPlan('android', {})).toEqual({ lead: ['web', 'apk'], other: ['play', 'iphone'] });
    expect(V.waysPlan('android', { iphone: true })).toEqual({ lead: ['web', 'apk'], other: ['iphone', 'play'] });
    // An iPhone: the iPhone app and the web app, the one that works first, and no Android way at all.
    expect(V.waysPlan('ios', all)).toEqual({ lead: ['iphone', 'web'], other: [] });
    expect(V.waysPlan('ios', { apk: true, play: true })).toEqual({ lead: ['web', 'iphone'], other: [] });
    // A computer: the web app, and the APK when the site has one.
    expect(V.waysPlan('computer', { apk: true })).toEqual({ lead: ['web', 'apk'], other: ['play', 'iphone'] });
    expect(V.waysPlan('computer', { iphone: true })).toEqual({ lead: ['web'], other: ['iphone', 'apk', 'play'] });
    // Every way shows once.
    for (const d of ['android', 'computer'])
      for (const r of [{}, all, { apk: true }, { play: true }, { iphone: true }]) {
        const p = V.waysPlan(d, r);
        expect([...p.lead, ...p.other].sort(), `${d} ${JSON.stringify(r)}`).toEqual(['apk', 'iphone', 'play', 'web']);
      }
  });

  it('takes a store link only as https, and names TestFlight or the App Store by its host', () => {
    expect(V.storeLink({ play: { available: true, url: 'https://play.google.com/store/apps/details?id=x' } }, 'play')).toBe('https://play.google.com/store/apps/details?id=x');
    for (const bad of [null, {}, { play: null }, { play: { url: 'http://play.google.com/x' } }, { play: { url: 'javascript:alert(1)' } }, { play: { url: 42 } }]) expect(V.storeLink(bad, 'play')).toBeNull();
    expect(V.iosStore('https://testflight.apple.com/join/AbCd1234')).toBe('testflight');
    expect(V.iosStore('https://apps.apple.com/app/id1234567890')).toBe('appstore');
  });

  it('opens the web app on an event pass from the page\'s address, exactly as /j does', () => {
    expect(V.webAddress(null)).toBe('/v2/');
    expect(V.webAddress('pass-AbCd1234_xyz')).toBe('/v2/#join=pass-AbCd1234_xyz');
  });
});
