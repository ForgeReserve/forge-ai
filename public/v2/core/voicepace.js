// Reading aloud on a phone that makes the natural voice slower than it plays it (docs/VOICE.md, Slow
// phones). The voice is made piece by piece while it plays; when making a second of sound takes more
// than about 0.8 s, playing at once runs dry and the listener hears gaps. So the app measures how fast
// this phone makes it (the real-time factor, rtf: seconds of work per second of sound) and holds the
// start until enough is made that the rest arrives before it is needed. When that wait would be long,
// the answer goes to the phone's own voice instead. Pure, tested in Node; the Android app's native
// voice runs the same rules in Kotlin (android/.../VoicePace.kt, the same numbers).

export const PACE = Object.freeze({
  /** Above this rtf, playback waits for sound in hand; at or below it, it starts with the first piece. */
  bufferRtf: 0.8,
  /** Above this rtf, the answer is read by the phone's own voice (when the phone has one). */
  fallbackRtf: 1.6,
  /** The longest wait before the first sound; longer, and the phone's own voice reads the answer. */
  maxWaitS: 6,
  /** Sound kept in hand on top of what the sums say, against the phone slowing down as it warms up. */
  marginS: 0.5,
  /** Sound made after the first piece before the phone's own speed counts (the first piece's delay is left out). */
  measureS: 0.32,
  /** Seconds of speech per character of text, until this phone has measured its own. */
  secPerChar: 0.065,
  /** How much one answer moves the kept estimate. */
  weight: 0.3,
  /**
   * How long a kept estimate may send an answer to the phone's voice before it is measured again: a
   * phone that was hot may have cooled, and an answer read by the phone's voice measures nothing.
   */
  trustMs: 30 * 60_000,
});

/** The kept rtf when it is recent enough to decide on before measuring (trustMs), else null. */
export const freshRtf = (kept, now = Date.now(), p = PACE) => (kept?.rtf > 0 && now - (kept.at ?? 0) <= p.trustMs ? kept.rtf : null);

/**
 * Seconds of sound that must be ready before playback starts so that it never runs dry: with D seconds
 * still to play and sound made at 1/rtf seconds a second, the start waits for D * (1 - 1/rtf), plus the
 * margin. 0 (start at once) when the phone keeps up, rtf <= bufferRtf.
 */
export function bufferTarget(remainingS, rtf, p = PACE) {
  if (!(rtf > p.bufferRtf)) return 0;
  return Math.max(0, remainingS * (1 - 1 / rtf)) + p.marginS;
}

/** Seconds the listener waits for the first sound: making bufferTarget seconds of sound takes rtf times as long. */
export const waitFor = (remainingS, rtf, p = PACE) => bufferTarget(remainingS, rtf, p) * rtf;

/**
 * Whether this answer goes to the phone's own voice: this phone makes the natural voice at over
 * fallbackRtf, or the wait would be over maxWaitS. Never when the person asked to keep the natural
 * voice (preferNatural), when the phone has no voice of its own, or before anything is measured.
 */
export function fallBack({ rtf, totalS, preferNatural = false, phoneVoice = false }, p = PACE) {
  if (preferNatural || !phoneVoice || !(rtf > 0)) return false;
  return rtf > p.fallbackRtf || waitFor(totalS, rtf, p) > p.maxWaitS;
}

/** The running estimate kept for this phone: the new measure weighted against what was kept. */
export function nextEstimate(kept, measured, p = PACE) {
  if (!(measured > 0) || !Number.isFinite(measured)) return kept > 0 ? kept : null;
  if (!(kept > 0)) return measured;
  return kept * (1 - p.weight) + measured * p.weight;
}

/** The kept {rtf, spc} with one answer's {rtf, spc} added (rounded, as it goes in the settings). */
export function notePace(kept, m, p = PACE) {
  const r = (x) => (x == null ? null : Math.round(x * 1e4) / 1e4);
  return { rtf: r(nextEstimate(kept?.rtf, m?.rtf, p)), spc: r(nextEstimate(kept?.spc, m?.spc, p)), n: (kept?.n ?? 0) + (m?.rtf > 0 ? 1 : 0) };
}

/** Seconds a text of this many characters takes to say. */
export const sayS = (chars, spc = PACE.secPerChar) => chars * (spc > 0 ? spc : PACE.secPerChar);

/**
 * The start of one answer, piece by piece. chars: each piece's length; rtf, spc: the kept estimate
 * (null when this phone has none yet). Call audio(seconds, atMs) for each piece of sound as it is made
 * and pieceDone(seconds, genMs) when a piece of text is done; both say {start, fraction, rtf, fallback}:
 * start once (the moment to start playing), fraction how far the wait is (0 to 1), fallback once when
 * the phone measures too slow before anything played (and the answer may go to the phone's voice).
 * finish() when every piece is made. stats() gives {rtf, spc}: the first piece's rtf (its work over
 * its sound, as the voice lab counts it) and the seconds of speech per character, for notePace.
 */
export function createPacer({ chars, rtf = null, spc = null, preferNatural = false, phoneVoice = false, p = PACE }) {
  const n = chars.length;
  const spcUse = spc > 0 ? spc : p.secPerChar;
  const doneS = [];
  let piece = 0;
  let pieceS = 0;
  let madeS = 0;
  let firstAt = null;
  let firstS = 0;
  let started = false;
  let checked = false;
  let firstRtf = null;
  let doneChars = 0;
  let doneAudio = 0;
  /** Seconds still to play (nothing has played before the start): what is made, and the rest by its length. */
  const remaining = () => {
    let s = 0;
    for (let i = 0; i < n; i++) s += i < piece ? doneS[i] : i === piece ? Math.max(pieceS, sayS(chars[i], spcUse)) : sayS(chars[i], spcUse);
    return Math.max(s, madeS);
  };
  /** This answer's own speed, once enough is made: time since the first sound over the sound made since. */
  const live = (at) => (firstAt != null && madeS - firstS >= p.measureS ? Math.max(0, at - firstAt) / 1000 / (madeS - firstS) : null);
  const decide = (at) => {
    if (started) return { start: false, fraction: 1, rtf: null, fallback: false };
    const lr = live(at);
    if (lr != null && !checked) {
      checked = true;
      if (fallBack({ rtf: lr, totalS: remaining(), preferNatural, phoneVoice }, p)) return { start: false, fraction: 0, rtf: lr, fallback: true };
    }
    const r = lr ?? rtf;
    if (!(r > 0)) return { start: false, fraction: 0, rtf: null, fallback: false };
    const target = bufferTarget(remaining(), r, p);
    const start = madeS >= target;
    if (start) started = true;
    return { start, fraction: target > 0 ? Math.min(1, madeS / target) : 1, rtf: r, fallback: false, targetS: target };
  };
  return {
    audio(seconds, at) {
      if (firstAt == null) {
        firstAt = at;
        firstS = seconds;
      }
      madeS += seconds;
      pieceS += seconds;
      return decide(at);
    },
    pieceDone(seconds, genMs, at = null) {
      doneS[piece] = seconds;
      if (piece === 0 && seconds > 0) firstRtf = genMs / 1000 / seconds;
      if (seconds > 0) {
        doneChars += chars[piece] ?? 0;
        doneAudio += seconds;
      }
      piece++;
      pieceS = 0;
      return at == null ? { start: false, fraction: started ? 1 : 0, rtf: null, fallback: false } : decide(at);
    },
    finish() {
      const s = !started;
      started = true;
      return { start: s, fraction: 1, rtf: null, fallback: false };
    },
    get started() {
      return started;
    },
    remainingS: remaining,
    stats: () => ({ rtf: firstRtf, spc: doneChars > 0 ? doneAudio / doneChars : null }),
  };
}
