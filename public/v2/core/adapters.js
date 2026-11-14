// Small adapters for the phone's hardware, so tests can put a fake in their place: the camera (scanning
// an eCash code), the microphone, the browser's own speech recogniser and voices, the speaker, the share
// sheet, vibration, and card taps (NFC, which only the Android app has: core/native.js).
import { loadScript } from '../../js/ui.js';

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

const defaults = {
  camera: {
    available: () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    /** Starts reading QR codes (single or animated) from the camera into `video`. Returns {promise, stop}. */
    async open(video, onProgress = () => {}) {
      await loadScript('/js/scan.js');
      return window.ForgeScan.scan(video, onProgress);
    },
  },

  /**
   * The microphone as raw sound. open() asks for the microphone and resolves to {sampleRate,
   * onData(fn), stop()}: fn gets each chunk of float samples while recording. The sound stays in this
   * page's memory; nothing here stores or sends it.
   */
  mic: {
    available: () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof (window.AudioContext ?? window.webkitAudioContext) === 'function',
    async open() {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
      const Ctx = window.AudioContext ?? window.webkitAudioContext;
      const ctx = new Ctx();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      const source = ctx.createMediaStreamSource(stream);
      // ScriptProcessorNode is deprecated but needs no separate worklet file, and runs in every browser.
      const node = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      let listener = () => {};
      node.onaudioprocess = (e) => listener(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(node);
      node.connect(mute);
      mute.connect(ctx.destination);
      let stopped = false;
      return {
        sampleRate: ctx.sampleRate,
        onData: (fn) => (listener = fn),
        stop() {
          if (stopped) return;
          stopped = true;
          listener = () => {};
          node.onaudioprocess = null;
          for (const t of stream.getTracks()) t.stop();
          source.disconnect();
          node.disconnect();
          ctx.close().catch(() => {});
        },
      };
    },
  },

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
   */
  synth: {
    voices(lang = 'en') {
      const all = typeof speechSynthesis !== 'undefined' ? speechSynthesis.getVoices() : [];
      return all.filter((v) => v.localService && v.lang?.toLowerCase().startsWith(lang.toLowerCase()));
    },
    speak(text, lang = 'en') {
      const u = new SpeechSynthesisUtterance(text);
      const voice = defaults.synth.voices(lang)[0];
      if (voice) u.voice = voice;
      u.lang = voice?.lang ?? lang;
      const done = new Promise((res, rej) => {
        u.onend = () => res();
        u.onerror = (e) => (e.error === 'interrupted' || e.error === 'canceled' ? res() : rej(new Error(e.error)));
      });
      speechSynthesis.speak(u);
      return { done, stop: () => speechSynthesis.cancel() };
    },
  },

  /**
   * The phone's share sheet, for a file made on the phone (Share unseen). files(list) opens the sheet
   * and resolves once the person picked an app or closed it (an AbortError when closed). save(file)
   * hands the file to the browser as a download, where there is no share sheet or for Save.
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
    },
  },

  /**
   * Card taps. A web page cannot talk to these cards, so on the website there is no reader: supported()
   * is false. The Android app puts its own in place (core/native.js nativeNfc). There, start(onCard)
   * calls onCard({transceive(bytes) -> bytes, close()}) for each card that comes into the field (null for
   * one that is not a smart card) and returns {started, stop()}.
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
