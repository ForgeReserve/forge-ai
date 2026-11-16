/**
 * Bundles the web app into the iPhone app (scripts/lib/android-web.ts, the same files as the APK). The
 * Xcode build runs it before every build (ios/App/App.xcodeproj, phase "Bundle the web app"), so there
 * is nothing to run by hand; `pnpm ios:web` does it alone:
 *
 *   node scripts/ios-web.ts [app folder, default ios/App/App]
 *
 * Like the APK, the app carries the natural voice, put in place first (scripts/phonon-model.ts).
 */
import { resolve } from 'node:path';
import { run as phononModel } from './phonon-model.ts';
import { readConfig, writeBundle } from './lib/android-web.ts';

const root = resolve(import.meta.dirname, '..');
const out = resolve(process.argv[2] ?? resolve(root, 'ios/App/App'));
if ((await phononModel()) !== 0) process.exit(1);
const r = writeBundle(resolve(root, 'public'), out, readConfig(resolve(root, 'capacitor.config.json')), 'ios');
console.log(`ios web bundle: ${r.files} files, ${(r.bytes / 1024 / 1024).toFixed(1)} MB in ${out} (natural voice ${(r.voiceBytes / 1024 / 1024).toFixed(1)} MB)`);
