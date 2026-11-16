// The natural voice that runs on the phone: Phonon 31m English (Gradium, Apache-2.0), through the
// vendored phonon-tts package (public/v2/vendor/phonon-tts). The model and its voices come from this
// app's own address (/v2/voice/phonon/, put there at build time by scripts/phonon-model.ts) or, in the
// Android app, from inside the APK. Nothing is fetched from another site, and the text never leaves the
// phone: the model runs in a worker on this page.
//
// The pure parts (the model's file list, what the browser needs, checks on the sound) are tested in
// Node; createPhonon wires them to the browser.
import { notePace as addPace } from './voicepace.js';

/** The folder of the model files, next to the app. */
export const PHONON_BASE = new URL('../voice/phonon/', import.meta.url).href;

/** Where phonon-tts keeps its downloads (its fetch.js CACHE_NAME). */
export const PHONON_CACHE = 'phonon-tts-v1';

/** The longest text read in one go: the most of an answer that is read aloud (core/speech.js). */
export const PHONON_PIECE = 1500;

/**
 * The model as phonon-tts takes it (a ModelSpec), from the index the build writes. Every URL is on
 * `base`, so the package never falls back to its default model on Hugging Face. lab: also the voice lab's
 * accent-test voices (index.labVoices), which the app itself never offers.
 */
export function modelSpec(index, base = PHONON_BASE, voice = null, { lab = false } = {}) {
  const url = (p) => {
    if (typeof p !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(p)) throw new Error(`bad model path ${String(p)}`);
    return new URL(p, base).href;
  };
  const list = [...(index?.voices ?? []), ...(lab ? (index?.labVoices ?? []) : [])];
  const voices = Object.fromEntries(list.map((v) => [v.name, url(v.file)]));
  const pick = voice && voice in voices ? voice : index?.defaultVoice in voices ? index.defaultVoice : Object.keys(voices)[0];
  return { weights: { q8: url(index?.model?.weights) }, tokenizer: url(index?.model?.tokenizer), config: url(index?.model?.config), voices, defaultVoice: pick };
}

/**
 * The files one load fetches, as phonon-tts names them in its progress reports, with the size the index
 * gives each: the weights, the tokenizer, the config and the voice it starts with.
 */
export function loadFiles(index, voice = null) {
  const size = (p) => index?.files?.find((f) => f.path === p)?.size ?? 0;
  const all = [...(index?.voices ?? []), ...(index?.labVoices ?? [])];
  const v = all.find((x) => x.name === voice) ?? all.find((x) => x.name === index?.defaultVoice) ?? index?.voices?.[0];
  const files = [
    { file: 'weights', bytes: size(index?.model?.weights) },
    { file: 'tokenizer', bytes: size(index?.model?.tokenizer) },
    { file: 'config', bytes: size(index?.model?.config) },
  ];
  if (v) files.push({ file: `voice:${v.name}`, bytes: v.size ?? size(v.file) });
  return files;
}

/**
 * Adds up phonon-tts's progress reports ({file, loaded, total, cached}, one stream per file) into one
 * download: update(report) returns {loaded, total, fraction, fetched}. total is every byte the load
 * reads (the server's length when it sends one, else the index's size); fraction runs 0 to 1; fetched
 * is true once any byte came over the network rather than from the phone's cache.
 */
export function createMeter(index, voice = null) {
  const expected = new Map(loadFiles(index, voice).map((f) => [f.file, f.bytes]));
  const got = new Map();
  let fetched = false;
  const view = () => {
    let loaded = 0;
    let total = 0;
    for (const [file, bytes] of expected) {
      const g = got.get(file);
      const size = g?.total || bytes;
      total += size;
      loaded += Math.min(g?.loaded ?? 0, size);
    }
    return { loaded, total, fraction: total > 0 ? loaded / total : 0, fetched };
  };
  return {
    update(p) {
      if (p?.file) {
        if (!expected.has(p.file)) expected.set(p.file, p.total ?? 0);
        got.set(p.file, { loaded: Number(p.loaded) || 0, total: Number(p.total) || 0 });
        if (p.cached === false) fetched = true;
      }
      return view();
    },
    view,
  };
}

/** A meter's numbers as people read them: MB done and in all (one decimal) and a whole percent. */
export function meterNumbers({ loaded = 0, total = 0, fraction = 0 } = {}) {
  const mb = (x) => (Math.floor((x / 1e6) * 10) / 10).toFixed(1);
  return { done: mb(loaded), total: mb(total), pct: Math.max(0, Math.min(100, Math.floor(fraction * 100))) };
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

/**
 * What the browser's WebGPU adapter says it is, or null when there is none: {vendor, architecture,
 * fallback, subgroups, subgroupMinSize, subgroupMaxSize}. env is the global object (tests pass a fake).
 */
export async function gpuInfo(env = globalThis) {
  try {
    const a = await env.navigator?.gpu?.requestAdapter();
    if (!a) return null;
    const i = a.info ?? {};
    return {
      vendor: i.vendor ?? '',
      architecture: i.architecture ?? '',
      fallback: !!(i.isFallbackAdapter ?? a.isFallbackAdapter),
      subgroups: !!a.features?.has?.('subgroups'),
      subgroupMinSize: i.subgroupMinSize ?? null,
      subgroupMaxSize: i.subgroupMaxSize ?? null,
    };
  } catch {
    return null;
  }
}

/** The setting (settings.voiceDevice) a WebGPU failure leaves on this phone: start on the processor. */
export const GPU_FAILED = 'cpu';

/**
 * Where the app's natural voice runs, from the voice lab's numbers on real phones (docs/VOICE.md): on
 * the graphics chip (WebGPU) when the adapter is Apple's and not a software fallback (iPhone: 27 ms to
 * the first sound, RTF 0.045, against 0.147 on the processor); else on the processor with threads where
 * the page is cross-origin isolated (Pixel 8 Pro: WebGPU on its Mali was 5 times slower than threads);
 * else on one thread. remembered is settings.voiceDevice: GPU_FAILED skips WebGPU, because it failed on
 * this phone before. Returns {device: 'webgpu' | 'cpu', threads: 'auto' | 1, reason}.
 */
export function chooseVoiceDevice({ gpu = null, isolated = false, remembered = null } = {}) {
  const cpu = (why) => (isolated ? { device: 'cpu', threads: 'auto', reason: why } : { device: 'cpu', threads: 1, reason: `${why}; one thread, as the page is not cross-origin isolated` });
  if (remembered === GPU_FAILED) return cpu('WebGPU failed on this phone before');
  if (!gpu) return cpu('no WebGPU adapter');
  if (gpu.fallback) return cpu('the WebGPU adapter is a software fallback');
  if (String(gpu.vendor ?? '').toLowerCase() === 'apple') return { device: 'webgpu', threads: 'auto', reason: "WebGPU on Apple's graphics chip" };
  return cpu(`WebGPU on ${gpu.vendor || 'this graphics chip'} is slower than the processor`);
}

/** How long the app waits for the first sound from WebGPU before it gives up on it for the processor. */
export const GPU_FIRST_SOUND_MS = 20_000;

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
 * A stream that fails when its first piece of sound takes longer than ms (a WebGPU run that hangs).
 * Later pieces may take as long as they like.
 */
async function* firstWithin(stream, ms) {
  const it = stream[Symbol.asyncIterator]();
  let timer;
  try {
    const late = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`no sound from WebGPU in ${Math.round(ms / 1000)} s`)), ms);
    });
    const first = await Promise.race([it.next(), late]);
    clearTimeout(timer);
    if (first.done) return;
    yield first.value;
    for (;;) {
      const r = await it.next();
      if (r.done) return;
      yield r.value;
    }
  } finally {
    clearTimeout(timer);
    // Not awaited: after a timeout the stream may never answer (the model is freed, which ends it).
    it.return?.()?.catch?.(() => {});
  }
}

const reasonOf = (e) => String(e?.message ?? e).slice(0, 200);

/**
 * The phone's Phonon engine, loaded once and kept. Options:
 * - base: the model folder; native: true in the Android app, where the files are in the APK (nothing
 *   to download, and nothing is copied into the browser's cache);
 * - importLib: loads phonon-tts (tests pass a fake); fetch, caches: the browser's; env: the global
 *   object (its navigator.gpu and crossOriginIsolated decide the app's device);
 * - voice(): the voice the person picked for the app (settings.naturalVoice), or null for the default;
 * - memory: {get(), set(value)}, the app's settings.voiceDevice, where a WebGPU failure is remembered;
 * - nativeVoice: in the Android app, the natural voice made by native code (core/native.js
 *   nativeVoice), used instead of the browser's build when this phone runs it (native());
 * - pace: {get(), set(all)}, the app's settings.voicePace: how fast this phone makes the voice, per way
 *   of making it (paceKey()), kept by notePace (core/voicepace.js); prefs(): {preferNatural}.
 *
 * load() without a device is the app's natural voice: it runs where chooseVoiceDevice says, and when
 * WebGPU fails to start, errors, stays silent or makes no sound in GPU_FIRST_SOUND_MS on its first
 * use, the processor takes over for the rest of the session (the line is read again there) and the
 * failure is remembered, so the next start goes straight to the processor. It gives a voice with
 * {sampleRate, device, deviceReason, stream(text, {voice, signal}), dispose()}.
 *
 * load({device: 'cpu' | 'webgpu', threads: 'auto' | n, voice, lab}) is the voice lab's: exactly that
 * device, no fallback, the PhononTTS itself (lab: with the lab's other voices too; unload() takes the
 * same options). onProgress gets phonon-tts's own reports; onMeter gets them added up (createMeter).
 */
export function createPhonon({
  base = PHONON_BASE,
  native = false,
  nativeVoice = null,
  pace: paceStore = { get: () => null, set: () => {} },
  prefs = () => ({}),
  importLib = () => import('../vendor/phonon-tts/index.js'),
  fetch: f = (...a) => globalThis.fetch(...a),
  caches: cs = globalThis.caches,
  env = globalThis,
  voice: picked = () => null,
  memory = { get: () => null, set: () => {} },
  firstSoundMs = GPU_FIRST_SOUND_MS,
} = {}) {
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

  /** phonon-tts loaded with exactly these options. */
  const loadLib = async ({ device, threads, voice, lab, onProgress, onMeter }) => {
    await readIndex();
    if (!index) throw new Error('The voice files are not on this app.');
    const lib = await importLib();
    const spec = modelSpec(index, base, voice, { lab });
    const meter = createMeter(index, spec.defaultVoice);
    const report = (p) => {
      onProgress?.(p);
      onMeter?.(meter.update(p));
    };
    // Files inside the Android app are read straight from the APK: a copy in the cache would only
    // take the same space twice.
    return lib.PhononTTS.load({ lang: 'en', model: spec, cache: !native, device, threads, onProgress: report });
  };

  // ---- the app's natural voice: the device it runs on, and the fallback to the processor
  let app = null; // Promise<{tts, gpu}>, the app's model once asked for
  let current = null; // what app resolved to
  let choice = null; // {device, threads, reason}: where it runs
  let gpuFailed = false; // WebGPU failed this session
  let failedWhy = null; // and why
  let gpuSounded = false; // WebGPU made sound once this session: no more first-use checks

  /** The app's voice by name: the one picked when the app offers it, else the default. */
  const appVoice = () => {
    const n = picked?.();
    return index?.voices?.some((v) => v.name === n) ? n : index?.defaultVoice ?? null;
  };
  const choose = async () => {
    const remembered = gpuFailed ? GPU_FAILED : memory.get?.() ?? null;
    let gpu = null;
    if (remembered !== GPU_FAILED) gpu = await gpuInfo(env);
    return chooseVoiceDevice({ gpu, isolated: env.crossOriginIsolated === true, remembered });
  };
  const remember = () => {
    gpuFailed = true;
    try {
      memory.set?.(GPU_FAILED);
    } catch {
      /* not kept: the next start tries WebGPU again */
    }
  };
  const onCpu = (why) => ({ ...chooseVoiceDevice({ isolated: env.crossOriginIsolated === true, remembered: GPU_FAILED }), reason: why });

  const loadApp = (opts) => {
    if (!app) {
      const p = (async () => {
        await readIndex();
        opts = { ...opts, voice: opts.voice ?? appVoice() };
        const c = await choose();
        if (c.device !== 'webgpu') {
          const tts = await loadLib({ ...opts, device: 'cpu', threads: c.threads });
          choice = failedWhy ? { ...c, reason: failedWhy } : c;
          return { tts, gpu: false };
        }
        let tts;
        try {
          // 'auto' to phonon-tts: WebGPU, and the processor in the same worker when WebGPU fails to
          // start, with the files it already downloaded.
          tts = await loadLib({ ...opts, device: 'auto', threads: c.threads });
        } catch (e) {
          // Tried again on the processor; when that fails too, it was not WebGPU's fault.
          tts = await loadLib({ ...opts, device: 'cpu', threads: onCpu('').threads });
          remember();
          choice = onCpu(`WebGPU failed to load: ${reasonOf(e)}`);
          return { tts, gpu: false };
        }
        if (tts.device === 'webgpu') {
          choice = c;
          return { tts, gpu: true };
        }
        remember();
        choice = onCpu(`WebGPU failed to start: ${tts.deviceReason ?? 'unknown'}`);
        return { tts, gpu: false };
      })();
      app = p;
      p.then(
        (m) => app === p && (current = m),
        () => app === p && (app = null),
      );
    }
    return app;
  };

  /** WebGPU failed on its first use: free it, remember, and run on the processor from now on. */
  const giveUpGpu = (m, e) => {
    remember();
    failedWhy = `WebGPU failed on first use: ${reasonOf(e)}`;
    choice = onCpu(failedWhy);
    if (current === m) current = null;
    app = null;
    try {
      m.tts.dispose();
    } catch {
      /* already gone */
    }
  };

  async function* appStream(text, { voice = null, signal, ...rest } = {}) {
    let m = await loadApp({});
    voice ??= appVoice();
    if (m.gpu && !gpuSounded) {
      let got = 0;
      try {
        for await (const pcm of firstWithin(m.tts.stream(text, { ...rest, voice, signal }), firstSoundMs)) {
          got++;
          yield pcm;
        }
        if (signal?.aborted) return;
        if (!got) throw new Error('WebGPU made no sound');
        gpuSounded = true;
        return;
      } catch (e) {
        if (signal?.aborted) throw e;
        giveUpGpu(m, e);
        // Some of this line was heard already: say it failed rather than read it twice.
        if (got) throw e;
        m = await loadApp({});
      }
    }
    yield* m.tts.stream(text, { ...rest, voice, signal });
  }

  const appHandle = {
    get sampleRate() {
      return current?.tts.sampleRate ?? 24000;
    },
    get device() {
      return choice?.device ?? null;
    },
    get deviceReason() {
      return choice?.reason ?? null;
    },
    stream: (text, opts) => appStream(text, opts),
    dispose() {
      const m = current;
      app = current = null;
      m?.tts.dispose();
    },
  };

  // ---- the native voice (Android app): whether this phone runs it, and whether it failed this session
  let nativeOk = null;
  let nativeP = null;
  let nativeBroken = null;
  const nativeStatus = () =>
    (nativeP ??= nativeVoice
      ? nativeVoice.status().then((st) => ((nativeOk = st?.available === true), st), () => ((nativeOk = false), { available: false }))
      : Promise.resolve({ available: false }));

  const api = {
    /** Reads which model files this app has. Resolves to the index, or null when there is none. */
    init: async () => {
      const [ix] = await Promise.all([readIndex(), nativeStatus()]);
      return ix;
    },
    /** True once the files are known to be here and the browser (or, in the app, native code) can run the model. */
    available: () => !!index && (canRun(env) || (nativeOk === true && !nativeBroken)),
    /** The native voice when this phone runs it and it has not failed this session, else null. */
    async native() {
      await api.init();
      return nativeOk === true && !nativeBroken ? nativeVoice : null;
    },
    /** What the native voice says about this phone ({available, reason, threads, ...}). */
    nativeStatus,
    /** The native voice failed in a way the browser's build may not (a crash, a load failure): not again this session. */
    nativeFailed: (e) => {
      nativeBroken = String(e?.message ?? e ?? 'failed');
    },
    /** Which way of making the voice this phone's speed is kept under: 'native', or the browser's device. */
    paceKey: (nativeUsed = false) => (nativeUsed ? 'native' : `web-${choice?.device ?? 'cpu'}-${choice?.threads ?? 'auto'}`),
    /** The kept speed for a way of making the voice ({rtf, spc, n, at}), or null. */
    pace: (key) => {
      const v = paceStore.get?.()?.[key];
      return v && typeof v === 'object' ? v : null;
    },
    /** Adds one answer's speed ({rtf, spc}) to what is kept for this way. */
    notePace(key, m) {
      if (!(m?.rtf > 0) && !(m?.spc > 0)) return;
      const all = { ...(paceStore.get?.() ?? {}) };
      all[key] = { ...addPace(all[key], m), at: Date.now() };
      try {
        paceStore.set?.(all);
      } catch {
        /* not kept: measured again next time */
      }
    },
    /** The person asked to keep the natural voice even where it is slow (settings.preferNatural). */
    preferNatural: () => !!prefs?.()?.preferNatural,
    index: () => index,
    /** Where the app's natural voice runs on this phone ({device, threads, reason}), without loading it. */
    device: () => (choice ? Promise.resolve(choice) : choose()),
    /** The voice the app reads with: the one picked, or the default. */
    voice: () => appVoice(),
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
    load({ device = null, threads = 'auto', voice = null, lab = false, onProgress, onMeter } = {}) {
      if (device == null && !lab) return loadApp({ voice, onProgress, onMeter }).then(() => appHandle);
      const dev = device ?? 'cpu';
      const key = `${dev}|${threads}|${lab ? 'lab' : 'app'}`;
      if (!loaded.has(key)) {
        const p = loadLib({ device: dev, threads, voice, lab, onProgress, onMeter });
        loaded.set(key, p);
        p.catch(() => loaded.delete(key));
      }
      return loaded.get(key);
    },
    /** Stops a loaded model's worker and frees its memory (without a device or lab: the app's). */
    async unload({ device = null, threads = 'auto', lab = false } = {}) {
      if (device == null && !lab) {
        const p = app;
        app = current = null;
        try {
          (await p)?.tts.dispose();
        } catch {
          /* it never loaded */
        }
        return;
      }
      const key = `${device ?? 'cpu'}|${threads}|${lab ? 'lab' : 'app'}`;
      const p = loaded.get(key);
      loaded.delete(key);
      try {
        (await p)?.dispose();
      } catch {
        /* it never loaded */
      }
    },
  };
  return api;
}
