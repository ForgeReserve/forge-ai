import { describe, expect, it } from 'vitest';

// When a slow phone starts reading aloud (public/v2/core/voicepace.js). The Android app's native voice
// runs the same rules in Kotlin; VoicePaceTest there checks the same numbers.
const V: any = await import('../../../public/v2/core/voicepace.js' as string);
const LAB: any = await import('../../../public/v2/core/voicelab.js' as string);

const CHUNK = 0.08; // seconds of sound per piece, as Phonon makes them

/**
 * One answer made by an engine at a steady rtf, piece by piece, through the pacer: when playback starts
 * (ms after the first piece of sound), and the gaps a listener hears once it plays. audioS: what the
 * engine really makes per piece of text; chars: each piece's length (what the pacer estimates from).
 */
function simulate({ rtf, audioS, chars, kept = null, spc = null, firstMs = 200, phoneVoice = false, preferNatural = false }: any): { fallback: boolean; startAt: number | null; waitMs: number; gaps: { underruns: number; stallMs: number }; pacer: any } {
  const pacer = V.createPacer({ chars, rtf: kept, spc, phoneVoice, preferNatural });
  let t = 0;
  const arrivals: number[] = [];
  const durations: number[] = [];
  let startAt: number | null = null;
  let fallback = false;
  const note = (s: any) => {
    if (s.fallback) fallback = true;
    if (s.start && startAt == null) startAt = t;
  };
  for (const [i, total] of audioS.entries()) {
    const p0 = t;
    t += firstMs;
    const n = Math.round(total / CHUNK);
    for (let k = 0; k < n; k++) {
      t += CHUNK * rtf * 1000;
      arrivals.push(t);
      durations.push(CHUNK * 1000);
      note(pacer.audio(CHUNK, t));
      if (fallback) return { fallback, startAt, waitMs: 0, gaps: { underruns: 0, stallMs: 0 }, pacer };
    }
    note(pacer.pieceDone(n * CHUNK, t - p0, t));
    if (fallback) return { fallback, startAt, waitMs: 0, gaps: { underruns: 0, stallMs: 0 }, pacer };
    void i;
  }
  note(pacer.finish());
  // Playback from startAt: what was made before is in hand; each later piece plays when it arrives.
  const played = arrivals.map((a) => Math.max(a, startAt!));
  const gaps = LAB.virtualUnderruns(played, durations, 0);
  return { fallback, startAt, waitMs: startAt! - arrivals[0]!, gaps, pacer };
}

describe('how much sound a slow phone makes before it starts reading', () => {
  it('starts at once when the phone keeps up (rtf at or under 0.8)', () => {
    expect(V.bufferTarget(10, 0.2)).toBe(0);
    expect(V.bufferTarget(10, 0.8)).toBe(0);
    expect(V.waitFor(10, 0.5)).toBe(0);
  });

  it('waits for remaining * (1 - 1/rtf) plus the margin above it', () => {
    expect(V.PACE).toMatchObject({ bufferRtf: 0.8, fallbackRtf: 1.6, maxWaitS: 6, marginS: 0.5 });
    expect(V.bufferTarget(10, 1.3)).toBeCloseTo(10 * (1 - 1 / 1.3) + 0.5, 9);
    expect(V.bufferTarget(10, 2)).toBeCloseTo(5.5, 9);
    // Between 0.8 and 1 the sums say nothing is needed: only the margin, against a phone that warms up.
    expect(V.bufferTarget(10, 0.9)).toBeCloseTo(0.5, 9);
    // The wait is that much sound, made at rtf.
    expect(V.waitFor(10, 1.3)).toBeCloseTo((10 * (1 - 1 / 1.3) + 0.5) * 1.3, 9);
  });

  it('with that much in hand, an engine at a steady rtf never runs dry', () => {
    for (const rtf of [0.85, 0.95, 1.1, 1.3, 1.5]) {
      for (const pieces of [[2], [8], [6, 6, 6], [20]]) {
        const chars = pieces.map((s) => Math.round(s / V.PACE.secPerChar));
        const r = simulate({ rtf, audioS: pieces, chars });
        expect(r.fallback).toBe(false);
        expect(r.gaps.underruns, `rtf ${rtf}, pieces ${pieces}`).toBe(0);
      }
    }
  });

  it('starts sooner when this phone keeps up, with the first piece once its speed is known', () => {
    const fast = simulate({ rtf: 0.25, audioS: [6], chars: [92], kept: 0.25 });
    expect(fast.waitMs).toBe(0);
    expect(fast.gaps.underruns).toBe(0);
    // Not yet known: it measures over the first third of a second of sound, then starts.
    const first = simulate({ rtf: 0.25, audioS: [6], chars: [92] });
    expect(first.waitMs).toBeLessThan(200);
    // Slow: it waits about what the sums say (the first piece's own delay left out).
    const slow = simulate({ rtf: 1.3, audioS: [8], chars: [123] });
    expect(slow.waitMs / 1000).toBeGreaterThan(V.bufferTarget(8, 1.3) * 1.3 - 0.2);
    expect(slow.waitMs / 1000).toBeLessThan(V.bufferTarget(8, 1.3) * 1.3 + 0.3);
  });

  it("measures the first piece's rtf (work over sound, as the voice lab counts it) and the speech per character", () => {
    const r = simulate({ rtf: 1.0, audioS: [4, 4], chars: [60, 60], firstMs: 200 });
    const s = r.pacer.stats();
    expect(s.rtf).toBeCloseTo((200 + 4000) / 1000 / 4, 6);
    expect(s.spc).toBeCloseTo(8 / 120, 6);
  });
});

describe("when the phone's own voice reads the answer instead", () => {
  const base = { phoneVoice: true, preferNatural: false };
  it('over rtf 1.6, or a wait over 6 s, with a phone voice to read it', () => {
    expect(V.fallBack({ ...base, rtf: 1.7, totalS: 2 })).toBe(true);
    // rtf 1.3: a 10 s answer waits 3.6 s (natural voice); a 30 s one would wait 9.6 s (the phone's).
    expect(V.fallBack({ ...base, rtf: 1.3, totalS: 10 })).toBe(false);
    expect(V.fallBack({ ...base, rtf: 1.3, totalS: 30 })).toBe(true);
    expect(V.fallBack({ ...base, rtf: 0.7, totalS: 600 })).toBe(false);
  });

  it('never when the person keeps the natural voice, when there is no phone voice, or before anything is measured', () => {
    expect(V.fallBack({ ...base, rtf: 3, totalS: 30, preferNatural: true })).toBe(false);
    expect(V.fallBack({ ...base, rtf: 3, totalS: 30, phoneVoice: false })).toBe(false);
    expect(V.fallBack({ ...base, rtf: null, totalS: 30 })).toBe(false);
  });

  it('the pacer says so once, as soon as this answer measures too slow, before anything played', () => {
    const r = simulate({ rtf: 2, audioS: [6], chars: [92], phoneVoice: true });
    expect(r.fallback).toBe(true);
    expect(r.startAt).toBeNull();
    // Kept on: it waits instead, and still never runs dry.
    const kept = simulate({ rtf: 2, audioS: [6], chars: [92], phoneVoice: true, preferNatural: true });
    expect(kept.fallback).toBe(false);
    expect(kept.gaps.underruns).toBe(0);
  });

  it('a kept estimate decides before measuring only while it is recent (30 minutes)', () => {
    const now = 1_000_000_000;
    expect(V.freshRtf({ rtf: 1.9, at: now - 60_000 }, now)).toBe(1.9);
    expect(V.freshRtf({ rtf: 1.9, at: now - 31 * 60_000 }, now)).toBeNull();
    expect(V.freshRtf(null, now)).toBeNull();
  });
});

describe("this phone's kept speed", () => {
  it('moves 30% toward each new answer, and starts from the first one', () => {
    expect(V.nextEstimate(null, 1.2)).toBe(1.2);
    expect(V.nextEstimate(1, 2)).toBeCloseTo(1.3, 9);
    expect(V.nextEstimate(1, null)).toBe(1);
    expect(V.notePace(null, { rtf: 0.94, spc: 0.07 })).toEqual({ rtf: 0.94, spc: 0.07, n: 1 });
    expect(V.notePace({ rtf: 1, spc: 0.07, n: 4 }, { rtf: 2 })).toEqual({ rtf: 1.3, spc: 0.07, n: 5 });
  });

  it('estimates how long a text takes to say', () => {
    expect(V.sayS(100)).toBeCloseTo(6.5, 9);
    expect(V.sayS(100, 0.08)).toBeCloseTo(8, 9);
  });
});
