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
    expect(LOCK.voices.map((v) => v.name)).toEqual(['Maeve', 'Freya', 'Pippa', 'Elodie-Rose', 'Imogen', 'Lottie', 'Bryony']);
    for (const v of LOCK.voices) expect([v.locale, v.gender]).toEqual(['en-gb', 'female']);
    for (const f of LOCK.files) expect(f.url).toContain(f.path.startsWith('31m') ? LOCK.model.revision : LOCK.voiceRepo.revision);
    // The weights file the model card names: 64.5 MB, 8-bit.
    expect(LOCK.files.find((f) => f.path === LOCK.model.weights)!.size).toBe(64_512_352);
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
    expect(INDEX.voices).toHaveLength(7);
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
    expect(Object.keys(spec.voices)).toHaveLength(7);
    expect(P.sameOrigin(spec, 'https://app.test')).toBe(true);
    expect(P.sameOrigin(spec, 'https://other.test')).toBe(false);
    expect(P.modelSpec(INDEX, BASE, 'Bryony').defaultVoice).toBe('Bryony');
    expect(P.modelSpec(INDEX, BASE, 'Nobody').defaultVoice).toBe(LOCK.defaultVoice);
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

/** A fake phonon-tts: records how it was loaded and streams the chunks given. */
function fakeLib(chunks: Float32Array[] = [new Float32Array(1920).fill(0.1), new Float32Array(1920).fill(0.2)]) {
  const loads: any[] = [];
  const lib = {
    PhononTTS: {
      load: async (opts: any) => {
        loads.push(opts);
        opts.onProgress?.({ file: 'weights', loaded: 50, total: 100, cached: false });
        return {
          sampleRate: 24000,
          dispose: vi.fn(),
          stream: (text: string, { signal }: any = {}) => ({
            async *[Symbol.asyncIterator]() {
              for (const c of chunks) {
                if (signal?.aborted) return;
                await new Promise((r) => setTimeout(r, 1));
                yield c;
              }
            },
          }),
        };
      },
    },
  };
  return { lib, loads };
}

function engine({ index = INDEX as any, native = false, cached = false, lib = fakeLib().lib } = {}) {
  const fetched: string[] = [];
  const fetch = async (url: string) => {
    fetched.push(url);
    return index ? new Response(JSON.stringify(index)) : new Response('', { status: 404 });
  };
  const caches = { open: async () => ({ match: async (u: string) => (cached && u.endsWith('model.q8.gguf') ? new Response('x') : undefined) }) };
  const env = { Worker: function () {}, WebAssembly };
  return { ph: P.createPhonon({ base: BASE, native, importLib: async () => lib, fetch, caches, env }), fetched };
}

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
    const a = engine({ lib: web.lib });
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

  it('frees a model when asked, and loads it again after', async () => {
    const f = fakeLib();
    const a = engine({ lib: f.lib });
    const first = await a.ph.load();
    await a.ph.unload();
    expect(first.dispose).toHaveBeenCalled();
    expect(await a.ph.load()).not.toBe(first);
    expect(f.loads).toHaveLength(2);
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
    const progress: number[] = [];
    const r = await m.speak(['First piece.', 'Second piece.'], { onState: (s: string) => states.push(s), onProgress: (f: number) => progress.push(f) }).done;
    expect(r).toEqual({ chargedMsub: 0 });
    expect(states).toEqual(['loading', 'playing']);
    expect(progress).toEqual([0.5]);
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
