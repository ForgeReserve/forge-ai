import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { inflateRawSync } from 'node:zlib';
import type { Hono } from 'hono';
import { log } from './log.ts';

/** Where the APKs are offered. The page (public/v2/download/) reads /download/info. */
export const APK_URL = '/download/forge.apk';
/** Forge Private Voice, the APK for GrapheneOS with its own speech to text (FORGE_APK_PRIVATE_VOICE_PATH). */
export const PRIVATE_VOICE_APK_URL = '/download/forge-private-voice.apk';
export const APK_TYPE = 'application/vnd.android.package-archive';

export interface ApkInfo {
  available: boolean;
  url?: string;
  size?: number;
  sha256?: string;
  /** The app's versionName and versionCode, read from the APK's own manifest; left out when it cannot be read. */
  version?: string;
  versionCode?: number;
}

/** The largest AndroidManifest.xml read for its version (a real one is a few KB). */
const MANIFEST_MAX = 1 << 20;

/**
 * The versionName and versionCode an APK declares, read from its AndroidManifest.xml (Android's binary
 * XML inside the zip), or {} when the file is not an APK this can read. It reads the zip's central
 * directory, inflates the manifest and takes the two attributes of its first element, <manifest>, by
 * name or by their resource ids (android:versionCode 0x0101021b, android:versionName 0x0101021c).
 */
export function apkVersion(apk: Buffer): { version?: string; versionCode?: number } {
  try {
    const xml = zipEntry(apk, 'AndroidManifest.xml');
    return xml ? manifestVersion(xml) : {};
  } catch {
    return {};
  }
}

/** One entry of a zip file, by name: stored or deflated, at most MANIFEST_MAX bytes. */
function zipEntry(zip: Buffer, name: string): Buffer | null {
  // The end of central directory record: at least 22 bytes from the end, after a comment of up to 64 KB.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let p = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= zip.length; n++) {
    if (zip.readUInt32LE(p) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(p + 10);
    const packed = zip.readUInt32LE(p + 20);
    const size = zip.readUInt32LE(p + 24);
    const nameLen = zip.readUInt16LE(p + 28);
    const extraLen = zip.readUInt16LE(p + 30);
    const commentLen = zip.readUInt16LE(p + 32);
    const local = zip.readUInt32LE(p + 42);
    if (zip.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      if (size > MANIFEST_MAX || zip.readUInt32LE(local) !== 0x04034b50) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const data = zip.subarray(start, start + packed);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data, { maxOutputLength: MANIFEST_MAX });
      return null;
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** versionName and versionCode from Android binary XML: the string pool, the resource map and the first element. */
function manifestVersion(x: Buffer): { version?: string; versionCode?: number } {
  if (x.readUInt16LE(0) !== 0x0003) return {};
  let strings: string[] = [];
  let ids: number[] = [];
  for (let p = x.readUInt16LE(2); p + 8 <= x.length; ) {
    const type = x.readUInt16LE(p);
    const head = x.readUInt16LE(p + 2);
    const size = x.readUInt32LE(p + 4);
    if (size < 8) return {};
    if (type === 0x0001) strings = stringPool(x.subarray(p, p + size));
    else if (type === 0x0180) ids = Array.from({ length: (size - head) / 4 }, (_, i) => x.readUInt32LE(p + head + i * 4));
    else if (type === 0x0102) {
      // A start element: its attributes follow its own header.
      const name = strings[x.readUInt32LE(p + 20)];
      if (name !== 'manifest') return {};
      const at = p + head + x.readUInt16LE(p + 24);
      const each = x.readUInt16LE(p + 26);
      const out: { version?: string; versionCode?: number } = {};
      for (let i = 0, n = x.readUInt16LE(p + 28); i < n; i++) {
        const a = at + i * each;
        const key = x.readUInt32LE(a + 4);
        const attr = ids[key] === 0x0101021b ? 'versionCode' : ids[key] === 0x0101021c ? 'versionName' : strings[key];
        const raw = x.readUInt32LE(a + 8);
        const kind = x.readUInt8(a + 15);
        const data = x.readUInt32LE(a + 16);
        if (attr === 'versionName') {
          const s = raw !== 0xffffffff ? strings[raw] : kind === 0x03 ? strings[data] : undefined;
          if (typeof s === 'string' && /^[\w.+-]{1,40}$/.test(s)) out.version = s;
        } else if (attr === 'versionCode' && kind >= 0x10 && kind <= 0x11) out.versionCode = data;
      }
      return out;
    }
    p += size;
  }
  return {};
}

/** The strings of a string pool chunk, UTF-8 or UTF-16. */
function stringPool(c: Buffer): string[] {
  const count = c.readUInt32LE(8);
  const utf8 = (c.readUInt32LE(16) & 0x100) !== 0;
  const start = c.readUInt32LE(20);
  const head = c.readUInt16LE(2);
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    let p = start + c.readUInt32LE(head + i * 4);
    if (utf8) {
      // The length in UTF-16 units, then in bytes; each one or two bytes.
      p += c[p]! & 0x80 ? 2 : 1;
      const long = (c[p]! & 0x80) !== 0;
      const len = long ? ((c[p]! & 0x7f) << 8) | c[p + 1]! : c[p]!;
      p += long ? 2 : 1;
      out.push(c.toString('utf8', p, p + len));
    } else {
      const long = (c.readUInt16LE(p) & 0x8000) !== 0;
      const len = long ? ((c.readUInt16LE(p) & 0x7fff) << 16) | c.readUInt16LE(p + 2) : c.readUInt16LE(p);
      p += long ? 4 : 2;
      out.push(c.toString('utf16le', p, p + len * 2));
    }
  }
  return out;
}

/**
 * An Android APK, from the path in FORGE_APK_PATH or FORGE_APK_PRIVATE_VOICE_PATH (docs/ANDROID.md),
 * offered at url. Its SHA-256 is worked out when it is first asked for and again only when the file's
 * size or time changes, so a new APK put in place is picked up without a restart. Unset, or no file
 * there: not available, and the page says the app is coming (or, for Forge Private Voice, offers no choice).
 */
export function apkSource(path: string | undefined, url = APK_URL) {
  let key = '';
  let cached: ApkInfo = { available: false };
  let warned = false;
  return {
    path,
    info(): ApkInfo {
      if (!path) return { available: false };
      let st;
      try {
        st = statSync(path);
      } catch {
        if (!warned) log.warn('apk_missing', { path });
        warned = true;
        return { available: false };
      }
      if (!st.isFile() || st.size === 0) return { available: false };
      warned = false;
      const k = `${st.size}:${st.mtimeMs}`;
      if (k !== key) {
        // Read in one go: an APK is tens of MB, and this runs once per new file.
        const bytes = readFileSync(path);
        cached = { available: true, url, size: st.size, sha256: createHash('sha256').update(bytes).digest('hex'), ...apkVersion(bytes) };
        key = k;
      }
      return cached;
    },
  };
}

/** The store links /download/info carries: the iPhone app's (FORGE_IOS_URL) and Google Play's (FORGE_PLAY_URL). */
export interface StoreLinks {
  ios?: string;
  play?: string;
}

/**
 * GET /download/info, GET /download/forge.apk and, when FORGE_APK_PRIVATE_VOICE_PATH is set, GET
 * /download/forge-private-voice.apk. The info is the universal APK's (with its version when the APK's
 * manifest gives one), with `privateVoice` (the same fields) only while that APK is there, `ios`
 * ({available, url}) only while FORGE_IOS_URL is set (the iPhone app's link, which Get the app opens on
 * an iPhone, public/v2/core/getapp.js), and `play` ({available, url}) only while FORGE_PLAY_URL is set
 * (Forge on Google Play). The page itself is served with the static files.
 */
export function registerDownloadRoutes(app: Hono, apk: ReturnType<typeof apkSource>, privateVoice?: ReturnType<typeof apkSource>, links: StoreLinks = {}) {
  app.get('/download/info', (c) => {
    const pv = privateVoice?.info();
    return c.json(
      {
        ...apk.info(),
        ...(pv?.available ? { privateVoice: pv } : {}),
        ...(links.ios ? { ios: { available: true, url: links.ios } } : {}),
        ...(links.play ? { play: { available: true, url: links.play } } : {}),
      },
      200,
      { 'Cache-Control': 'no-cache' },
    );
  });
  const serve = (src: ReturnType<typeof apkSource>, url: string, filename: string) =>
    app.get(url, (c) => {
      const info = src.info();
      if (!info.available || !src.path) return c.json({ error: { message: 'the Android app is not available here yet', type: 'not_found', code: 'not_found' } }, 404);
      const body = Readable.toWeb(createReadStream(src.path)) as ReadableStream<Uint8Array>;
      return c.body(body, 200, {
        'Content-Type': APK_TYPE,
        'Content-Length': String(info.size),
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Cache-Control': 'no-cache',
        // The page shows the same value; a client can check the file against it.
        'X-Forge-Apk-Sha256': info.sha256!,
      });
    });
  serve(apk, APK_URL, 'forge.apk');
  serve(privateVoice ?? apkSource(undefined, PRIVATE_VOICE_APK_URL), PRIVATE_VOICE_APK_URL, 'forge-private-voice.apk');
}

/** The two Android apps (docs/ANDROID.md, Two APKs): Forge, and Forge Private Voice. */
export const ANDROID_PACKAGES = ['com.forgereserve.ai', 'com.forgereserve.ai.privatevoice'] as const;

/** The Digital Asset Links statement for both apps: Android may open this site's links in them (App Links). */
export function assetLinks(fingerprints: readonly string[]) {
  return ANDROID_PACKAGES.map((package_name) => ({
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name, sha256_cert_fingerprints: [...fingerprints] },
  }));
}

/**
 * GET /.well-known/assetlinks.json (FORGE_ANDROID_CERT_SHA256): JSON, straight from here and never a
 * redirect, as Android's verifier requires. With no fingerprint set it answers 404, so an event link
 * (/j) opens in the browser rather than in an app the site cannot vouch for.
 */
export function registerAppLinks(app: Hono, fingerprints: readonly string[]) {
  app.get('/.well-known/assetlinks.json', (c) => {
    if (!fingerprints.length) return c.json({ error: { message: 'no Android app is linked to this site', type: 'not_found', code: 'not_found' } }, 404);
    return c.json(assetLinks(fingerprints), 200, { 'Cache-Control': 'public, max-age=300' });
  });
}
