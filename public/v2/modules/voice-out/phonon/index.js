// Voice out with the natural voice made on the phone (Phonon 31m, core/phonon.js). The answer is read
// by a model running on this phone; the text is never sent anywhere. Free. In the Android app, where
// the phone runs it, native code makes the voice and plays it (core/native.js nativeVoice, faster than
// the browser's build); everywhere else the model runs in this page and its sound streams to the
// speaker in 80 ms pieces as the model makes them, so reading starts before the sentence is done.
//
// On a phone that makes the voice slower than it plays it, the start waits until enough sound is in
// hand that the rest arrives in time ("Getting the voice ready"), and when that wait would be too long
// the phone's own voice reads this answer instead, said once (core/voicepace.js, docs/VOICE.md).
// Handed only t, the speaker adapter, the phone's voices and the phone's Phonon engine (core/registry.js).
import { createPacer, fallBack, freshRtf, sayS } from '../../../core/voicepace.js';

const PIECE = 1500;

const aborted = () => Object.assign(new Error('stopped'), { name: 'AbortError' });
const blocked = () => Object.assign(new Error('the sound is blocked until a tap'), { name: 'AudioBlocked' });

export function create({ speaker, phonon, synth }) {
  const phoneVoice = () => {
    try {
      return (synth?.voices?.('en')?.length ?? 0) > 0;
    } catch {
      return false;
    }
  };
  return {
    id: 'phonon',
    available: () => !!phonon?.available(),
    private: () => true,
    pieceSize: () => PIECE,
    cached: () => true,
    price: () => 0,
    /** {needed, bytes}: whether the first use downloads the model, and how much. */
    download: () => phonon.download(),
    /**
     * Reads pieces aloud. onState: loading, buffering (waiting for sound in hand), playing.
     * onProgress: {loaded, total, fraction, phase} while the model downloads and gets ready, then
     * {fraction, phase: 'buffering'} while the start waits. onNotice('slow'): this answer is read by
     * the phone's own voice, as the natural voice is too slow here. done resolves {chargedMsub: 0,
     * via: 'native' | 'web' | 'phone', underruns}.
     */
    speak(pieces, { onState = () => {}, onProgress = () => {}, onNotice = () => {} } = {}) {
      const ctrl = new AbortController();
      const signal = ctrl.signal;
      let out = null;
      let stopNow = null;
      const chars = pieces.map((p) => p.length);
      const allChars = chars.reduce((a, b) => a + b, 0);
      const prefer = () => !!phonon.preferNatural?.();

      /** The phone's own voice reads this answer: the natural voice is too slow here. */
      async function phoneRead() {
        onNotice('slow');
        for (const p of pieces) {
          if (signal.aborted) throw aborted();
          const s = synth.speak(p, 'en');
          stopNow = () => s.stop();
          onState('playing');
          await s.done;
        }
        if (signal.aborted) throw aborted();
        return { chargedMsub: 0, via: 'phone', underruns: 0 };
      }
      /** Too slow before the first sound, by what was kept from earlier answers (recent enough to trust)? */
      const slowAlready = (kept) => fallBack({ rtf: freshRtf(kept), totalS: sayS(allChars, kept?.spc), preferNatural: prefer(), phoneVoice: phoneVoice() });

      /** The native voice: it decides the start itself, by the same rules. null: it cannot run here after all. */
      async function nativeRead(nat) {
        const key = phonon.paceKey?.(true) ?? 'native';
        const kept = phonon.pace?.(key) ?? null;
        if (slowAlready(kept)) return phoneRead();
        let started = false;
        const h = await nat.speak({
          pieces,
          voice: phonon.voice?.() ?? null,
          rtf: kept?.rtf ?? null,
          spc: kept?.spc ?? null,
          preferNatural: prefer(),
          phoneVoice: phoneVoice(),
          onStarted: () => {
            started = true;
            onState('playing');
          },
          onBuffering: ({ fraction }) => {
            if (started) return;
            onState('buffering');
            onProgress({ fraction, phase: 'buffering' });
          },
        });
        stopNow = h.stop;
        if (signal.aborted) h.stop();
        try {
          const r = await h.done;
          if (!r?.stopped) phonon.notePace?.(key, { rtf: r?.rtf, spc: r?.spc });
          if (signal.aborted || r?.stopped) throw aborted();
          return { chargedMsub: 0, via: 'native', underruns: r?.gaps ?? 0 };
        } catch (e) {
          if (signal.aborted) throw aborted();
          if (e?.code === 'too-slow') {
            phonon.notePace?.(key, { rtf: e.data?.rtf });
            return phoneRead();
          }
          // The voice process ended or could not load: the browser's build reads this answer.
          if (!started && ['crashed', 'load', 'unavailable'].includes(e?.code)) {
            phonon.nativeFailed?.(e);
            return null;
          }
          throw e;
        }
      }

      /** The browser's build: the sound comes here, and the start waits for sound in hand where it must. */
      async function webRead() {
        // {loaded, total, fraction, phase}: bytes of the whole load (the model and the voice), then
        // 'ready' once they are all here and the model is being set up.
        let last = { loaded: 0, total: 0, fraction: 0 };
        const tts = await phonon.load({
          onMeter: (m) => {
            last = m;
            onProgress({ ...m, phase: m.fraction >= 1 ? 'ready' : 'download' });
          },
        });
        if (signal.aborted) throw aborted();
        onProgress({ ...last, fraction: 1, phase: 'ready' });
        const key = phonon.paceKey?.(false) ?? 'web';
        const kept = phonon.pace?.(key) ?? null;
        if (slowAlready(kept)) return phoneRead();
        const pacer = createPacer({ chars, rtf: kept?.rtf ?? null, spc: kept?.spc ?? null, preferNatural: prefer(), phoneVoice: phoneVoice() });
        const held = [];
        let slow = null;
        const now = () => performance.now();
        const begin = async () => {
          // On iPhone the sound only starts if a tap unlocked it (speaker.unlock). When it did not,
          // say so rather than play into silence.
          if (speaker.ready && !(await speaker.ready(1500))) throw blocked();
          out = speaker.stream({ sampleRate: tts.sampleRate });
          onState('playing');
          for (const c of held) out.push(c);
          held.length = 0;
        };
        const step = async (s) => {
          if (s.fallback) slow = s.rtf;
          else if (s.start) await begin();
          else if (!out && s.rtf != null) {
            onState('buffering');
            onProgress({ fraction: s.fraction, phase: 'buffering' });
          }
        };
        for (const piece of pieces) {
          const p0 = now();
          let pieceS = 0;
          for await (const pcm of tts.stream(piece, { signal })) {
            if (signal.aborted) break;
            const sec = pcm.length / tts.sampleRate;
            pieceS += sec;
            if (out) {
              out.push(pcm);
              continue;
            }
            held.push(pcm);
            await step(pacer.audio(sec, now()));
            if (slow != null) break;
          }
          if (signal.aborted) throw aborted();
          if (slow != null) break;
          await step(pacer.pieceDone(pieceS, now() - p0, now()));
          if (slow != null) break;
        }
        if (slow != null) {
          phonon.notePace?.(key, { rtf: slow });
          return phoneRead();
        }
        if (!out && held.length) await begin();
        phonon.notePace?.(key, pacer.stats());
        if (out) {
          out.end();
          await out.done;
        }
        return { chargedMsub: 0, via: 'web', underruns: out?.underruns?.() ?? 0 };
      }

      const done = (async () => {
        onState('loading');
        const nat = await phonon.native?.();
        if (signal.aborted) throw aborted();
        if (nat) {
          const r = await nativeRead(nat);
          if (r) return r;
          if (signal.aborted) throw aborted();
        }
        return webRead();
      })();
      return {
        done,
        stop() {
          ctrl.abort();
          out?.stop();
          stopNow?.();
        },
      };
    },
  };
}
