// Small adapters for the phone's hardware, so tests can put a fake in their place: the camera (scanning
// an eCash code), the microphone, the browser's own speech recogniser and voices, the speaker, the share
// sheet, vibration, and card taps (NFC, which only the Android app has: core/native.js).
import { loadScript } from '../../js/ui.js';
import { largestFrame, stillShape, stillSize, turnedAway } from './camera.js';
import { isIOS } from './getapp.js';
import { level } from './wav.js';

const Recognition = () => (typeof window !== 'undefined' ? (window.SpeechRecognition ?? window.webkitSpeechRecognition) : undefined);

/** The page's one Web Audio context for sound out (speaker.stream), made on first use; null without Web Audio. */
let audioOut = null;
function outputContext() {
  if (audioOut && audioOut.state !== 'closed') return audioOut;
  const Ctx = typeof window !== 'undefined' ? (window.AudioContext ?? window.webkitAudioContext) : undefined;
  audioOut = typeof Ctx === 'function' ? new Ctx() : null;
  return audioOut;
}

/**
 * On iOS 17 and later, a page's Web Audio follows the ring switch (silent mode mutes it) unless the page
 * says it plays sound on purpose. Sets the audio session to playback while a stream plays; returns a
 * function that puts back 'auto'. Nothing happens where there is no navigator.audioSession, or where the
 * page already set one.
 */
function playbackSession() {
  const s = typeof navigator !== 'undefined' ? navigator.audioSession : null;
  if (!s || s.type !== 'auto') return () => {};
  try {
    s.type = 'playback';
  } catch {
    return () => {};
  }
  return () => {
    try {
      if (s.type === 'playback') s.type = 'auto';
    } catch {
      /* left as it is */
    }
  };
}

/**
 * The frame a playing video shows, as a JPEG, at the stream's own size. The canvas is let go before
 * this resolves, so only the encoded photo is held.
 */
async function frameOf(video) {
  const w = video.videoWidth;
  const h = video.videoHeight;
  if (!w || !h) return null;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  try {
    canvas.getContext('2d').drawImage(video, 0, 0, w, h);
    return await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.95));
  } finally {
    canvas.width = canvas.height = 0;
  }
}

/** How long an utterance may take to start before the phone is taken to have dropped it. */
const SYNTH_START_MS = 2500;
let synthUnlocked = false;
const blockedError = () => Object.assign(new Error('the phone kept the sound off'), { name: 'AudioBlocked' });

/**
 * How the microphone is asked for. Echo cancelling is off: nothing plays while a person records, and on
 * some Android phones (a Galaxy A16) a web view asked for it is handed pure silence, so every recording
 * read as "nothing was heard". Noise suppression and automatic gain stay on.
 */
export const MIC_SOUND = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true };

/** The samples in each chunk of sound the microphone hands on (what ScriptProcessorNode(4096) gave). */
export const MIC_CHUNK = 4096;
/** A recording that has run this long with no sample at all from the microphone gave no sound (a dead microphone, not silence). */
export const NO_SAMPLES_MS = 1000;
/** On an iPhone, this much sound of pure zeros at the start of a recording opens the microphone again once, with echo cancelling. */
export const SILENT_START_SECONDS = 0.5;
/** How long a press waits, once the microphone is open, for the recording context to run before it makes a new one. */
export const RUN_WAIT_MS = 50;
/** How long a press waits for the capture worklet to load before it records the old way this once. */
export const WORKLET_WAIT_MS = 2000;
/** The capture worklet (core/mic-worklet.js), a file of this origin, so it loads under the page's COEP and from the apps' own schemes. */
export const MIC_WORKLET = new URL('./mic-worklet.js', import.meta.url).href;

/**
 * The microphone as raw sound. open() asks for the microphone and resolves to {sampleRate,
 * onData(fn), facts(), stop()}: fn gets each chunk of MIC_CHUNK float samples while recording, and
 * facts() what this recording looks like so far (the same facts last() keeps once it stops). The sound
 * stays in this page's memory; nothing here stores or sends it. The facts hold no sound and no words.
 *
 * The recording context. iPhone Safari (every browser on iOS) starts Web Audio only inside a tap, so
 * open() makes or wakes the context first, before anything is awaited: the talk button calls it from
 * the press itself (core/talkctl.js). One context is kept for the page and reused by every press, as iOS
 * allows a page only a few; it is suspended between recordings and resumed whenever it is not running
 * (suspended, or 'interrupted', which iOS also has): in the press, again once the microphone is open,
 * and on every state change while recording. One that still does not run RUN_WAIT_MS after the
 * microphone opened is made again then: WebKit takes a touch's end, not its start, as the tap that may
 * start sound, and lets a page start sound while it records. The context is let go, so the next press starts a new
 * one with a new stream, after a recording that got no sample at all, one that ended with the context
 * not running, one whose track was muted or ended while it recorded, and on any devicechange (headphones
 * in or out: iOS interrupts and re-routes the audio then). Every press opens its own stream, and every
 * stream is stopped when its recording ends.
 *
 * The capture. An AudioWorkletNode (core/mic-worklet.js, loaded once per context) hands on the chunks.
 * ScriptProcessorNode is used only where there is no AudioWorklet or its file did not load in time: on
 * iOS a ScriptProcessorNode never fires with AirPods or another Bluetooth or wired microphone (WebKit bug
 * 216349). An AnalyserNode on the same source takes the loudest sample it sees, for the facts only: it
 * tells "the capture never fired" apart from "no sound reached Web Audio".
 *
 * An iPhone whose recording starts with SILENT_START_SECONDS of pure zeros (digital silence, never a
 * quiet room) opens the microphone again once, with echo cancelling on, which is how iOS records for
 * calls. Only once per recording, only on iOS, and the first stream is stopped first (WebKit does not
 * capture with and without echo cancelling at once). When that brings sound, later recordings on this
 * page ask for echo cancelling from the start. Android and computers never do this (a Galaxy A16 needs
 * echo cancelling off: MIC_SOUND).
 */
export function createMic({
  media = () => globalThis.navigator?.mediaDevices,
  Context = () => globalThis.AudioContext ?? globalThis.webkitAudioContext,
  WorkletNode = () => globalThis.AudioWorkletNode,
  ios = () => isIOS({ ua: globalThis.navigator?.userAgent, platform: globalThis.navigator?.platform, touchPoints: globalThis.navigator?.maxTouchPoints }),
  workletUrl = MIC_WORKLET,
  workletWaitMs = WORKLET_WAIT_MS,
  runWaitMs = RUN_WAIT_MS,
  now = () => Date.now(),
  log = (facts) => console.info('[forge] microphone', JSON.stringify(facts)),
} = {}) {
  let ctx = null; // the recording context
  let made = 0; // contexts made (tests: none leak)
  let loaded = null; // {ctx, ready: Promise<{ok, error}>}: the worklet module, once per context
  let using = 0; // recordings open on ctx now
  const live = new Set(); // the facts of each recording open now
  let echo = false; // echo cancelling brought sound on this iPhone: ask for it from the start
  let last = null;

  const note = (facts, state) => {
    if (facts.states.at(-1) !== state) facts.states.push(state);
  };
  let resting = null; // the context a suspend was asked of, which may still read 'running'
  const wake = (c) => {
    if (c.state === 'closed' || (c.state === 'running' && resting !== c)) return;
    resting = null;
    c.resume?.().catch(() => {});
  };
  function context() {
    if (ctx && ctx.state !== 'closed') return ctx;
    const Ctx = Context();
    const c = new Ctx();
    made++;
    c.addEventListener?.('statechange', () => {
      for (const f of live) note(f, c.state);
      // A context iOS interrupted (a call, another app's sound, a headset change) or suspended while
      // recording is resumed at once; between recordings it is left as it is.
      if (using > 0 && c === ctx) wake(c);
    });
    ctx = c;
    loaded = null;
    return c;
  }
  /** Lets this context go: the next press makes a new one. */
  function drop(c) {
    if (ctx === c) ctx = null;
    if (loaded?.ctx === c) loaded = null;
    if (stale === c) stale = null;
    if (c.state !== 'closed') c.close?.().catch(() => {});
  }
  let stale = null; // the context to let go once its recordings end (the sound's route changed)
  /**
   * The sound's route changed (headphones in or out, a Bluetooth microphone, a call): iOS interrupts and
   * re-routes the audio then. The context is let go now, or once the recording on it ends, so the next
   * press starts with a new context and a new stream on the input iOS picked.
   */
  function retire(c) {
    if (!c || c.state === 'closed') return;
    if (using === 0) drop(c);
    else stale = c;
  }
  let listening = false;
  function listen() {
    const md = media();
    if (listening || typeof md?.addEventListener !== 'function') return;
    listening = true;
    md.addEventListener('devicechange', () => {
      for (const f of live) f.changed = true;
      retire(ctx);
    });
  }
  /** Resolves true once `c` runs, or false after `ms` with it still not running. */
  function running(c, ms) {
    if (c.state === 'running' && resting !== c) return Promise.resolve(true);
    return new Promise((res) => {
      let timer = 0;
      const on = () => c.state === 'running' && done(true);
      const done = (v) => {
        clearTimeout(timer);
        c.removeEventListener?.('statechange', on);
        res(v);
      };
      c.addEventListener?.('statechange', on);
      timer = setTimeout(() => done(c.state === 'running'), ms);
    });
  }
  /** Resolves {ok, error}: the capture worklet registered in this context, or why not (it records the old way then). */
  function worklet(c) {
    if (!c.audioWorklet?.addModule || typeof WorkletNode() !== 'function') return Promise.resolve({ ok: false, error: 'none' });
    if (loaded?.ctx !== c) {
      loaded = {
        ctx: c,
        ready: Promise.resolve()
          .then(() => c.audioWorklet.addModule(workletUrl))
          .then(
            () => ({ ok: true, error: null }),
            (e) => ({ ok: false, error: String(e?.name ?? e) }),
          ),
      };
    }
    let timer = 0;
    // A file that has not loaded yet is waited for a moment; this press then records the old way and
    // a later press uses the worklet once it is in.
    const late = new Promise((res) => (timer = setTimeout(() => res({ ok: false, error: 'slow' }), workletWaitMs)));
    return Promise.race([loaded.ready, late]).finally(() => clearTimeout(timer));
  }

  return {
    available: () => !!media()?.getUserMedia && typeof Context() === 'function',
    /** The facts of the last recording once it stopped, or null: for More, Voice. */
    last: () => (last ? { ...last, states: [...last.states] } : null),
    /** Contexts made and open, for tests: one for the page, a new one only after a dead recording. */
    contexts: () => ({ made, open: ctx && ctx.state !== 'closed' ? 1 : 0, using }),
    async open() {
      // In the press, before any await (iOS).
      listen();
      let c = context();
      wake(c);
      using++;
      const facts = { method: null, worklet: null, remade: false, states: [c.state], sampleRate: c.sampleRate, label: '', muted: false, ended: false, echoCancellation: echo, reopened: false, changed: false, chunks: 0, zeroChunks: 0, samples: 0, peak: 0, level: 0, heardPeak: null, ms: 0 };
      live.add(facts);
      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        live.delete(facts);
        using--;
        if (using > 0 || ctx !== c) return;
        // A context the route change made stale, or one that is not running (interrupted, or suspended by
        // the phone) is not kept for the next press: that press makes a new one inside its tap.
        if (stale === c || c.state !== 'running') drop(c);
        else if (c.suspend) {
          resting = c;
          c.suspend().catch(() => {});
        }
      };
      const ask = (ec) => media().getUserMedia({ audio: ec ? { ...MIC_SOUND, echoCancellation: true } : MIC_SOUND });
      let stream;
      let w;
      try {
        stream = await ask(echo);
        // The permission sheet may have come and gone: wake it again, now that the microphone is open.
        wake(c);
        // A context that still does not run is made again, now. WebKit counts a touch's end as the tap
        // that may start sound, not its start (the press), and lets a page start sound while it records:
        // a context made with the microphone on runs (the way this page recorded before 2026-11-21).
        if (!(await running(c, runWaitMs)) && using === 1 && ctx === c) {
          drop(c);
          c = context();
          wake(c);
          facts.remade = true;
          facts.sampleRate = c.sampleRate;
          note(facts, c.state);
        }
        w = await worklet(c);
      } catch (e) {
        if (stream) for (const t of stream.getTracks()) t.stop();
        release();
        throw e;
      }
      note(facts, c.state);
      let listener = () => {};
      let stopped = false;
      let began = now();
      const iphone = !echo && ios();
      let zeros = iphone ? 0 : -1; // samples of pure zeros at the start, while that is still being watched
      let rescue = false; // opened again with echo cancelling: the first sound says it helped
      const deliver = (buf) => {
        if (stopped || !buf?.length) return;
        facts.chunks++;
        facts.samples += buf.length;
        let peak = 0;
        for (let i = 0; i < buf.length; i++) {
          const a = Math.abs(buf[i]);
          if (a > peak) peak = a;
        }
        if (peak > facts.peak) facts.peak = peak;
        if (peak === 0) facts.zeroChunks++;
        // The same level the level bars and the voice-in module's "was anything heard" read (core/wav.js).
        const l = level(buf);
        if (l > facts.level) facts.level = l;
        if (zeros >= 0) {
          if (peak > 0) zeros = -1;
          else if ((zeros += buf.length) >= c.sampleRate * SILENT_START_SECONDS) {
            zeros = -1;
            again();
          }
        }
        if (rescue && peak > 0) {
          rescue = false;
          echo = true;
        }
        listener(buf);
      };

      let node = null;
      if (w.ok) {
        try {
          const Node = WorkletNode();
          node = new Node(c, 'forge-mic', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', processorOptions: { size: MIC_CHUNK } });
          node.port.onmessage = (e) => deliver(e.data);
          facts.method = 'worklet';
        } catch (e) {
          w = { ok: false, error: String(e?.name ?? e) };
          node = null;
        }
      }
      if (!node) {
        node = c.createScriptProcessor(MIC_CHUNK, 1, 1);
        node.onaudioprocess = (e) => deliver(new Float32Array(e.inputBuffer.getChannelData(0)));
        facts.method = 'script';
      }
      facts.worklet = w.ok ? 'loaded' : w.error;
      const mute = c.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(c.destination);
      let probe = null;
      let probeBuf = null;
      let poll = 0;
      try {
        probe = c.createAnalyser?.() ?? null;
        if (probe && typeof probe.getFloatTimeDomainData === 'function') {
          probe.fftSize = 2048;
          probeBuf = new Float32Array(probe.fftSize);
          facts.heardPeak = 0;
          poll = setInterval(() => {
            probe.getFloatTimeDomainData(probeBuf);
            for (let i = 0; i < probeBuf.length; i++) if (Math.abs(probeBuf[i]) > facts.heardPeak) facts.heardPeak = Math.abs(probeBuf[i]);
          }, 200);
        } else probe = null;
      } catch {
        probe = null;
      }

      let source = null;
      let track = null;
      const watch = (s) => {
        track = s.getAudioTracks?.()[0] ?? s.getTracks()[0] ?? null;
        facts.label = String(track?.label ?? '');
        if (track?.muted) facts.muted = true;
        if (track?.readyState === 'ended') facts.ended = true;
        // Muted or ended while recording (a route change, another app taking the microphone): this
        // recording goes on as it can, and the next press opens everything afresh.
        track?.addEventListener?.('mute', () => {
          if (stopped) return;
          facts.muted = true;
          retire(c);
        });
        track?.addEventListener?.('ended', () => {
          if (stopped) return;
          facts.ended = true;
          retire(c);
        });
        source = c.createMediaStreamSource(s);
        source.connect(node);
        if (probe) source.connect(probe);
      };
      const unplug = () => {
        for (const t of stream.getTracks()) t.stop();
        try {
          source?.disconnect();
        } catch {
          /* already */
        }
      };
      watch(stream);

      /** The iPhone retry: the first stream stopped, then the microphone opened again with echo cancelling. */
      async function again() {
        facts.reopened = true;
        unplug();
        try {
          const s = await ask(true);
          if (stopped) {
            for (const t of s.getTracks()) t.stop();
            return;
          }
          stream = s;
          facts.echoCancellation = true;
          rescue = true;
          watch(s);
          wake(c);
        } catch {
          /* no sound comes: the recording ends as Nothing was heard */
        }
      }

      const snapshot = () => ({ ...facts, states: [...facts.states], state: c.state, ms: now() - began });
      return {
        sampleRate: c.sampleRate,
        onData: (fn) => {
          listener = fn;
          began = now();
        },
        facts: snapshot,
        /** More facts from the voice-in module (its voice level, its verdict), kept with this recording's. */
        addFacts(more) {
          Object.assign(facts, more);
          if (stopped && last) Object.assign(last, more);
        },
        stop() {
          if (stopped) return;
          stopped = true;
          listener = () => {};
          clearInterval(poll);
          if (node.port) {
            node.port.onmessage = null;
            node.port.postMessage?.('stop');
          } else node.onaudioprocess = null;
          unplug();
          for (const n of [node, mute, probe]) {
            try {
              n?.disconnect();
            } catch {
              /* already */
            }
          }
          last = snapshot();
          log(last);
          release();
          // No sample at all for a second or more: this context is let go, so the next press starts afresh.
          if (!facts.chunks && last.ms >= NO_SAMPLES_MS) drop(c);
        },
      };
    },
  };
}

const defaults = {
  camera: {
    available: () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    /**
     * Starts reading QR codes (single or animated) from the camera into `video`. Returns {promise, stop}.
     * It reads eCash and balance keys; with {any: true} it gives back whatever code it reads first.
     */
    async open(video, onProgress = () => {}, opts = {}) {
      await loadScript('/js/scan.js');
      return window.ForgeScan.scan(video, onProgress, opts);
    },
    /**
     * The camera for taking a photo inside the page (Share unseen, screens/camera.js): the `facing`
     * camera ('environment', the back one, or 'user'), or the camera `device` (an id from `cameras`),
     * plays in `video`. Resolves {id, facing, faces, mirror, cameras, take(), stop()}: `faces` says
     * whether the camera told which way it faces (a phone's do, most computers' do not), `cameras` the ids
     * of every camera here. Rejects as getUserMedia does (refused, no camera). take() resolves the
     * photo as a Blob and turns the camera off: the largest still the camera takes (ImageCapture), or
     * where the browser has none (Safari, Firefox) a frame of the stream at its largest picture. Nothing
     * is stored or sent; the camera is off once take() or stop() is called.
     */
    async still(video, { facing = 'environment', device = null } = {}) {
      const md = navigator.mediaDevices;
      const which = device ? { deviceId: { exact: device } } : { facingMode: { ideal: facing } };
      const stream = await md.getUserMedia({ video: { ...which, width: { ideal: 1920 }, height: { ideal: 1440 } }, audio: false });
      const track = stream.getVideoTracks()[0];
      let stopped = false;
      const stop = () => {
        if (stopped) return;
        stopped = true;
        for (const t of stream.getTracks()) t.stop();
        try {
          video.pause();
          video.srcObject = null;
        } catch {
          /* already let go */
        }
      };
      try {
        let capture = null;
        try {
          if (typeof globalThis.ImageCapture === 'function') capture = new globalThis.ImageCapture(track);
        } catch {
          capture = null;
        }
        // No stills here: the photo is a frame of the stream, so the stream runs at its largest picture.
        const big = capture ? null : largestFrame(track.getCapabilities?.());
        if (big) await track.applyConstraints({ width: { ideal: big.width }, height: { ideal: big.height } }).catch(() => {});
        video.muted = true;
        video.setAttribute('playsinline', '');
        video.srcObject = stream;
        await video.play();
        const settings = track.getSettings?.() ?? {};
        const cameras = (await md.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'videoinput').map((d) => d.deviceId);
        const shown = settings.facingMode || facing;
        return {
          id: settings.deviceId ?? null,
          facing: shown,
          faces: !!settings.facingMode,
          // The camera on the screen's side is shown as in a mirror; the photo itself is not turned.
          mirror: shown === 'user',
          cameras,
          async take() {
            if (stopped) throw new Error('the camera is off');
            const view = { width: video.videoWidth, height: video.videoHeight };
            let blob = null;
            if (capture) {
              try {
                blob = await capture.takePhoto(stillSize(await capture.getPhotoCapabilities()));
                // A still turned the other way from the screen: the frame the person saw instead.
                if (turnedAway(stillShape(new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer())), view)) blob = null;
              } catch {
                blob = null;
              }
            }
            if (!blob && !stopped) blob = await frameOf(video);
            stop();
            if (!blob) throw new Error('the camera is off');
            return blob;
          },
          stop,
        };
      } catch (e) {
        stop();
        throw e;
      }
    },
  },

  mic: createMic(),

  /**
   * The browser's own speech recogniser, where there is one. Which service hears the voice is up to the
   * browser: Chrome sends it to Google. start() resolves to {stop() -> Promise<text>, cancel()}.
   */
  recognizer: {
    available: () => !!Recognition(),
    async start({ lang = 'en', onText = () => {} } = {}) {
      const R = Recognition();
      const r = new R();
      r.lang = lang;
      r.interimResults = true;
      r.continuous = true;
      let finalText = '';
      let interim = '';
      let error = null;
      let ended;
      const done = new Promise((res) => (ended = res));
      r.onresult = (e) => {
        interim = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const x = e.results[i];
          if (x.isFinal) finalText += x[0].transcript;
          else interim += x[0].transcript;
        }
        onText((finalText + interim).trim());
      };
      r.onerror = (e) => (error = e.error ?? 'error');
      r.onend = () => ended();
      r.start();
      return {
        async stop() {
          r.stop();
          await Promise.race([done, new Promise((res) => setTimeout(res, 4000))]);
          if (error && error !== 'no-speech' && error !== 'aborted') throw new Error(error);
          return (finalText + interim).trim();
        },
        cancel() {
          r.onresult = null;
          r.abort();
        },
      };
    },
  },

  /**
   * Plays a sound file: play(blob) returns {done: Promise, stop()}. Or plays sound as it is made:
   * stream({sampleRate}) returns {push(samples), end(), done, stop(), underruns(), blocked()}. Each
   * pushed piece (a Float32Array) is queued right after the one before; a piece that arrives after the
   * one before has finished playing is an underrun (a gap the listener hears).
   *
   * All streamed sound goes through one Web Audio context, kept for the life of the page. iPhone Safari
   * (and every browser on iOS) starts a context only inside a tap: one made or resumed later, after a
   * download or a model load, stays suspended and plays nothing. So every tap that leads to sound
   * (Listen, Download, the talk button, Run in the voice lab) calls unlock() first, before any await.
   * ready(ms) says whether the context is running, after giving a resume up to ms to land.
   */
  speaker: {
    unlock() {
      try {
        const ctx = outputContext();
        if (!ctx) return;
        if (ctx.state !== 'running') ctx.resume().catch(() => {});
        // A moment of silence started inside the tap: older iOS only opens the sound on a played source.
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        /* no Web Audio here */
      }
    },
    async ready(ms = 1000) {
      const ctx = outputContext();
      if (!ctx) return false;
      if (ctx.state === 'running') return true;
      await Promise.race([ctx.resume().catch(() => {}), new Promise((res) => setTimeout(res, ms))]);
      return ctx.state === 'running';
    },
    state: () => audioOut?.state ?? 'none',
    stream({ sampleRate }) {
      const ctx = outputContext();
      if (ctx.state !== 'running') ctx.resume().catch(() => {});
      const restore = playbackSession();
      // Each stream has its own gain node on the shared context, so stop() silences only this one.
      const out = ctx.createGain();
      out.connect(ctx.destination);
      const sources = new Set();
      let at = 0; // when the queued sound ends, in the context's time
      let started = false;
      let ended = false;
      let closed = false;
      let gaps = 0;
      let guard = 0;
      let finish;
      const done = new Promise((res) => (finish = res));
      const close = () => {
        if (closed) return;
        closed = true;
        clearTimeout(guard);
        for (const s of sources) {
          s.onended = null;
          try {
            s.stop();
          } catch {
            /* not started */
          }
        }
        sources.clear();
        out.disconnect();
        restore();
        finish();
      };
      const settle = () => {
        if (ended && sources.size === 0) close();
      };
      return {
        push(samples) {
          if (ended || !samples?.length) return;
          const buf = ctx.createBuffer(1, samples.length, sampleRate);
          buf.getChannelData(0).set(samples);
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(out);
          // A little lead on the first piece, so the next has time to arrive.
          if (!started) at = ctx.currentTime + 0.05;
          else if (at < ctx.currentTime) {
            gaps++;
            at = ctx.currentTime + 0.02;
          }
          started = true;
          sources.add(src);
          src.onended = () => {
            sources.delete(src);
            settle();
          };
          src.start(at);
          at += buf.duration;
        },
        end() {
          ended = true;
          settle();
          // A context that never runs never ends a source: done must not wait for ever. Give the
          // queued sound its length on the clock, and a little more.
          if (!closed) guard = setTimeout(close, (Math.max(0, at - ctx.currentTime) + 2) * 1000);
        },
        done,
        stop() {
          ended = true;
          close();
        },
        underruns: () => gaps,
        blocked: () => ctx.state !== 'running',
      };
    },

    play(blob) {
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      let finish;
      const done = new Promise((res, rej) => {
        finish = (err) => {
          URL.revokeObjectURL(url);
          err ? rej(err) : res();
        };
        audio.onended = () => finish();
        audio.onerror = () => finish(new Error('the sound could not be played'));
      });
      audio.play().catch((e) => finish(e));
      return {
        done,
        stop() {
          audio.pause();
          finish();
        },
      };
    },
  },

  /**
   * The phone's own voices (speechSynthesis), only those that run on the phone (localService), so the
   * answer is never sent to a voice service. speak() returns {done: Promise, stop()}.
   *
   * Two things keep a browser's own voice silent, and both are handled here. The voices are listed late:
   * Chrome lists none until a moment after the page first asks, iOS Safari a while after the page opens
   * (ready(ms) waits for them). And iPhone Safari drops an utterance started outside a tap, with no
   * event at all (WebKit SpeechSynthesis::speak), until the page has spoken once inside one: unlock()
   * speaks a silent one in the tap, and speak() rejects with AudioBlocked when an utterance never starts.
   */
  synth: {
    voices(lang = 'en') {
      const all = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
      const ours = all.filter((v) => v.localService && v.lang?.toLowerCase().startsWith(lang.toLowerCase()));
      // The phone's default voice first: the first one listed can be a novelty voice (macOS lists Albert,
      // Bad News and Bells among its English voices).
      return [...ours.filter((v) => v.default), ...ours.filter((v) => !v.default)];
    },
    /** Resolves true once the phone lists a voice of its own for `lang`, false after `ms` with none. */
    ready(ms = 2000, lang = 'en') {
      if (defaults.synth.voices(lang).length) return Promise.resolve(true);
      if (typeof speechSynthesis === 'undefined') return Promise.resolve(false);
      return new Promise((res) => {
        const check = () => {
          if (!defaults.synth.voices(lang).length) return;
          finish(true);
        };
        const finish = (ok) => {
          clearTimeout(timer);
          clearInterval(poll);
          speechSynthesis.removeEventListener?.('voiceschanged', check);
          res(ok);
        };
        const timer = setTimeout(() => finish(defaults.synth.voices(lang).length > 0), ms);
        // Some browsers fill the list without the event: look again now and then too.
        const poll = setInterval(check, 250);
        speechSynthesis.addEventListener?.('voiceschanged', check);
      });
    },
    /** Inside a tap: a silent utterance, once a page, so the phone lets the page speak later (iOS). */
    unlock() {
      if (synthUnlocked) return;
      try {
        const synth = globalThis.speechSynthesis;
        if (!synth || typeof SpeechSynthesisUtterance !== 'function') return;
        synth.getVoices();
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        synth.speak(u);
        synthUnlocked = true;
      } catch {
        /* no speech here */
      }
    },
    speak(text, lang = 'en', { startMs = SYNTH_START_MS } = {}) {
      const u = new SpeechSynthesisUtterance(text);
      const voice = defaults.synth.voices(lang)[0];
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? lang;
      let watch = 0;
      let heard = false;
      const done = new Promise((res, rej) => {
        const end = (fn) => {
          clearTimeout(watch);
          heard = true;
          fn();
        };
        u.onstart = () => {
          heard = true;
          clearTimeout(watch);
        };
        u.onend = () => end(res);
        u.onerror = (e) => {
          if (e.error === 'interrupted' || e.error === 'canceled') return end(res);
          // Chrome refuses a page that has had no tap yet.
          if (e.error === 'not-allowed') return end(() => rej(blockedError()));
          end(() => rej(new Error(e.error)));
        };
        // An utterance the browser dropped never starts, ends or fails: say the sound is blocked rather
        // than wait for ever in silence. One still waiting its turn (pending) or under way is left alone.
        watch = setTimeout(() => {
          if (heard || speechSynthesis.speaking || speechSynthesis.pending) return;
          rej(blockedError());
        }, startMs);
      });
      speechSynthesis.speak(u);
      return {
        done,
        stop: () => {
          clearTimeout(watch);
          speechSynthesis.cancel();
        },
      };
    },
  },

  /**
   * The phone's share sheet, for a file made on the phone (Share unseen). files(list) opens the sheet
   * and resolves once the person picked an app or closed it (an AbortError when closed). save(file)
   * hands the file to the browser as a download, where there is no share sheet or for Save, and resolves
   * {started: true}: a page is never told whether the download finished or where it went.
   */
  share: {
    canShareFiles: (files) => typeof navigator !== 'undefined' && typeof navigator.share === 'function' && !!navigator.canShare?.({ files }),
    files: (files) => navigator.share({ files }),
    save(file) {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.rel = 'noopener';
      a.hidden = true;
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      return { started: true };
    },
  },

  /**
   * Card taps. A web page cannot talk to these cards, so on the website there is no reader: supported()
   * is false, and the card ways are still listed to point to the app. The Android and iPhone apps put
   * their own in place (core/native.js nativeNfc); an iPhone app built before its reader one whose
   * listed() is false (NO_READER). There, start(onCard) calls onCard({transceive(bytes) -> bytes,
   * close()}) for each card that comes into the field (null for one that is not a smart card) and
   * returns {started, stop()}.
   */
  nfc: {
    supported: () => false,
    status: async () => ({ available: false, enabled: false }),
    start: () => ({ started: Promise.resolve(false), stop() {} }),
  },

  /**
   * The paired till, for Fedimint cards (core/till.js). Only the Android app has one (core/native.js
   * nativeTill): a page cannot read the card, and the till's token stays with the app. On the website
   * supported() is false and nothing here reaches a till.
   */
  till: {
    supported: () => false,
    status: async () => ({ paired: false, url: null }),
    pair: async () => {
      throw Object.assign(new Error('Only the Forge app for Android pairs with a till.'), { code: 'app_only' });
    },
    forget: async () => {},
    request: async () => {
      throw Object.assign(new Error('No till.'), { code: 'app_only' });
    },
    openLink: async () => {
      throw Object.assign(new Error('No till.'), { code: 'app_only' });
    },
  },

  /** A short vibration, where the phone has one. */
  haptics: {
    pulse(pattern) {
      try {
        navigator.vibrate?.(pattern);
      } catch {
        /* not allowed here */
      }
    },
  },
};

const current = { ...defaults };

export const adapters = current;

/** Replaces an adapter (tests). */
export function setAdapter(name, impl) {
  if (!(name in defaults)) throw new Error(`unknown adapter ${name}`);
  current[name] = impl;
}
