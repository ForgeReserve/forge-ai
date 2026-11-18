// /download: the Android app's APK from FORGE_APK_PATH, its SHA-256, and the page that offers it.
import { createHash } from 'node:crypto';
import { mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { APK_TYPE, apkSource, PRIVATE_VOICE_APK_URL } from '../../src/download.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { testCatalog } from '../e2e/helpers.ts';

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
      const html = await r.text();
      expect(html).toContain('/v2/download/download.js');
    }
    expect((await call('/v2/download/view.js')).status).toBe(200);
  });
});

describe('the download page', () => {
  it('offers Android first, and GrapheneOS only when the site has Forge Private Voice', () => {
    const h = 'b'.repeat(64);
    const one = V.apkChoices({ available: true, url: '/download/forge.apk', size: 92_000_000, sha256: h });
    expect(one.map((c: any) => [c.id, c.icon, c.file, c.url])).toEqual([['android', 'phone', 'forge.apk', '/download/forge.apk']]);
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
    });
    expect(V.apkView({ available: true, size: 1000, sha256: h }).mb).toBe('0.1');
    expect(V.apkView({ available: true, url: 'https://elsewhere.example/x.apk', size: 1000, sha256: h }).url).toBe('/download/forge.apk');
    for (const bad of [null, {}, { available: false }, { available: true, size: 10 }, { available: true, size: 10, sha256: 'xyz' }, { available: true, size: 0, sha256: h }]) {
      expect(V.apkView(bad)).toEqual({ available: false });
    }
  });
});
