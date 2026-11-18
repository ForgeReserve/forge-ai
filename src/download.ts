import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
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
        const h = createHash('sha256');
        // Read in one go: an APK is a few MB, and this runs once per new file.
        h.update(readFileSync(path));
        cached = { available: true, url, size: st.size, sha256: h.digest('hex') };
        key = k;
      }
      return cached;
    },
  };
}

/**
 * GET /download/info, GET /download/forge.apk and, when FORGE_APK_PRIVATE_VOICE_PATH is set, GET
 * /download/forge-private-voice.apk. The info is the universal APK's, with `privateVoice` (the same
 * fields) only while that APK is there, and `ios` ({available, url}) only while FORGE_IOS_URL is set:
 * the iPhone app's link, which Get the app opens on an iPhone (public/v2/core/getapp.js). The page
 * itself is served with the static files.
 */
export function registerDownloadRoutes(app: Hono, apk: ReturnType<typeof apkSource>, privateVoice?: ReturnType<typeof apkSource>, iosUrl?: string) {
  app.get('/download/info', (c) => {
    const pv = privateVoice?.info();
    return c.json({ ...apk.info(), ...(pv?.available ? { privateVoice: pv } : {}), ...(iosUrl ? { ios: { available: true, url: iosUrl } } : {}) }, 200, { 'Cache-Control': 'no-cache' });
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
