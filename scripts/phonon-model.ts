/**
 * Puts the on-device voice's files in place (docs/VOICE.md): Phonon 31m English (Apache-2.0), its
 * en-GB female voices from gradium/phonon-voices (Apache-2.0), and a few speakers from other locales the
 * voice lab alone offers, to hear what accent the English model gives them (labVoices), pinned to commits in
 * scripts/phonon/lock.json with each file's size and SHA-256.
 *
 *   node scripts/phonon-model.ts            download what is missing or wrong, then check everything
 *   node scripts/phonon-model.ts --check    check only; no network; exits 1 when a file is missing
 *
 * Downloads happen here, at build time, never in the app: the gateway serves the files from its own
 * origin under /v2/voice/phonon/ and the Android app carries them in the APK. A download lands in a
 * folder of its own (.tmp/phonon-download) and is moved into public/ only once its size and hash match
 * the lock. Nothing downloaded is ever run. When every file checks out, public/v2/voice/phonon/index.json
 * is written: the app reads it to know the files are there, how big they are and which voices it has.
 * Without it the app does not offer the on-device voice.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export interface LockFile {
  path: string;
  url: string;
  size: number;
  sha256: string;
}
export interface LockVoice {
  name: string;
  id: string;
  file: string;
  locale: string;
  gender: string;
  age: string;
  description: string;
  /** Lab voices only: what they are for: 'lab-only' (another voice to compare by ear) or 'accent-test'. */
  use?: string;
}
export interface Lock {
  model: { name: string; repo: string; revision: string; license: string; dir: string; weights: string; tokenizer: string; config: string };
  voiceRepo: { repo: string; revision: string; license: string; dir: string };
  defaultVoice: string;
  voices: LockVoice[];
  /** Voices the voice lab offers and the app never does (docs/VOICE.md): other en-GB voices and the accent test. */
  labVoices?: LockVoice[];
  files: LockFile[];
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_PATH = join(ROOT, 'scripts', 'phonon', 'lock.json');
export const OUT_DIR = join(ROOT, 'public', 'v2', 'voice', 'phonon');
const STAGE = join(ROOT, '.tmp', 'phonon-download');
const HF = /^https:\/\/huggingface\.co\/gradium\/phonon-(31m-en|voices)\/resolve\/[0-9a-f]{40}\//;

/** What a lab voice may be for: another voice to compare by ear, or the accent test. */
export const LAB_USES = ['lab-only', 'accent-test'];

/** Checks the lock's shape: pinned Hugging Face URLs only, safe relative paths, a default voice that exists. */
export function checkLock(lock: Lock): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const f of lock.files ?? []) {
    if (!HF.test(f.url)) errors.push(`${f.path}: not a pinned gradium/phonon URL`);
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(f.path) || f.path.includes('..')) errors.push(`${f.path}: bad path`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256)) errors.push(`${f.path}: bad sha256`);
    if (!(Number.isInteger(f.size) && f.size > 0)) errors.push(`${f.path}: bad size`);
    if (seen.has(f.path)) errors.push(`${f.path}: listed twice`);
    seen.add(f.path);
  }
  for (const p of [lock.model.weights, lock.model.tokenizer, lock.model.config]) if (!seen.has(p)) errors.push(`${p}: model file not in files`);
  for (const v of lock.voices ?? []) if (!seen.has(v.file)) errors.push(`${v.name}: voice file not in files`);
  const names = new Set<string>();
  for (const v of [...(lock.voices ?? []), ...(lock.labVoices ?? [])]) {
    if (names.has(v.name)) errors.push(`${v.name}: voice name listed twice`);
    names.add(v.name);
  }
  for (const v of lock.labVoices ?? []) {
    if (!seen.has(v.file)) errors.push(`${v.name}: lab voice file not in files`);
    if (!LAB_USES.includes(v.use ?? '')) errors.push(`${v.name}: a lab voice must say what it is for (use: ${LAB_USES.join(' or ')})`);
    if (!v.file.startsWith(`${lock.voiceRepo.dir}/`)) errors.push(`${v.name}: a lab voice must come from the pinned voice repo`);
  }
  if (!lock.voices?.some((v) => v.name === lock.defaultVoice)) errors.push(`default voice ${lock.defaultVoice} is not in voices`);
  if (!/Apache-2\.0/.test(lock.model.license) || !/Apache-2\.0/.test(lock.voiceRepo.license)) errors.push('only Apache-2.0 files may be bundled');
  if (!/^gradium\/phonon-31m-en$/.test(lock.model.repo)) errors.push('only Phonon 31m English is allowed (the 40m models are CC BY-NC)');
  return errors;
}

/** What the app reads (public/v2/voice/phonon/index.json): paths relative to that folder, sizes, voices. */
export function appIndex(lock: Lock) {
  const size = (p: string) => lock.files.find((f) => f.path === p)!.size;
  return {
    model: { name: lock.model.name, revision: lock.model.revision, license: lock.model.license, weights: lock.model.weights, tokenizer: lock.model.tokenizer, config: lock.model.config },
    voices: lock.voices.map((v) => ({ name: v.name, file: v.file, locale: v.locale, size: size(v.file) })),
    // The voice lab's own voices: the other en-GB voices (lab-only) and the accent test (other locales'
    // speakers read by the English model). Not in voices, so the app never offers them (core/phonon.js
    // modelSpec takes them only when asked for the lab).
    labVoices: (lock.labVoices ?? []).map((v) => ({ name: v.name, file: v.file, locale: v.locale, size: size(v.file), use: v.use, description: v.description })),
    defaultVoice: lock.defaultVoice,
    // Bytes the phone fetches the first time: the model and the default voice (other voices load when used).
    firstBytes: size(lock.model.weights) + size(lock.model.tokenizer) + size(lock.model.config) + size(lock.voices.find((v) => v.name === lock.defaultVoice)!.file),
    files: lock.files.map((f) => ({ path: f.path, size: f.size, sha256: f.sha256 })),
  };
}

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function fileOk(file: string, f: LockFile): Promise<boolean> {
  return existsSync(file) && statSync(file).size === f.size && (await sha256(file)) === f.sha256;
}

async function download(f: LockFile, to: string): Promise<void> {
  mkdirSync(STAGE, { recursive: true });
  const tmp = join(STAGE, f.path.replace('/', '__'));
  rmSync(tmp, { force: true });
  const res = await fetch(f.url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${f.path}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
  if (!(await fileOk(tmp, f))) {
    rmSync(tmp, { force: true });
    throw new Error(`${f.path}: size or sha256 does not match the lock`);
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(tmp, to);
}

export async function run({ check = false, out = OUT_DIR, lockPath = LOCK_PATH, log = console.log } = {}): Promise<number> {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lock;
  const errors = checkLock(lock);
  if (errors.length) throw new Error(`scripts/phonon/lock.json: ${errors.join('; ')}`);
  const index = join(out, 'index.json');
  let missing = 0;
  for (const f of lock.files) {
    const to = join(out, f.path);
    if (await fileOk(to, f)) continue;
    if (check) {
      log(`missing or wrong: ${f.path}`);
      missing++;
      continue;
    }
    log(`downloading ${f.path} (${(f.size / 1e6).toFixed(1)} MB)`);
    await download(f, to);
  }
  if (missing) {
    rmSync(index, { force: true });
    log('the on-device voice is not in place: run node scripts/phonon-model.ts');
    return 1;
  }
  writeFileSync(index, JSON.stringify(appIndex(lock), null, 2) + '\n');
  log(`on-device voice in place: ${lock.files.length} files, ${(lock.files.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(1)} MB in ${out}`);
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run({ check: process.argv.includes('--check') }).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exit(1);
    },
  );
}
