import { createHash } from 'node:crypto';
import { createReadStream, readFileSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Hono } from 'hono';
import { log } from './log.ts';

/** Where the APK is offered. The page (public/v2/download/) reads /download/info. */
export const APK_URL = '/download/forge.apk';
export const APK_TYPE = 'application/vnd.android.package-archive';

export interface ApkInfo {
  available: boolean;
  url?: string;
  size?: number;
  sha256?: string;
}

/**
 * The Android app's APK, from the path in FORGE_APK_PATH (docs/ANDROID.md). Its SHA-256 is worked out
 * when it is first asked for and again only when the file's size or time changes, so a new APK put in
 * place is picked up without a restart. Unset, or no file there: not available, and the page says the
 * app is coming.
 */
export function apkSource(path: string | undefined) {
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
        cached = { available: true, url: APK_URL, size: st.size, sha256: h.digest('hex') };
        key = k;
      }
      return cached;
    },
  };
}

/** GET /download/info and GET /download/forge.apk. The page itself is served with the static files. */
export function registerDownloadRoutes(app: Hono, apk: ReturnType<typeof apkSource>) {
  app.get('/download/info', (c) => c.json(apk.info(), 200, { 'Cache-Control': 'no-cache' }));
  app.get(APK_URL, (c) => {
    const info = apk.info();
    if (!info.available || !apk.path) return c.json({ error: { message: 'the Android app is not available here yet', type: 'not_found', code: 'not_found' } }, 404);
    const body = Readable.toWeb(createReadStream(apk.path)) as ReadableStream<Uint8Array>;
    return c.body(body, 200, {
      'Content-Type': APK_TYPE,
      'Content-Length': String(info.size),
      'Content-Disposition': 'attachment; filename="forge.apk"',
      'Cache-Control': 'no-cache',
      // The page shows the same value; a client can check the file against it.
      'X-Forge-Apk-Sha256': info.sha256!,
    });
  });
}
