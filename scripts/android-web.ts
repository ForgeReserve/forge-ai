/**
 * Bundles the web app into the Android app's assets (scripts/lib/android-web.ts). The Gradle build
 * runs it before every build (android/app/build.gradle, task forgeWebAssets), so there is nothing to
 * run by hand:
 *
 *   node scripts/android-web.ts [assets dir, default android/app/src/main/assets]
 *
 * The app carries the natural voice (Phonon 31m and its voices, docs/VOICE.md), so it reads aloud
 * offline from the first open. Its files are put in place first (scripts/phonon-model.ts): downloaded
 * at build time when missing, at the commits and hashes in scripts/phonon/lock.json.
 */
import { resolve } from 'node:path';
import { run as phononModel } from './phonon-model.ts';
import { readConfig, writeBundle } from './lib/android-web.ts';

const root = resolve(import.meta.dirname, '..');
const assets = resolve(process.argv[2] ?? resolve(root, 'android/app/src/main/assets'));
if ((await phononModel()) !== 0) process.exit(1);
const r = writeBundle(resolve(root, 'public'), assets, readConfig(resolve(root, 'capacitor.config.json')));
console.log(`android web bundle: ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB in ${assets} (natural voice ${(r.voiceBytes / 1024 / 1024).toFixed(1)} MB)`);
