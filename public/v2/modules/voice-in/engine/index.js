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

export function create({ mic, audio }) {
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
          rec.stop();
          const pcm = resample(concat(chunks), rec.sampleRate, TARGET_RATE);
          chunks = [];
          const seconds = pcm.length / TARGET_RATE;
          if (seconds < MIN_SEND_SECONDS || voiced / rec.sampleRate < MIN_VOICE_SECONDS) return { text: '', chargedMsub: 0, balanceMsub: null };
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
