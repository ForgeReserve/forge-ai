/**
 * Reads lines aloud with the app's own natural voice, for scripts/record-voice/record.py (the Phonon
 * path, its default): Phonon 31m English through the vendored phonon-tts, in headless Chrome, on the
 * processor on one thread, with a fixed seed and temperature, so the same words give the same sound.
 * The model and the voices are the build's own (public/v2/voice/phonon, put there by
 * scripts/phonon-model.ts); nothing is fetched from another site.
 *
 *   node scripts/record-voice/phonon-render.ts <jobs.json> <out dir>
 *
 * jobs.json: {voice, seed, temperature, jobs: [{step, text}]}. Writes <out dir>/<step>.f32 (mono float32,
 * little-endian) and prints one JSON line: {sampleRate, voice, voiceFile, model, revision, package,
 * device, threads, seed, temperature, clips: {step: {samples}}}.
 */
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = join(ROOT, 'public');
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.json': 'application/json', '.wasm': 'application/wasm', '.gguf': 'application/octet-stream', '.safetensors': 'application/octet-stream', '.html': 'text/html' };
// Only what the voice needs: the package, the engine wrapper, the model and its index.
const SERVED = [/^\/v2\/vendor\/phonon-tts\//, /^\/v2\/voice\/phonon\//, /^\/v2\/core\/phonon\.js$/, /^\/blank\.html$/];

const [jobsPath, outDir] = process.argv.slice(2);
if (!jobsPath || !outDir) {
  console.error('usage: node scripts/record-voice/phonon-render.ts <jobs.json> <out dir>');
  process.exit(2);
}
const job = JSON.parse(readFileSync(jobsPath, 'utf8')) as { voice: string; seed: number; temperature: number; jobs: { step: string; text: string }[] };
const index = JSON.parse(readFileSync(join(PUBLIC, 'v2/voice/phonon/index.json'), 'utf8'));
const voice = index.voices.find((v: any) => v.name === job.voice);
if (!voice) throw new Error(`${job.voice} is not one of the app's voices (${index.voices.map((v: any) => v.name).join(', ')})`);
mkdirSync(outDir, { recursive: true });

const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
  if (!SERVED.some((r) => r.test(path))) return void res.writeHead(404).end();
  if (path === '/blank.html') return void res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>record</title>');
  const file = normalize(join(PUBLIC, path));
  if (!file.startsWith(PUBLIC + sep) || !existsSync(file) || !statSync(file).isFile()) return void res.writeHead(404).end();
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'content-length': statSync(file).size });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
const origin = `http://127.0.0.1:${(server.address() as any).port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${origin}/blank.html`);
  const info = await page.evaluate(
    async ({ voice, seed, temperature, jobs }) => {
      const { modelSpec } = await import('/v2/core/phonon.js' as string);
      const { PhononTTS } = await import('/v2/vendor/phonon-tts/index.js' as string);
      const index = await (await fetch('/v2/voice/phonon/index.json')).json();
      const tts = await PhononTTS.load({ lang: 'en', model: modelSpec(index, new URL('/v2/voice/phonon/', location.href).href, voice), cache: false, device: 'cpu', threads: 1 });
      const w = window as any;
      w.__clips = {};
      for (const { step, text } of jobs) {
        const pcm: Float32Array = await tts.synth(text, { voice, seed, temperature });
        // Base64 of the float32 bytes: the page hands them over as text.
        const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        w.__clips[step] = btoa(bin);
      }
      const out = { sampleRate: tts.sampleRate, device: tts.device, threads: tts.threads };
      tts.dispose();
      return out;
    },
    { voice: job.voice, seed: job.seed, temperature: job.temperature, jobs: job.jobs },
  );
  const clips: Record<string, { samples: number }> = {};
  for (const { step } of job.jobs) {
    const b64 = await page.evaluate((s) => (window as any).__clips[s] as string, step);
    const buf = Buffer.from(b64, 'base64');
    writeFileSync(resolve(outDir, `${step}.f32`), buf);
    clips[step] = { samples: buf.length / 4 };
  }
  if (errors.length) throw new Error(errors.join('; '));
  const pkg = JSON.parse(readFileSync(join(PUBLIC, 'v2/vendor/phonon-tts/VERSION.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'scripts/phonon/lock.json'), 'utf8'));
  console.log(
    JSON.stringify({
      ...info,
      voice: job.voice,
      voiceFile: voice.file,
      voiceRepo: `${lock.voiceRepo.repo}@${lock.voiceRepo.revision}`,
      model: `${lock.model.repo}@${index.model.revision}`,
      package: `phonon-tts ${pkg.version}`,
      seed: job.seed,
      temperature: job.temperature,
      clips,
    }),
  );
} finally {
  await browser.close();
  server.close();
}
