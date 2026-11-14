import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { appIndex, checkLock, type Lock } from '../../../scripts/phonon-model.ts';

// The natural voice made on the phone (Phonon 31m through the vendored phonon-tts): the model's files
// and where they come from, the engine wrapper, the voice-out module, the choice of voice, the one-time
// download question, and the voice lab's numbers.
const P: any = await import('../../../public/v2/core/phonon.js' as string);
const MOD: any = await import('../../../public/v2/modules/voice-out/phonon/index.js' as string);
const STATE: any = await import('../../../public/v2/core/state.js' as string);
const R: any = await import('../../../public/v2/core/registry.js' as string);
const CTL: any = await import('../../../public/v2/core/talkctl.js' as string);
const LAB: any = await import('../../../public/v2/core/voicelab.js' as string);

const ROOT = resolve(import.meta.dirname, '../../..');
const PUBLIC = join(ROOT, 'public');
const LOCK = JSON.parse(readFileSync(join(ROOT, 'scripts/phonon/lock.json'), 'utf8')) as Lock;
const BASE = 'https://app.test/v2/voice/phonon/';
const INDEX = appIndex(LOCK);

describe('the pinned voice files', () => {
  it('pins Phonon 31m English and only en-GB female voices from gradium, by commit, size and SHA-256', () => {
    expect(checkLock(LOCK)).toEqual([]);
    expect(LOCK.model.repo).toBe('gradium/phonon-31m-en');
    expect(LOCK.model.revision).toMatch(/^[0-9a-f]{40}$/);
    expect(LOCK.voiceRepo.revision).toMatch(/^[0-9a-f]{40}$/);
    // The app offers two: Maeve (the default) and Freya. The other five en-GB voices are the lab's.
    expect(LOCK.voices.map((v) => v.name)).toEqual(['Maeve', 'Freya']);
    expect(LOCK.defaultVoice).toBe('Maeve');
    const others = (LOCK.labVoices ?? []).filter((v) => v.use === 'lab-only');
    expect(others.map((v) => v.name)).toEqual(['Pippa', 'Elodie-Rose', 'Imogen', 'Lottie', 'Bryony']);
    for (const v of [...LOCK.voices, ...others]) expect([v.locale, v.gender]).toEqual(['en-gb', 'female']);
    // Every voice's file still ships: Freya's for the picker, the rest for the lab.
    for (const v of [...LOCK.voices, ...(LOCK.labVoices ?? [])]) expect(INDEX.files.map((f) => f.path), v.name).toContain(v.file);
    for (const f of LOCK.files) expect(f.url).toContain(f.path.startsWith('31m') ? LOCK.model.revision : LOCK.voiceRepo.revision);
    // The weights file the model card names: 64.5 MB, 8-bit.
    expect(LOCK.files.find((f) => f.path === LOCK.model.weights)!.size).toBe(64_512_352);
  });

  it('pins the accent-test speakers for the voice lab alone: female es-MX, es-ES, pt-BR and fr-FR, from the same voice commit', () => {
    const lab = (LOCK.labVoices ?? []).filter((v) => v.use === 'accent-test');
    expect(lab.map((v) => [v.name, v.locale])).toEqual([
      ['Regina', 'es-mx'],
      ['Ximena', 'es-mx'],
      ['Alba', 'es-es'],
      ['Isadora', 'pt-br'],
      ['Maëlys', 'fr-fr'],
    ]);
    for (const v of lab) {
      expect([v.gender, v.use]).toEqual(['female', 'accent-test']);
      expect(v.description.length).toBeGreaterThan(20);
      const f = LOCK.files.find((x) => x.path === v.file)!;
      expect(f.url).toBe(`https://huggingface.co/gradium/phonon-voices/resolve/${LOCK.voiceRepo.revision}/voices/${v.id}.safetensors`);
      expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    // The app's voices are what they were: the accent test is not among them.
    expect(INDEX.voices.map((v) => v.name)).not.toContain('Regina');
    expect(INDEX.labVoices.filter((v) => v.use === 'accent-test').map((v) => v.name)).toEqual(lab.map((v) => v.name));
    expect(INDEX.files.map((f) => f.path)).toEqual(expect.arrayContaining(lab.map((v) => v.file)));
  });

  it('refuses a lab voice that does not say what it is for, comes from elsewhere, or reuses a name', () => {
    const bad = structuredClone(LOCK);
    const at = (n: string) => bad.labVoices!.find((v) => v.name === n)!;
    at('Regina').use = 'app';
    delete at('Pippa').use;
    at('Ximena').name = 'Maeve';
    at('Alba').file = '31m-en-92741c5/x.safetensors';
    const errors = checkLock(bad).join('\n');
    expect(errors).toMatch(/Regina: a lab voice must say what it is for \(use: lab-only or accent-test\)/);
    expect(errors).toMatch(/Pippa: a lab voice must say what it is for/);
    expect(errors).toMatch(/Maeve: voice name listed twice/);
    expect(errors).toMatch(/Alba: lab voice file not in files/);
    expect(errors).toMatch(/Alba: a lab voice must come from the pinned voice repo/);
  });

  it('refuses a lock that would bundle a non-commercial model, an unpinned URL or a path outside the folder', () => {
    const bad = structuredClone(LOCK);
    bad.model.repo = 'gradium/phonon-40m-en';
    bad.files[0]!.url = 'https://huggingface.co/gradium/phonon-31m-en/resolve/main/config.json';
    bad.files[1]!.path = '../x/tokenizer.json';
    const errors = checkLock(bad).join('\n');
    expect(errors).toMatch(/40m models are CC BY-NC/);
    expect(errors).toMatch(/not a pinned gradium\/phonon URL/);
    expect(errors).toMatch(/bad path/);
  });

  it('tells the app the size of a first use: the model and the default voice, not every voice', () => {
    const size = (p: string) => LOCK.files.find((f) => f.path === p)!.size;
    const def = LOCK.voices.find((v) => v.name === LOCK.defaultVoice)!;
    expect(INDEX.firstBytes).toBe(size(LOCK.model.weights) + size(LOCK.model.tokenizer) + size(LOCK.model.config) + size(def.file));
    expect(INDEX.voices).toHaveLength(2);
    expect(JSON.stringify(INDEX)).not.toMatch(/huggingface/);
  });

  it('keeps the downloaded files out of git, and the index the app reads too', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^public\/v2\/voice\/phonon\/\*\/$/m);
    expect(ignore).toMatch(/^public\/v2\/voice\/phonon\/index\.json$/m);
  });
});

describe('the vendored phonon-tts package', () => {
  const DIR = join(PUBLIC, 'v2/vendor/phonon-tts');
  it('is 0.7.0 from npm, as plain files with its licences beside the others', () => {
    const v = JSON.parse(readFileSync(join(DIR, 'VERSION.json'), 'utf8'));
    expect(v.version).toBe('0.7.0');
    expect(v.integrity).toMatch(/^sha512-/);
    for (const f of ['index.js', 'worker.js', 'fetch.js', 'wasm/phonon_tts.js', 'wasm/phonon_tts_simd_bg.wasm', 'wasm-threads/phonon_tts.js', 'wasm-threads/phonon_tts_simd_bg.wasm']) expect(existsSync(join(DIR, f)), f).toBe(true);
    expect(readFileSync(join(PUBLIC, 'vendor/licenses/phonon-tts.txt'), 'utf8')).toMatch(/MIT OR Apache-2\.0/);
    expect(existsSync(join(PUBLIC, 'vendor/licenses/phonon-tts-THIRD_PARTY_LICENSES.md'))).toBe(true);
    expect(readFileSync(join(PUBLIC, 'vendor/licenses/phonon-models.txt'), 'utf8')).toMatch(/Apache License/);
  });

  it('is only ever handed a model on this app: no app file names Hugging Face or the default model', () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (!p.includes('/vendor/') && !p.includes('/voice/phonon')) walk(p);
        } else if (n.endsWith('.js')) files.push(p);
      }
    };
    walk(join(PUBLIC, 'v2'));
    expect(files.length).toBeGreaterThan(50);
    for (const f of files) expect(readFileSync(f, 'utf8'), f).not.toMatch(/huggingface|hf:\/\/|DEFAULT_MODEL/);
  });
});

describe('the model as phonon-tts takes it', () => {
  it('points every file at this app, with the default voice first', () => {
    const spec = P.modelSpec(INDEX, BASE);
    expect(spec.weights.q8).toBe(`${BASE}${LOCK.model.weights}`);
    expect(spec.defaultVoice).toBe(LOCK.defaultVoice);
    expect(Object.keys(spec.voices)).toEqual(['Maeve', 'Freya']);
    expect(P.sameOrigin(spec, 'https://app.test')).toBe(true);
    expect(P.sameOrigin(spec, 'https://other.test')).toBe(false);
    expect(P.modelSpec(INDEX, BASE, 'Freya').defaultVoice).toBe('Freya');
    // A lab-only voice is not the app's to start with.
    expect(P.modelSpec(INDEX, BASE, 'Bryony').defaultVoice).toBe(LOCK.defaultVoice);
    expect(P.modelSpec(INDEX, BASE, 'Bryony', { lab: true }).defaultVoice).toBe('Bryony');
    expect(P.modelSpec(INDEX, BASE, 'Nobody').defaultVoice).toBe(LOCK.defaultVoice);
  });

  it('hands the other en-GB voices and the accent-test voices to the voice lab only', () => {
    expect(Object.keys(P.modelSpec(INDEX, BASE).voices)).not.toContain('Regina');
    expect(Object.keys(P.modelSpec(INDEX, BASE).voices)).not.toContain('Bryony');
    const lab = P.modelSpec(INDEX, BASE, null, { lab: true });
    expect(Object.keys(lab.voices)).toEqual([...INDEX.voices.map((v: any) => v.name), ...INDEX.labVoices.map((v: any) => v.name)]);
    expect(lab.defaultVoice).toBe(LOCK.defaultVoice);
    expect(P.sameOrigin(lab, 'https://app.test')).toBe(true);
  });

  it('refuses a path that would leave the voice folder', () => {
    expect(() => P.modelSpec({ ...INDEX, model: { ...INDEX.model, weights: '../../x.gguf' } }, BASE)).toThrow(/bad model path/);
    expect(() => P.modelSpec({ ...INDEX, model: { ...INDEX.model, weights: 'https://evil.test/x.gguf' } }, BASE)).toThrow(/bad model path/);
  });

  it('runs only with WebAssembly SIMD and workers', () => {
    expect(P.canRun({ Worker: function () {}, WebAssembly })).toBe(true);
    expect(P.canRun({ WebAssembly })).toBe(false);
    expect(P.canRun({ Worker: function () {}, WebAssembly: { validate: () => false } })).toBe(false);
    expect(P.canRun({ Worker: function () {} })).toBe(false);
  });

  it('finds broken sound: NaN, silence and clipping', () => {
    const ok = P.soundCheck([new Float32Array([0.1, -0.2]), new Float32Array([0.3])]);
    expect(ok).toMatchObject({ samples: 3, nan: 0, silent: false, clipped: 0 });
    expect(ok.peak).toBeCloseTo(0.3);
    expect(P.soundCheck([new Float32Array([NaN, 0.5])]).nan).toBe(1);
    expect(P.soundCheck([new Float32Array(100)]).silent).toBe(true);
    expect(P.soundCheck([]).silent).toBe(true);
    expect(P.soundCheck([new Float32Array([1, -0.995, 0.2])]).clipped).toBe(2);
  });
});

/**
 * A fake phonon-tts: records how it was loaded and streams the chunks given. gpu: what a load asking for
 * WebGPU ('webgpu' or 'auto') ends up on, and how its streams go: 'ok', 'start' (WebGPU fails to start,
 * so 'auto' runs on the processor), 'error' (the first stream throws), 'silent' (it ends with no sound)
 * or 'hang' (no sound ever comes).
 */
function fakeLib(chunks: Float32Array[] = [new Float32Array(1920).fill(0.1), new Float32Array(1920).fill(0.2)], { gpu = 'ok' }: { gpu?: string } = {}) {
  const loads: any[] = [];
  const made: any[] = [];
  const lib = {
    PhononTTS: {
      load: async (opts: any) => {
        loads.push(opts);
        opts.onProgress?.({ file: 'weights', loaded: 50, total: 100, cached: false });
        const wantsGpu = opts.device === 'webgpu' || opts.device === 'auto';
        const device = wantsGpu && !(gpu === 'start' && opts.device === 'auto') ? 'webgpu' : 'cpu';
        const onGpu = device === 'webgpu';
        let disposed = false;
        const tts = {
          sampleRate: 24000,
          device,
          deviceReason: device === 'cpu' && wantsGpu ? 'WebGPU failed to start: fake' : 'requested',
          streams: [] as string[],
          dispose: vi.fn(() => (disposed = true)),
          stream: (text: string, { signal, voice }: any = {}) => ({
            async *[Symbol.asyncIterator]() {
              tts.streams.push(`${voice ?? ''}:${text}`);
              if (onGpu && gpu === 'error') throw new Error('fake GPU error');
              if (onGpu && gpu === 'silent') return;
              if (onGpu && gpu === 'hang') {
                while (!disposed) await new Promise((r) => setTimeout(r, 2));
                throw new Error('this PhononTTS has been disposed');
              }
              for (const c of chunks) {
                if (signal?.aborted) return;
                await new Promise((r) => setTimeout(r, 1));
                yield c;
              }
            },
          }),
        };
        made.push(tts);
        return tts;
      },
    },
  };
  return { lib, loads, made };
}

/** A browser's global object as the engine reads it: WebGPU's adapter, if any, and isolation. */
function browserEnv({ vendor = null as string | null, fallback = false, isolated = true } = {}) {
  const adapter = vendor == null ? null : { info: { vendor, architecture: vendor === 'arm' ? 'valhall' : 'metal-3', isFallbackAdapter: fallback }, features: new Set() };
  return { Worker: function () {}, WebAssembly, crossOriginIsolated: isolated, navigator: { gpu: { requestAdapter: async () => adapter } } };
}

function engine({ index = INDEX as any, native = false, cached = false, lib = fakeLib().lib, env = { Worker: function () {}, WebAssembly } as any, memory = undefined as any, voice = undefined as any, firstSoundMs = undefined as any } = {}) {
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    return index ? new Response(JSON.stringify(index)) : new Response('', { status: 404 });
  };
  const caches = { open: async () => ({ match: async (u: string) => (cached && u.endsWith('model.q8.gguf') ? new Response('x') : undefined) }) };
  return { ph: P.createPhonon({ base: BASE, native, importLib: async () => lib, fetch, caches, env, memory, voice, firstSoundMs }), fetched };
}

/** Settings kept the way the app keeps them: a value per key. */
function memoryStore(initial: string | null = null) {
  const m = { value: initial, writes: 0, get: () => m.value, set: (v: string) => ((m.value = v), m.writes++) };
  return m;
}

const readAll = async (tts: any, text: string, opts: any = {}) => {
  const got: Float32Array[] = [];
  for await (const pcm of tts.stream(text, opts)) got.push(pcm);
  return got;
};

describe('the download meter', () => {
  const size = (p: string) => LOCK.files.find((f) => f.path === p)!.size;
  it('adds up phonon-tts reports per file into one download of the first-use size', () => {
    const m = P.createMeter(INDEX);
    expect(m.view()).toEqual({ loaded: 0, total: INDEX.firstBytes, fraction: 0, fetched: false });
    const w = size(LOCK.model.weights);
    let v = m.update({ file: 'weights', loaded: w / 2, total: w, cached: false });
    expect(v.loaded).toBe(w / 2);
    expect(v.total).toBe(INDEX.firstBytes);
    expect(v.fetched).toBe(true);
    // A file from the cache counts as done at once; a report without a length uses the index's size.
    m.update({ file: 'config', loaded: size(LOCK.model.config), total: size(LOCK.model.config), cached: true });
    m.update({ file: 'tokenizer', loaded: 1000, total: null, cached: false });
    m.update({ file: 'weights', loaded: w, total: w, cached: false });
    m.update({ file: 'tokenizer', loaded: size(LOCK.model.tokenizer), total: null, cached: false });
    v = m.update({ file: `voice:${LOCK.defaultVoice}`, loaded: 256136, total: 256136, cached: false });
    expect(v).toEqual({ loaded: INDEX.firstBytes, total: INDEX.firstBytes, fraction: 1, fetched: true });
  });

  it('counts the voice it starts with, not the default, when another is picked', () => {
    const files = P.loadFiles(INDEX, 'Bryony').map((f: any) => f.file);
    expect(files).toEqual(['weights', 'tokenizer', 'config', 'voice:Bryony']);
    expect(P.loadFiles(INDEX).at(-1).file).toBe(`voice:${LOCK.defaultVoice}`);
  });

  it('reads as MB done of MB in all and a whole percent', () => {
    expect(P.meterNumbers({ loaded: 12_345_678, total: 65_123_456, fraction: 12_345_678 / 65_123_456 })).toEqual({ done: '12.3', total: '65.1', pct: 18 });
    expect(P.meterNumbers({ loaded: 65e6, total: 65e6, fraction: 1 })).toEqual({ done: '65.0', total: '65.0', pct: 100 });
    expect(P.meterNumbers()).toEqual({ done: '0.0', total: '0.0', pct: 0 });
  });
});

describe('the phone Phonon engine', () => {
  it('offers the voice only once the build put its files here', async () => {
    const none = engine({ index: null });
    expect(await none.ph.init()).toBeNull();
    expect(none.ph.available()).toBe(false);
    const some = engine();
    expect(some.ph.available()).toBe(false);
    await some.ph.init();
    expect(some.ph.available()).toBe(true);
    expect(some.fetched).toEqual([`${BASE}index.json`]);
  });

  it('asks for a download on the website until the model is in the cache, never in the Android app', async () => {
    expect(await engine().ph.download()).toEqual({ needed: true, bytes: INDEX.firstBytes });
    expect(await engine({ cached: true }).ph.download()).toEqual({ needed: false, bytes: 0 });
    expect(await engine({ native: true }).ph.download()).toEqual({ needed: false, bytes: 0 });
  });

  it('loads the model from this app only, kept in the cache on the website and read from the APK in the app', async () => {
    const web = fakeLib();
    const a = engine({ lib: web.lib, env: browserEnv() });
    const tts = await a.ph.load();
    expect(await a.ph.load()).toBe(tts); // loaded once
    expect(web.loads).toHaveLength(1);
    const opts = web.loads[0];
    expect(opts).toMatchObject({ lang: 'en', cache: true, device: 'cpu', threads: 'auto' });
    expect(typeof opts.model).toBe('object');
    expect(P.sameOrigin(opts.model, 'https://app.test')).toBe(true);
    const app = fakeLib();
    await engine({ native: true, lib: app.lib }).ph.load({ device: 'webgpu', threads: 1 });
    expect(app.loads[0]).toMatchObject({ cache: false, device: 'webgpu', threads: 1 });
  });

  it('loads the lab model with the lab voices apart from the app model, which never has them', async () => {
    const f = fakeLib();
    const a = engine({ lib: f.lib });
    await a.ph.load();
    const lab = await a.ph.load({ device: 'cpu', lab: true });
    expect(lab).toBe(f.made[1]);
    expect(Object.keys(f.loads[0].model.voices)).not.toContain('Regina');
    expect(Object.keys(f.loads[1].model.voices)).toContain('Regina');
    await a.ph.unload({ device: 'cpu', lab: true });
    expect(lab.dispose).toHaveBeenCalled();
    expect(f.made[0].dispose).not.toHaveBeenCalled();
  });

  it('frees a model when asked, and loads it again after', async () => {
    const f = fakeLib();
    const a = engine({ lib: f.lib });
    await a.ph.load();
    await a.ph.unload();
    expect(f.made[0].dispose).toHaveBeenCalled();
    await a.ph.load();
    expect(f.loads).toHaveLength(2);
    await a.ph.load({ device: 'webgpu' });
    await a.ph.unload({ device: 'webgpu' });
    expect(f.made[2].dispose).toHaveBeenCalled();
  });
});

describe('where the natural voice runs (measured on phones, docs/VOICE.md)', () => {
  const apple = { vendor: 'apple', architecture: 'metal-3', fallback: false };
  it("uses the graphics chip when WebGPU's adapter is Apple's (iPhone: RTF 0.045 against 0.147 on the processor)", () => {
    expect(P.chooseVoiceDevice({ gpu: apple, isolated: true })).toMatchObject({ device: 'webgpu', threads: 'auto' });
    expect(P.chooseVoiceDevice({ gpu: { ...apple, vendor: 'Apple' }, isolated: false })).toMatchObject({ device: 'webgpu' });
  });
  it('uses the processor with threads on an Arm Mali (valhall), where WebGPU was 5 times slower (Pixel 8 Pro)', () => {
    expect(P.chooseVoiceDevice({ gpu: { vendor: 'arm', architecture: 'valhall', fallback: false }, isolated: true })).toMatchObject({ device: 'cpu', threads: 'auto' });
    expect(P.chooseVoiceDevice({ gpu: { vendor: 'nvidia', architecture: '', fallback: false }, isolated: true })).toMatchObject({ device: 'cpu', threads: 'auto' });
  });
  it('never uses a software fallback adapter, even one that says Apple', () => {
    expect(P.chooseVoiceDevice({ gpu: { ...apple, fallback: true }, isolated: true })).toMatchObject({ device: 'cpu', threads: 'auto' });
  });
  it('uses the processor with no WebGPU', () => {
    expect(P.chooseVoiceDevice({ gpu: null, isolated: true })).toMatchObject({ device: 'cpu', threads: 'auto' });
    expect(P.chooseVoiceDevice()).toMatchObject({ device: 'cpu', threads: 1 });
  });
  it('uses one thread on a page that is not cross-origin isolated', () => {
    const c = P.chooseVoiceDevice({ gpu: { vendor: 'arm', fallback: false }, isolated: false });
    expect(c).toMatchObject({ device: 'cpu', threads: 1 });
    expect(c.reason).toMatch(/not cross-origin isolated/);
  });
  it('goes straight to the processor once WebGPU failed on this phone', () => {
    expect(P.GPU_FAILED).toBe('cpu');
    expect(P.chooseVoiceDevice({ gpu: apple, isolated: true, remembered: 'cpu' })).toMatchObject({ device: 'cpu', threads: 'auto' });
    expect(P.chooseVoiceDevice({ gpu: apple, isolated: false, remembered: 'cpu' })).toMatchObject({ device: 'cpu', threads: 1 });
    expect(P.chooseVoiceDevice({ gpu: apple, isolated: true, remembered: '' })).toMatchObject({ device: 'webgpu' });
  });
  it("reads the adapter's vendor, architecture, fallback flag and subgroups", async () => {
    expect(await P.gpuInfo(browserEnv({ vendor: 'apple' }))).toMatchObject({ vendor: 'apple', architecture: 'metal-3', fallback: false, subgroups: false });
    expect(await P.gpuInfo(browserEnv())).toBeNull();
    expect(await P.gpuInfo({ navigator: { gpu: { requestAdapter: async () => { throw new Error('off'); } } } })).toBeNull();
    expect(await P.gpuInfo({})).toBeNull();
  });
});

describe("the app's natural voice on the graphics chip, and its fallback to the processor", () => {
  it("asks phonon-tts for WebGPU on Apple's chip, and keeps it when it makes sound", async () => {
    const f = fakeLib();
    const mem = memoryStore();
    const { ph } = engine({ lib: f.lib, env: browserEnv({ vendor: 'apple' }), memory: mem });
    const tts = await ph.load();
    expect(f.loads[0]).toMatchObject({ device: 'auto', threads: 'auto' });
    expect(tts.device).toBe('webgpu');
    expect(await readAll(tts, 'One.')).toHaveLength(2);
    expect(await readAll(tts, 'Two.')).toHaveLength(2);
    expect(f.loads).toHaveLength(1);
    expect(mem.writes).toBe(0);
    expect(await ph.device()).toMatchObject({ device: 'webgpu' });
  });

  it('runs on the processor on an Arm Mali, and on one thread on a page that is not isolated', async () => {
    const a = fakeLib();
    await engine({ lib: a.lib, env: browserEnv({ vendor: 'arm' }) }).ph.load();
    expect(a.loads[0]).toMatchObject({ device: 'cpu', threads: 'auto' });
    const b = fakeLib();
    await engine({ lib: b.lib, env: browserEnv({ vendor: 'apple', isolated: false, fallback: true }) }).ph.load();
    expect(b.loads[0]).toMatchObject({ device: 'cpu', threads: 1 });
  });

  it('when WebGPU fails to start, reads on the processor phonon-tts fell back to, and remembers it', async () => {
    const f = fakeLib(undefined, { gpu: 'start' });
    const mem = memoryStore();
    const { ph } = engine({ lib: f.lib, env: browserEnv({ vendor: 'apple' }), memory: mem });
    const tts = await ph.load();
    expect(tts.device).toBe('cpu');
    expect(tts.deviceReason).toMatch(/WebGPU failed to start/);
    expect(mem.value).toBe('cpu');
    expect(await readAll(tts, 'One.')).toHaveLength(2);
    expect(f.loads).toHaveLength(1);
  });

  for (const [how, what] of [
    ['error', 'errors'],
    ['silent', 'ends with no sound'],
    ['hang', 'makes no sound in time'],
  ] as const) {
    it(`when WebGPU ${what} on first use, reads the line again on the processor, for the rest of the session, and remembers it`, async () => {
      const f = fakeLib(undefined, { gpu: how });
      const mem = memoryStore();
      const { ph } = engine({ lib: f.lib, env: browserEnv({ vendor: 'apple' }), memory: mem, firstSoundMs: 30 });
      const tts = await ph.load();
      expect(tts.device).toBe('webgpu');
      expect(await readAll(tts, 'First line.')).toHaveLength(2);
      expect(f.made[0].dispose).toHaveBeenCalled();
      expect(f.loads.map((l) => l.device)).toEqual(['auto', 'cpu']);
      expect(f.made[1].streams).toEqual([`${LOCK.defaultVoice}:First line.`]);
      expect(mem.value).toBe('cpu');
      expect(tts.device).toBe('cpu');
      expect(tts.deviceReason).toMatch(/WebGPU failed on first use/);
      // The rest of the session stays on the processor.
      expect(await readAll(tts, 'Second line.')).toHaveLength(2);
      expect(f.loads).toHaveLength(2);
    });
  }

  it('the next start remembers the failure and goes straight to the processor, without asking for an adapter', async () => {
    const f = fakeLib();
    let asked = 0;
    const env: any = browserEnv({ vendor: 'apple' });
    const real = env.navigator.gpu.requestAdapter;
    env.navigator.gpu.requestAdapter = () => (asked++, real());
    const { ph } = engine({ lib: f.lib, env, memory: memoryStore('cpu') });
    const tts = await ph.load();
    expect(f.loads[0]).toMatchObject({ device: 'cpu', threads: 'auto' });
    expect(tts.device).toBe('cpu');
    expect(asked).toBe(0);
  });

  it('reads with the voice the person picked when the app offers it, else the default', async () => {
    const f = fakeLib();
    let picked: string | null = 'Freya';
    const { ph } = engine({ lib: f.lib, voice: () => picked });
    const tts = await ph.load();
    expect(f.loads[0].model.defaultVoice).toBe('Freya');
    await readAll(tts, 'One.');
    picked = 'Bryony'; // a lab-only voice: not the app's
    await readAll(tts, 'Two.');
    picked = null;
    await readAll(tts, 'Three.');
    expect(f.made[0].streams).toEqual(['Freya:One.', 'Maeve:Two.', 'Maeve:Three.']);
    expect(ph.voice()).toBe('Maeve');
  });

  it('a stop while WebGPU starts its first line is not taken for a failure', async () => {
    const f = fakeLib(Array.from({ length: 20 }, () => new Float32Array(1920)));
    const mem = memoryStore();
    const { ph } = engine({ lib: f.lib, env: browserEnv({ vendor: 'apple' }), memory: mem });
    const tts = await ph.load();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await readAll(tts, 'Stopped.', { signal: ctrl.signal })).toEqual([]);
    expect(mem.writes).toBe(0);
    expect(f.loads).toHaveLength(1);
  });
});

/** A fake streaming speaker that records what it was given. */
function fakeSpeaker() {
  const s: any = { pushed: [], ended: false, stopped: false, rate: 0 };
  s.stream = ({ sampleRate }: any) => {
    s.rate = sampleRate;
    return {
      push: (pcm: Float32Array) => s.pushed.push(pcm),
      end: () => (s.ended = true),
      stop: () => (s.stopped = true),
      done: Promise.resolve(),
      underruns: () => 0,
    };
  };
  return s;
}

describe('voice out with the natural voice', () => {
  it('is free, private, and streams each piece of sound to the speaker as it is made', async () => {
    const { ph } = engine();
    await ph.init();
    const speaker = fakeSpeaker();
    const m = MOD.create({ speaker, phonon: ph });
    expect([m.id, m.available(), m.private(), m.price(), m.cached()]).toEqual(['phonon', true, true, 0, true]);
    const states: string[] = [];
    const progress: any[] = [];
    const r = await m.speak(['First piece.', 'Second piece.'], { onState: (s: string) => states.push(s), onProgress: (p: any) => progress.push(p) }).done;
    expect(r).toEqual({ chargedMsub: 0 });
    expect(states).toEqual(['loading', 'playing']);
    // The whole load (model and voice) as one download, then Getting ready once it is all here.
    expect(progress.map((p) => p.phase)).toEqual(['download', 'ready']);
    expect(progress[0].loaded).toBe(50);
    expect(progress[0].total).toBe(INDEX.firstBytes - LOCK.files.find((f) => f.path === LOCK.model.weights)!.size + 100);
    expect(progress[1].fraction).toBe(1);
    expect(speaker.rate).toBe(24000);
    expect(speaker.pushed).toHaveLength(4);
    expect(speaker.ended).toBe(true);
  });

  it('stops at once: the stream is cancelled and the speaker goes quiet', async () => {
    const { ph } = engine({ lib: fakeLib(Array.from({ length: 50 }, () => new Float32Array(1920))).lib });
    await ph.init();
    const speaker = fakeSpeaker();
    const m = MOD.create({ speaker, phonon: ph });
    const ctl = m.speak(['A long answer.']);
    await new Promise((r) => setTimeout(r, 5));
    ctl.stop();
    await expect(ctl.done).rejects.toMatchObject({ name: 'AbortError' });
    expect(speaker.stopped).toBe(true);
    expect(speaker.pushed.length).toBeLessThan(50);
  });

  it('says the sound is blocked, rather than play into silence, when no tap unlocked it (iPhone Safari)', async () => {
    const { ph } = engine();
    await ph.init();
    const speaker = fakeSpeaker();
    speaker.ready = async () => false;
    const m = MOD.create({ speaker, phonon: ph });
    await expect(m.speak(['An answer.']).done).rejects.toMatchObject({ name: 'AudioBlocked' });
    expect(speaker.pushed).toEqual([]);
    speaker.ready = async () => true;
    await expect(m.speak(['An answer.']).done).resolves.toEqual({ chargedMsub: 0 });
    expect(speaker.pushed).toHaveLength(2);
  });

  it('is handed only t, the speaker, and the parts of the Phonon engine it needs', () => {
    const fn = () => {};
    const all = { t: fn, engine: {}, wallet: {}, speaker: {}, synth: {}, audio: { model: fn, price: fn, speak: fn, transcribe: fn }, phonon: { available: fn, download: fn, load: fn, unload: fn, init: fn, index: fn } };
    const got = R.inputsFor('voice-out', all);
    expect(Object.keys(got).sort()).toEqual(['audio', 'phonon', 'speaker', 'synth', 't']);
    expect(Object.keys(got.phonon).sort()).toEqual(['available', 'download', 'load']);
    expect(R.inputsFor('voice-in', all)).not.toHaveProperty('phonon');
    expect(R.inputsFor('fund', all)).not.toHaveProperty('phonon');
  });
});

describe('choosing the voice that reads answers', () => {
  const mod = (id: string, available: boolean, priv = true) => ({ id, available: () => available, private: () => priv });
  const all = { phonon: mod('phonon', true), device: mod('device', true), engine: mod('engine', true) };
  it('reads with the natural voice by default where the phone runs it, else as before', () => {
    expect(STATE.DEFAULT_SETTINGS.voiceOut).toBe('auto');
    expect(STATE.pickVoiceOut(all, { voiceOut: 'auto', privateOnly: true })?.id).toBe('phonon');
    expect(STATE.pickVoiceOut({ ...all, phonon: mod('phonon', false) }, { voiceOut: 'auto', privateOnly: true })?.id).toBe('device');
    expect(STATE.pickVoiceOut({ engine: all.engine }, { voiceOut: 'auto', privateOnly: true })?.id).toBe('engine');
    expect(STATE.pickVoiceOut(all, { voiceOut: 'phonon', privateOnly: true })?.id).toBe('phonon');
    expect(STATE.pickVoiceOut({ ...all, phonon: mod('phonon', false) }, { voiceOut: 'phonon', privateOnly: true })).toBeNull();
    expect(STATE.pickVoiceOut(all, { voiceOut: 'device', privateOnly: true })?.id).toBe('device');
    expect(STATE.pickVoiceOut(all, { voiceOut: 'off', privateOnly: true })).toBeNull();
  });

  it('lists the natural voice first among the bundled voice-out modules', () => {
    const outs = R.BUNDLED.filter((b: any) => b.kind === 'voice-out').map((b: any) => b.folder);
    expect(outs[0]).toBe('phonon');
  });
});

describe('the one-time download question', () => {
  function setup(answers: boolean[]) {
    const S: any = {};
    const store = { S, set: (p: object) => Object.assign(S, p) };
    const asked: number[] = [];
    const spoken: string[][] = [];
    const out = {
      id: 'phonon',
      pieceSize: () => 1500,
      download: async () => ({ needed: true, bytes: 66_000_000 }),
      speak: (pieces: string[]) => {
        spoken.push(pieces);
        return { done: Promise.resolve({ chargedMsub: 0 }), stop() {} };
      },
    };
    const ctl = CTL.createTalk({
      store,
      t: (k: string) => k,
      ui: { toast() {} },
      nav() {},
      haptics: { pulse() {} },
      voiceIn: () => null,
      voiceOut: () => out,
      blocker: () => null,
      ask: async () => {},
      refresh() {},
      errorText: () => 'error',
      askDownload: async (bytes: number) => {
        asked.push(bytes);
        return answers.shift() ?? false;
      },
    });
    return { ctl, asked, spoken, S };
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));
  const msg = { id: 'a1', content: 'An answer.' };

  it('asks with the size before the first read, and reads once the person agrees', async () => {
    const x = setup([true]);
    x.ctl.speak(msg);
    await flush();
    expect(x.asked).toEqual([66_000_000]);
    expect(x.spoken).toEqual([['An answer.']]);
  });

  it('after Not now, answers to voice questions are not read on their own, but Listen asks again', async () => {
    const x = setup([false, true]);
    x.ctl.speak(msg, { auto: true });
    await flush();
    expect(x.asked).toHaveLength(1);
    expect(x.spoken).toEqual([]);
    x.ctl.speak(msg, { auto: true });
    await flush();
    expect(x.asked).toHaveLength(1);
    x.ctl.speak(msg);
    await flush();
    expect(x.asked).toHaveLength(2);
    expect(x.spoken).toHaveLength(1);
  });

  it('unlocks the sound inside the tap itself: Listen, and pressing and letting go of the talk button', () => {
    const calls: string[] = [];
    const S: any = {};
    const ctl = CTL.createTalk({
      store: { S, set: (p: object) => Object.assign(S, p) },
      t: (k: string) => k,
      ui: { toast() {} },
      nav() {},
      haptics: { pulse() {} },
      voiceIn: () => ({ maxSeconds: () => 60, start: () => new Promise(() => {}) }),
      voiceOut: () => ({ id: 'phonon', pieceSize: () => 1500, download: async () => (calls.push('download'), { needed: false }), speak: () => ({ done: Promise.resolve({}), stop() {} }) }),
      blocker: () => null,
      ask: async () => {},
      refresh() {},
      errorText: () => 'error',
      unlockAudio: () => calls.push('unlock'),
    });
    // Synchronously, before the first await (the download check).
    ctl.speak(msg);
    expect(calls).toEqual(['unlock', 'download']);
    // An answer read on its own is not a tap: nothing to unlock there.
    calls.length = 0;
    ctl.speak(msg, { auto: true });
    expect(calls).toEqual(['download']);
    calls.length = 0;
    ctl.down();
    expect(calls).toEqual(['unlock']);
    ctl.up();
    expect(calls).toEqual(['unlock', 'unlock']);
  });

  it('shows the download it asked for until the voice reads; a failure offers Try again, which does not ask twice', async () => {
    const asked: number[] = [];
    const views: any[] = [];
    let fail = true;
    const S: any = {};
    const ctl = CTL.createTalk({
      store: { S, set: (p: object) => Object.assign(S, p) },
      t: (k: string) => k,
      ui: { toast() {} },
      nav() {},
      haptics: { pulse() {} },
      voiceIn: () => null,
      voiceOut: () => ({
        id: 'phonon',
        pieceSize: () => 1500,
        download: async () => ({ needed: true, bytes: 65e6 }),
        speak: (_: string[], { onProgress, onState }: any) => {
          setTimeout(() => onProgress({ loaded: 10, total: 100, fraction: 0.1, phase: 'download' }), 0);
          const later = new Promise((r) => setTimeout(r, 5));
          const done = later.then(() => (fail ? Promise.reject(new Error('Failed to fetch')) : onState('playing')));
          return { done, stop() {} };
        },
      }),
      blocker: () => null,
      ask: async () => {},
      refresh() {},
      errorText: () => 'error',
      askDownload: async (bytes: number) => (asked.push(bytes), true),
      showDownload: (bytes: number) => {
        const v: any = { bytes, progress: [] as any[], closed: false, failed: null, retry: null };
        v.progress = (p: any) => v.progress.list.push(p);
        v.progress.list = [];
        v.close = () => (v.closed = true);
        v.fail = (m: string, again: () => void) => ((v.failed = m), (v.retry = again), true);
        views.push(v);
        return v;
      },
    });
    ctl.speak(msg);
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toEqual([65e6]);
    expect(views).toHaveLength(1);
    expect(views[0].bytes).toBe(65e6);
    expect(views[0].progress.list[0]).toMatchObject({ fraction: 0.1, phase: 'download' });
    expect(views[0].failed).toBe('Failed to fetch');
    expect(views[0].closed).toBe(false);
    fail = false;
    views[0].retry();
    await new Promise((r) => setTimeout(r, 20));
    expect(asked).toHaveLength(1); // Try again does not ask again
    expect(views).toHaveLength(2);
    expect(views[1].closed).toBe(true); // closed once the voice started reading
  });

  it('a blocked sound asks for a tap on Listen', async () => {
    const toasts: string[] = [];
    const S: any = {};
    const ctl = CTL.createTalk({
      store: { S, set: (p: object) => Object.assign(S, p) },
      t: (k: string) => k,
      ui: { toast: (x: string) => toasts.push(x) },
      nav() {},
      haptics: { pulse() {} },
      voiceIn: () => null,
      voiceOut: () => ({ id: 'phonon', pieceSize: () => 1500, speak: () => ({ done: Promise.reject(Object.assign(new Error('x'), { name: 'AudioBlocked' })), stop() {} }) }),
      blocker: () => null,
      ask: async () => {},
      refresh() {},
      errorText: () => 'error',
    });
    ctl.speak(msg, { auto: true });
    await flush();
    expect(toasts).toEqual(['speak.blocked']);
  });

  it('a stop while the question is open means nothing is read', async () => {
    let answer!: (ok: boolean) => void;
    const spoken: string[] = [];
    const S: any = {};
    const ctl = CTL.createTalk({
      store: { S, set: (p: object) => Object.assign(S, p) },
      t: (k: string) => k,
      ui: { toast() {} },
      nav() {},
      haptics: { pulse() {} },
      voiceIn: () => null,
      voiceOut: () => ({
        id: 'phonon',
        pieceSize: () => 1500,
        download: async () => ({ needed: true, bytes: 1 }),
        speak: (pieces: string[]) => {
          spoken.push(...pieces);
          return { done: Promise.resolve({}), stop() {} };
        },
      }),
      blocker: () => null,
      ask: async () => {},
      refresh() {},
      errorText: () => 'error',
      askDownload: () => new Promise<boolean>((r) => (answer = r)),
    });
    ctl.speak(msg);
    await flush();
    ctl.stopSpeaking();
    answer(true);
    await flush();
    expect(spoken).toEqual([]);
  });
});

describe('the voice lab', () => {
  it('reads a fixed corpus of about sixty lines of every kind', () => {
    expect(LAB.CORPUS.length).toBeGreaterThanOrEqual(55);
    expect(LAB.CORPUS.length).toBeLessThanOrEqual(65);
    expect(new Set(LAB.CORPUS.map((c: any) => c.id)).size).toBe(LAB.CORPUS.length);
    const kinds = new Set(LAB.CORPUS.map((c: any) => c.kind));
    for (const k of ['short', 'numbers', 'names', 'hard', 'medium', 'long']) expect(kinds.has(k), k).toBe(true);
    const long = LAB.CORPUS.filter((c: any) => c.kind === 'long')[0];
    expect(long.text.split(/\s+/).length).toBeGreaterThan(100);
    for (const c of LAB.CORPUS) expect(c.text, c.id).not.toMatch(/[–—]/);
  });

  it('counts the gaps a listener would hear from when each piece arrived', () => {
    // 80 ms pieces arriving every 40 ms: never a gap.
    expect(LAB.virtualUnderruns([0, 40, 80, 120], [80, 80, 80, 80])).toEqual({ underruns: 0, stallMs: 0 });
    // The third piece comes 200 ms after the second ends.
    expect(LAB.virtualUnderruns([0, 100, 410], [80, 80, 80], 50)).toEqual({ underruns: 1, stallMs: 200 });
    expect(LAB.virtualUnderruns([], [])).toEqual({ underruns: 0, stallMs: 0 });
  });

  it('sums up each way of reading with medians, 90th percentiles and broken runs', () => {
    expect(LAB.percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(LAB.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(LAB.percentile([], 50)).toBeNull();
    const s = LAB.summarize([
      { firstMs: 10, rtf: 0.1, underruns: 0, nan: 0, silent: false, clipped: 0 },
      { firstMs: 30, rtf: 0.3, underruns: 2, nan: 1, silent: false, clipped: 0 },
      { firstMs: 20, rtf: 0.2, underruns: 0, nan: 0, silent: true, clipped: 1 },
      { error: 'boom' },
    ]);
    expect(s).toEqual({ items: 4, failed: 1, firstMs: { median: 20, p90: 30 }, rtf: { median: 0.2, p90: 0.3 }, underruns: 2, nanRuns: 1, silentRuns: 1, clippedRuns: 1 });
    const rep = LAB.report({ env: { cores: 8 }, voice: 'Maeve', candidates: [{ id: 'phonon-cpu-threads', rows: [] }, { id: 'phone-voice', error: 'none' }] });
    expect(rep).toMatchObject({ kind: 'forge-voice-lab', corpusVersion: LAB.CORPUS_VERSION, voice: 'Maeve', env: { cores: 8 } });
    expect(rep.candidates[1].summary).toBeNull();
    expect(LAB.CANDIDATES.map((c: any) => c.id)).toEqual(['phonon-cpu-threads', 'phonon-cpu-single', 'phonon-webgpu', 'phone-voice']);
  });

  it('is reachable only by its address: no menu or screen links to it', async () => {
    const ROUTER: any = await import('../../../public/v2/core/router.js' as string);
    expect(ROUTER.parse('#/voice-lab').name).toBe('voiceLab');
    expect(ROUTER.parentOf('voiceLab')).toBe('home');
    const v2 = join(PUBLIC, 'v2');
    const links: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) {
          if (!p.includes('/vendor')) walk(p);
        } else if (/\.(js|html)$/.test(n) && /nav\(\s*'voiceLab'|href\(\s*'voiceLab'|["'`]#\/voice-lab/.test(readFileSync(p, 'utf8'))) links.push(p.slice(v2.length));
      }
    };
    walk(v2);
    expect(links).toEqual([]);
  });
});
