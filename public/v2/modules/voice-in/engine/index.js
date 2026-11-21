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
 * guess words out of silence. A recording needs MIN_VOICE_SECONDS of voice, found either way:
 *
 * - Loud: pieces at VOICE_LEVEL or louder (core/wav.js level, RMS x 4). Speech near most phones is
 *   several times over it; so is a loud room, which is sent as before.
 * - Quiet: a microphone with no automatic gain (an iPhone with echo cancelling off gave a voice at about
 *   0.024, 2026-11-21) is judged by the recording's own shape. Its noise floor is the level under which a
 *   fifth of its pieces lie (QUIET_PART); a piece is voice at VOICE_RATIO times that floor, and never
 *   under QUIET_FLOOR. A voice rises and falls between words and before the first one; a steady room, a
 *   fan or a hiss stays within a little of its floor, and digital near-silence stays under QUIET_FLOOR.
 *   It needs MIN_FLOOR_PIECES pieces to have a floor at all.
 *
 * A wrong send costs one short transcription, which comes back with no words ("Nothing was heard.");
 * a wrong refusal loses the question, so the quiet rule leans to sending.
 */
export const VOICE_LEVEL = 0.05;
export const MIN_VOICE_SECONDS = 0.1;
export const QUIET_FLOOR = 0.008;
export const VOICE_RATIO = 2.5;
export const QUIET_PART = 0.2;
export const MIN_FLOOR_PIECES = 4;

/**
 * The gain the WAV sent to the engine gets: the loud part of the recording (its pieces at the 90th
 * percentile) brought to TARGET_LEVEL, at most MAX_GAIN (24 dB), never past HEADROOM at its loudest
 * sample (no clipping), and never quieter than it came.
 */
export const TARGET_LEVEL = 0.4;
export const MAX_GAIN = 16;
export const HEADROOM = 0.9;

/** The bars' level: each piece against the loudest so far, never against less than this, so a quiet microphone still moves them. */
export const BAR_FLOOR = 0.02;

const at = (sorted, part) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(part * (sorted.length - 1)))] : 0);

/**
 * How much voice a recording has, from its pieces' levels and lengths in seconds. Returns {floor, loud,
 * needs, seconds, rule}: the noise floor, the loud part's level (90th percentile), the level a piece
 * needs under the quiet rule, the seconds of voice, and which rule found it ('loud', 'quiet' or null).
 */
export function hearing(levels, lengths) {
  const sorted = [...levels].sort((a, b) => a - b);
  const floor = at(sorted, QUIET_PART);
  const loud = at(sorted, 0.9);
  const needs = Math.max(QUIET_FLOOR, VOICE_RATIO * floor);
  let loudSeconds = 0;
  let quietSeconds = 0;
  levels.forEach((l, i) => {
    if (l >= VOICE_LEVEL) loudSeconds += lengths[i];
    if (l >= needs) quietSeconds += lengths[i];
  });
  if (loudSeconds >= MIN_VOICE_SECONDS) return { floor, loud, needs, seconds: loudSeconds, rule: 'loud' };
  if (levels.length >= MIN_FLOOR_PIECES && quietSeconds >= MIN_VOICE_SECONDS) return { floor, loud, needs, seconds: quietSeconds, rule: 'quiet' };
  return { floor, loud, needs, seconds: Math.max(loudSeconds, quietSeconds), rule: null };
}

/** The recording at a level the engine can hear: {pcm, gain}, the gain bounded as TARGET_LEVEL, MAX_GAIN and HEADROOM say. */
export function normalise(pcm, loud) {
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (!peak || !loud) return { pcm, gain: 1 };
  const gain = Math.max(1, Math.min(MAX_GAIN, TARGET_LEVEL / loud, HEADROOM / peak));
  if (gain === 1) return { pcm, gain };
  const out = new Float32Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = Math.max(-1, Math.min(1, pcm[i] * gain));
  return { pcm: out, gain };
}

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
export function judge({ samples, voicedSeconds, rate, ms, ended = false }) {
  if (!samples) return ended || ms >= NO_SOUND_MS ? 'dead' : 'short';
  if (samples / rate < MIN_SEND_SECONDS) return 'short';
  if (voicedSeconds < MIN_VOICE_SECONDS) return 'quiet';
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
      const levels = []; // each piece's level
      const lengths = []; // each piece's length, in seconds
      let top = 0; // the loudest piece so far, for the bars
      rec.onData((buf) => {
        chunks.push(buf);
        samples += buf.length;
        const l = level(buf);
        levels.push(l);
        lengths.push(buf.length / rec.sampleRate);
        top = Math.max(top, l);
        // The bars show each piece against the loudest so far (never under BAR_FLOOR): a quiet
        // microphone moves them as a loud one does, and a silent room stays low.
        onLevel(Math.min(1, l / Math.max(top, BAR_FLOOR)));
      });
      return {
        seconds: () => samples / rec.sampleRate,
        async finish({ signal } = {}) {
          const ended = !!rec.facts?.().ended;
          rec.stop();
          const raw = resample(concat(chunks), rec.sampleRate, TARGET_RATE);
          chunks = [];
          const seconds = raw.length / TARGET_RATE;
          const h = hearing(levels, lengths);
          const why = judge({ samples, voicedSeconds: h.seconds, rate: rec.sampleRate, ms: now() - began, ended });
          const { pcm, gain } = why ? { pcm: raw, gain: 1 } : normalise(raw, h.loud);
          // For More, Voice: how the rule judged it and the gain the clip got (no sound, no words).
          rec.addFacts?.({ voiceLevel: VOICE_LEVEL, floor: h.floor, loud: h.loud, needs: h.needs, rule: h.rule, voicedSeconds: h.seconds, gain, verdict: why ?? 'sent' });
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
