// Voice in through the engine: the microphone records on the phone, the sound is made into a 16 kHz WAV
// file in memory and sent to the engine's speech to text model, which is paid per request. The
// recording is dropped as soon as it is sent or cancelled; nothing here stores it.
// Handed only t, the microphone adapter and the audio calls for speech to text (core/registry.js).
import { concat, encodeWav, level, resample, TARGET_RATE } from '../../../core/wav.js';

/**
 * The shortest recording sent, in seconds. Shorter is a tap or a microphone that started late (the
 * engine refuses under 0.3 s): nothing is sent or paid for, and the person is asked to hold and speak.
 */
export const MIN_SEND_SECONDS = 0.5;

/**
 * A recording with no voice in it is not sent either: nothing is paid for, and no model is left to
 * guess words out of silence. A chunk counts as voice at this level or louder (core/wav.js level: a
 * quiet room stays well under it, speech near the phone is several times over it), and a recording
 * needs this much voice in all.
 */
export const VOICE_LEVEL = 0.05;
export const MIN_VOICE_SECONDS = 0.1;

/**
 * A recording that ran this long (from the moment the microphone opened) with no sample at all came
 * from a microphone that gave no sound: a context that never ran, a capture that never fired, a
 * microphone that ended. That is a microphone problem (talk.micSilent), not silence.
 */
export const NO_SOUND_MS = 1000;

const NOTHING = { text: '', chargedMsub: 0, balanceMsub: null };

/** The error for a microphone that gave no sound: said on the answer screen, and the next hold opens the microphone afresh. */
export const micSilent = () => Object.assign(new Error('The microphone gave no sound.'), { code: 'mic_silent', key: 'talk.micSilent' });

/**
 * What a recording with nothing to send was, from its sound: 'short' (under MIN_SEND_SECONDS: a tap,
 * or a microphone that started late), 'quiet' (sound came, but no voice: a muted microphone, or a hold
 * with nothing said), or null when it is to be sent. A recording with no samples at all is either
 * 'short' (let go within NO_SOUND_MS) or a microphone that gave no sound ('dead').
 */
export function judge({ samples, voiced, rate, ms, ended = false }) {
  if (!samples) return ended || ms >= NO_SOUND_MS ? 'dead' : 'short';
  if (samples / rate < MIN_SEND_SECONDS) return 'short';
  if (voiced / rate < MIN_VOICE_SECONDS) return 'quiet';
  return null;
}

export function create({ mic, audio, now = () => Date.now() }) {
  const model = () => audio.model('transcription');
  return {
    id: 'engine',
    available: () => !!model() && mic.available(),
    /** True when the sound goes only to a model in sealed hardware. */
    private: () => model()?.tier === 'enclave',
    price: (seconds) => audio.price('transcription', { seconds }),
    maxSeconds: () => model()?.max_seconds ?? 60,
    async start({ onLevel = () => {} } = {}) {
      const rec = await mic.open();
      const began = now();
      let chunks = [];
      let samples = 0;
      let voiced = 0; // samples in chunks loud enough to be a voice
      rec.onData((buf) => {
        chunks.push(buf);
        samples += buf.length;
        const l = level(buf);
        if (l >= VOICE_LEVEL) voiced += buf.length;
        onLevel(l);
      });
      return {
        seconds: () => samples / rec.sampleRate,
        async finish({ signal } = {}) {
          const ended = !!rec.facts?.().ended;
          rec.stop();
          const pcm = resample(concat(chunks), rec.sampleRate, TARGET_RATE);
          chunks = [];
          const seconds = pcm.length / TARGET_RATE;
          const why = judge({ samples, voiced, rate: rec.sampleRate, ms: now() - began, ended });
          // For More, Voice: the level a voice is counted at, and how much voice came (no sound, no words).
          rec.addFacts?.({ voiceLevel: VOICE_LEVEL, voicedSeconds: voiced / rec.sampleRate, verdict: why ?? 'sent' });
          if (why === 'dead') throw micSilent();
          // Nothing is sent or paid for; the screen says which (core/talkctl.js).
          if (why) return { ...NOTHING, empty: why };
          const wav = encodeWav(pcm, TARGET_RATE);
          return audio.transcribe(wav, { seconds, signal });
        },
        cancel() {
          rec.stop();
          chunks = [];
        },
      };
    },
  };
}
