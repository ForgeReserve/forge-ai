// Recorded sound as WAV: the microphone gives float samples at the device's rate; the engine takes a
// 16 kHz mono 16-bit WAV file, which says its own length (the engine prices by it). Pure, tested in Node.

export const TARGET_RATE = 16000;

/** Joins Float32Array chunks into one. */
export function concat(chunks) {
  const n = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Float32Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/**
 * Resamples to `to` Hz. Going down, each output sample is the average of the input samples it covers
 * (a simple low-pass, enough for speech). Going up, it interpolates.
 */
export function resample(samples, from, to = TARGET_RATE) {
  if (!(from > 0) || !(to > 0)) throw new Error('sample rates must be positive');
  if (from === to) return Float32Array.from(samples);
  const ratio = from / to;
  const n = Math.floor(samples.length / ratio);
  const out = new Float32Array(n);
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * ratio);
      const b = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let s = 0;
      for (let j = a; j < b; j++) s += samples[j];
      out[i] = b > a ? s / (b - a) : 0;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const a = Math.floor(x);
      const f = x - a;
      out[i] = samples[a] * (1 - f) + (samples[Math.min(a + 1, samples.length - 1)] ?? 0) * f;
    }
  }
  return out;
}

/** A mono 16-bit PCM WAV file of the samples (clipped to -1..1). */
export function encodeWav(samples, rate = TARGET_RATE) {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const put = (o, s) => {
    for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i);
  };
  put(0, 'RIFF');
  dv.setUint32(4, 36 + samples.length * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true); // PCM
  dv.setUint16(22, 1, true); // mono
  dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true);
  }
  return out;
}

/** Seconds of sound in a 16-bit mono WAV made by encodeWav, or 0 when it is not one. */
export function wavSeconds(bytes) {
  if (!bytes || bytes.length < 44) return 0;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== 'RIFF') return 0;
  const rate = dv.getUint32(24, true);
  const channels = dv.getUint16(22, true);
  const bits = dv.getUint16(34, true);
  const data = Math.min(dv.getUint32(40, true), bytes.length - 44);
  return rate && channels && bits ? data / (rate * channels * (bits / 8)) : 0;
}

/** Loudness of a chunk from 0 to 1, for the level bars (root mean square, scaled so speech fills it). */
export function level(samples) {
  if (!samples?.length) return 0;
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.min(1, Math.sqrt(s / samples.length) * 4);
}
