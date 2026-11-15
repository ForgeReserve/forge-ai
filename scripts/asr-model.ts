/**
 * Puts Forge Private Voice's speech to text in place (docs/VOICE.md, Bundled speech to text): the
 * sherpa-onnx 2.0.1 library (Apache-2.0, ONNX Runtime linked in, MIT) and Moonshine tiny English (MIT),
 * pinned in scripts/asr/lock.json by commit, size and SHA-256. Only the privatevoice flavour carries
 * them; the Gradle build runs this before a privatevoice build (android/app/build.gradle, task
 * forgeAsrFiles), so there is nothing to run by hand:
 *
 *   node scripts/asr-model.ts            download what is missing or wrong, then check everything
 *   node scripts/asr-model.ts --check    check only; no network; exits 1 when a file is missing
 *
 * The library goes to android/app/src/privatevoice/jniLibs/arm64-v8a/, the model to
 * android/app/src/privatevoice/assets/asr/<id>/ (stored uncompressed in the APK and read from there in
 * place), and the three licences from public/vendor/licenses/ to the flavour's own copy of that folder,
 * so the universal APK carries none of it. None of these is committed. A download lands in .tmp/asr-download
 * and is moved into place only once its size and hash match the lock; the release archive is unpacked with
 * tar, one named member only. Nothing downloaded is run here.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

export interface Pinned {
  size: number;
  sha256: string;
}
export interface ModelFile extends Pinned {
  role: string;
  name: string;
  url: string;
}
export interface AsrLock {
  runtime: {
    name: string;
    repo: string;
    tag: string;
    commit: string;
    license: string;
    archive: Pinned & { url: string };
    lib: Pinned & { member: string; name: string };
    onnxruntime: { version: string; commit: string; license: string };
    kotlinApi: { base: string; files: (Pinned & { name: string })[] };
  };
  model: { id: string; name: string; license: string; repo: string; revision: string; languages: string[]; files: ModelFile[] };
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const LOCK_PATH = join(ROOT, 'scripts', 'asr', 'lock.json');
export const FLAVOUR = join(ROOT, 'android', 'app', 'src', 'privatevoice');
export const LIB_DIR = join(FLAVOUR, 'jniLibs', 'arm64-v8a');
export const ASSETS = join(FLAVOUR, 'assets');
/** The licences the privatevoice APK carries on top of the universal one's (public/vendor/licenses/). */
export const LICENSES = ['sherpa-onnx.txt', 'onnxruntime.txt', 'moonshine.txt'];
const STAGE = join(ROOT, '.tmp', 'asr-download');
const PINNED = /^https:\/\/(huggingface\.co\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/resolve\/[0-9a-f]{40}\/|github\.com\/k2-fsa\/sherpa-onnx\/releases\/download\/v[0-9.]+\/)/;
const SAFE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The files the app loads, by role (AsrBundle.kt names them); the licence is only checked and copied. */
export const ROLES = ['encoder', 'mergedDecoder', 'tokens'];

/** The lock's shape: MIT or Apache-2.0 only, sherpa-onnx 2.x, pinned URLs, plain names, every role there. */
export function checkLock(lock: AsrLock): string[] {
  const errors: string[] = [];
  const r = lock.runtime;
  if (r.name !== 'sherpa-onnx' || !/^v2\./.test(r.tag)) errors.push('the runtime must be sherpa-onnx 2.x (releases before 2.0 carry eSpeak NG, GPL)');
  if (!/^[0-9a-f]{40}$/.test(r.commit) || !r.archive.url.includes(`/${r.tag}/`) || !PINNED.test(r.archive.url)) errors.push('sherpa-onnx archive: not a pinned release asset');
  if (r.license !== 'Apache-2.0' || r.onnxruntime.license !== 'MIT') errors.push('sherpa-onnx must be Apache-2.0 and ONNX Runtime MIT');
  if (r.lib.name !== 'libsherpa-onnx-jni.so' || r.lib.member !== `jniLibs/arm64-v8a/${r.lib.name}`) errors.push('the library must be the arm64 libsherpa-onnx-jni.so');
  for (const p of [r.archive, r.lib, ...r.kotlinApi.files]) {
    if (!/^[0-9a-f]{64}$/.test(p.sha256) || !(Number.isInteger(p.size) && p.size > 0)) errors.push('a runtime file has no size or sha256');
  }
  if (!r.kotlinApi.base.includes(r.commit)) errors.push('the Kotlin API files must come from the pinned commit');
  const m = lock.model;
  if (!SAFE.test(m.id)) errors.push(`${m.id}: bad id`);
  if (m.license !== 'MIT') errors.push(`${m.id}: licence ${m.license}, not MIT`);
  if (!/^[0-9a-f]{40}$/.test(m.revision)) errors.push(`${m.id}: revision is not a commit`);
  const roles = new Set(m.files.map((f) => f.role));
  for (const role of [...ROLES, 'license']) if (!roles.has(role)) errors.push(`${m.id}: no ${role} file`);
  for (const f of m.files) {
    if (!PINNED.test(f.url) || !f.url.includes(m.revision)) errors.push(`${m.id}/${f.name}: not a pinned URL`);
    if (!SAFE.test(f.name)) errors.push(`${m.id}/${f.name}: bad name`);
    if (!/^[0-9a-f]{64}$/.test(f.sha256) || !(Number.isInteger(f.size) && f.size > 0)) errors.push(`${m.id}/${f.name}: no size or sha256`);
  }
  return errors;
}

/** Where each file goes in the privatevoice source set, with its pin. */
export function placements(lock: AsrLock) {
  return [
    { what: lock.runtime.lib.name, to: join(LIB_DIR, lock.runtime.lib.name), pin: lock.runtime.lib },
    ...lock.model.files.filter((f) => f.role !== 'license').map((f) => ({ what: `${lock.model.id}/${f.name}`, to: join(ASSETS, 'asr', lock.model.id, f.name), pin: f as Pinned, url: f.url })),
  ];
}

/** Bytes the privatevoice APK adds: the library and the model files. */
export const addedBytes = (lock: AsrLock) => placements(lock).reduce((s, p) => s + p.pin.size, 0);

async function sha256(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(createReadStream(file), h);
  return h.digest('hex');
}

async function ok(file: string, pin: Pinned): Promise<boolean> {
  return existsSync(file) && statSync(file).size === pin.size && (await sha256(file)) === pin.sha256;
}

async function download(url: string, to: string, pin: Pinned): Promise<void> {
  mkdirSync(STAGE, { recursive: true });
  const tmp = join(STAGE, createHash('sha256').update(url).digest('hex').slice(0, 16));
  rmSync(tmp, { force: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(tmp));
  if (!(await ok(tmp, pin))) {
    rmSync(tmp, { force: true });
    throw new Error(`${url}: size or sha256 does not match scripts/asr/lock.json`);
  }
  mkdirSync(dirname(to), { recursive: true });
  renameSync(tmp, to);
}

/** The library from the release archive (downloaded once into .tmp/asr-download, checked). */
async function libFromArchive(lock: AsrLock, to: string, log: (s: string) => void) {
  const r = lock.runtime;
  const archive = join(STAGE, 'sherpa-onnx.tar.bz2');
  if (!(await ok(archive, r.archive))) {
    log(`downloading ${r.archive.url} (${(r.archive.size / 1e6).toFixed(1)} MB)`);
    await download(r.archive.url, archive, r.archive);
  }
  const out = join(STAGE, 'sherpa');
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  // The archive names its members ./jniLibs/...; bsdtar and GNU tar differ on whether the ./ is needed.
  let t = spawnSync('tar', ['-xjf', archive, '-C', out, `./${r.lib.member}`], { stdio: 'ignore' });
  if (t.status !== 0) t = spawnSync('tar', ['-xjf', archive, '-C', out, r.lib.member], { stdio: 'inherit' });
  if (t.status !== 0) throw new Error(`tar could not unpack ${r.lib.member}`);
  const got = join(out, r.lib.member);
  if (!(await ok(got, r.lib))) throw new Error(`${r.lib.name}: size or sha256 does not match scripts/asr/lock.json`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(got, to);
  rmSync(out, { recursive: true, force: true });
}

export async function run({ check = false, lockPath = LOCK_PATH, log = console.log } = {}): Promise<number> {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as AsrLock;
  const errors = checkLock(lock);
  if (errors.length) throw new Error(`scripts/asr/lock.json: ${errors.join('; ')}`);
  let missing = 0;
  for (const p of placements(lock)) {
    if (await ok(p.to, p.pin)) continue;
    if (check) {
      log(`missing or wrong: ${p.what}`);
      missing++;
      continue;
    }
    if ('url' in p && p.url) {
      log(`downloading ${p.what} (${(p.pin.size / 1e6).toFixed(1)} MB)`);
      await download(p.url, p.to, p.pin);
    } else await libFromArchive(lock, p.to, log);
  }
  // The licences, from the committed copies the website also serves.
  const lic = join(ASSETS, 'public', 'vendor', 'licenses');
  mkdirSync(lic, { recursive: true });
  for (const f of LICENSES) copyFileSync(join(ROOT, 'public', 'vendor', 'licenses', f), join(lic, f));
  if (missing) {
    log('the bundled speech to text is not in place: run node scripts/asr-model.ts');
    return 1;
  }
  log(`bundled speech to text in place: ${lock.model.name} and ${lock.runtime.lib.name}, ${(addedBytes(lock) / 1e6).toFixed(1)} MB in ${FLAVOUR}`);
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
