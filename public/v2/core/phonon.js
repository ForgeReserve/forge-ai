// The natural voice that runs on the phone: Phonon 31m English (Gradium, Apache-2.0), through the
// vendored phonon-tts package (public/v2/vendor/phonon-tts). The model and its voices come from this
// app's own address (/v2/voice/phonon/, put there at build time by scripts/phonon-model.ts) or, in the
// Android app, from inside the APK. Nothing is fetched from another site, and the text never leaves the
// phone: the model runs in a worker on this page.
//
// The pure parts (the model's file list, what the browser needs, checks on the sound) are tested in
// Node; createPhonon wires them to the browser.

/** The folder of the model files, next to the app. */
export const PHONON_BASE = new URL('../voice/phonon/', import.meta.url).href;

/** Where phonon-tts keeps its downloads (its fetch.js CACHE_NAME). */
export const PHONON_CACHE = 'phonon-tts-v1';

/** The longest text read in one go: the most of an answer that is read aloud (core/speech.js). */
export const PHONON_PIECE = 1500;

/**
 * The model as phonon-tts takes it (a ModelSpec), from the index the build writes. Every URL is on
 * `base`, so the package never falls back to its default model on Hugging Face.
 */
export function modelSpec(index, base = PHONON_BASE, voice = null) {
  const url = (p) => {
    if (typeof p !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(p)) throw new Error(`bad model path ${String(p)}`);
    return new URL(p, base).href;
  };
  const voices = Object.fromEntries((index?.voices ?? []).map((v) => [v.name, url(v.file)]));
  const pick = voice && voice in voices ? voice : index?.defaultVoice in voices ? index.defaultVoice : Object.keys(voices)[0];
  return { weights: { q8: url(index?.model?.weights) }, tokenizer: url(index?.model?.tokenizer), config: url(index?.model?.config), voices, defaultVoice: pick };
}

/** Whether every model URL is on this app's own origin. */
export function sameOrigin(spec, origin) {
  const urls = [spec.weights.q8, spec.tokenizer, spec.config, ...Object.values(spec.voices)];
  return urls.every((u) => new URL(u).origin === origin);
}

/**
 * Whether this browser can run the model: WebAssembly with SIMD (the package needs it) and module
 * workers. env is the global object, passed in so tests can give a fake.
 */
export function canRun(env = globalThis) {
  try {
    if (typeof env.Worker !== 'function' || typeof env.WebAssembly?.validate !== 'function') return false;
    // The smallest module using one SIMD instruction (v128.const): rejected where SIMD is missing.
    const simd = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 22, 1, 20, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 11]);
    return env.WebAssembly.validate(simd);
  } catch {
    return false;
  }
}

/** Checks of a run's sound: samples, NaN, all silent, peak and clipped samples (|x| >= 0.99). */
export function soundCheck(chunks) {
  let samples = 0;
  let nan = 0;
  let peak = 0;
  let clipped = 0;
  for (const c of chunks) {
    samples += c.length;
    for (let i = 0; i < c.length; i++) {
      const x = c[i];
      if (Number.isNaN(x)) nan++;
      else {
        const a = Math.abs(x);
        if (a > peak) peak = a;
        if (a >= 0.99) clipped++;
      }
    }
  }
  return { samples, nan, silent: samples === 0 || peak < 1e-4, peak, clipped };
}

/**
 * The phone's Phonon engine, loaded once and kept. Options:
 * - base: the model folder; native: true in the Android app, where the files are in the APK (nothing
 *   to download, and nothing is copied into the browser's cache);
 * - importLib: loads phonon-tts (tests pass a fake); fetch, caches: the browser's.
 * load() takes {device: 'cpu' | 'webgpu', threads: 'auto' | n, onProgress} and gives the PhononTTS.
 */
export function createPhonon({ base = PHONON_BASE, native = false, importLib = () => import('../vendor/phonon-tts/index.js'), fetch: f = (...a) => globalThis.fetch(...a), caches: cs = globalThis.caches, env = globalThis } = {}) {
  let index = null; // the build's index.json, once read
  let indexP = null;
  const loaded = new Map(); // options key -> Promise<PhononTTS>

  const readIndex = () => {
    indexP ??= f(new URL('index.json', base).href, { cache: 'no-cache' })
      .then((r) => (r.ok ? r.json() : null))
      .then((x) => (index = x?.model && Array.isArray(x.voices) && x.voices.length ? x : null))
      .catch(() => null);
    return indexP;
  };

  const api = {
    /** Reads which model files this app has. Resolves to the index, or null when there is none. */
    init: readIndex,
    /** True once the files are known to be here and the browser can run the model. */
    available: () => !!index && canRun(env),
    index: () => index,
    /** The bytes a first use fetches (the model and the default voice), or 0 when nothing is fetched. */
    async download() {
      await readIndex();
      if (!index || native) return { needed: false, bytes: 0 };
      let have = false;
      try {
        const c = await cs?.open(PHONON_CACHE);
        have = !!(await c?.match(modelSpec(index, base).weights.q8));
      } catch {
        /* no Cache Storage: it downloads every time */
      }
      return { needed: !have, bytes: have ? 0 : index.firstBytes ?? 0 };
    },
    /** The model, loaded the first time (from the cache when it is there). */
    load({ device = 'cpu', threads = 'auto', voice = null, onProgress } = {}) {
      const key = `${device}|${threads}`;
      if (!loaded.has(key)) {
        const p = (async () => {
          await readIndex();
          if (!index) throw new Error('The voice files are not on this app.');
          const lib = await importLib();
          const spec = modelSpec(index, base, voice);
          // Files inside the Android app are read straight from the APK: a copy in the cache would only
          // take the same space twice.
          return lib.PhononTTS.load({ lang: 'en', model: spec, cache: !native, device, threads, onProgress });
        })();
        loaded.set(key, p);
        p.catch(() => loaded.delete(key));
      }
      return loaded.get(key);
    },
    /** Stops a loaded model's worker and frees its memory. */
    async unload({ device = 'cpu', threads = 'auto' } = {}) {
      const p = loaded.get(`${device}|${threads}`);
      loaded.delete(`${device}|${threads}`);
      try {
        (await p)?.dispose();
      } catch {
        /* it never loaded */
      }
    },
  };
  return api;
}
