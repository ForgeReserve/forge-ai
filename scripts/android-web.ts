/**
 * Bundles the web app into the Android app's assets (scripts/lib/android-web.ts). The Gradle build
 * runs it before every build (android/app/build.gradle, task forgeWebAssets), so there is nothing to
 * run by hand:
 *
 *   node scripts/android-web.ts [assets dir, default android/app/src/main/assets]
 */
import { resolve } from 'node:path';
import { readConfig, writeBundle } from './lib/android-web.ts';

const root = resolve(import.meta.dirname, '..');
const assets = resolve(process.argv[2] ?? resolve(root, 'android/app/src/main/assets'));
const r = writeBundle(resolve(root, 'public'), assets, readConfig(resolve(root, 'capacitor.config.json')));
console.log(`android web bundle: ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB in ${assets}`);
