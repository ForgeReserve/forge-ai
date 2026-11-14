// The voice lab (screens/voicelab.js, route #/voice-lab): a fixed corpus read by every voice this phone
// can run, and the numbers that decide which one ships. Pure, tested in Node.

/**
 * About sixty items: short replies, numbers and money, names, hard cases and long answers. Fixed, so
 * runs on different phones compare. Changing it changes CORPUS_VERSION.
 */
export const CORPUS_VERSION = 1;
export const CORPUS = Object.freeze([
  // Short replies, as a voice-first answer starts.
  ['short', 'Yes.'],
  ['short', 'No, not yet.'],
  ['short', 'Done. It is saved on this phone.'],
  ['short', 'Hold the button and talk.'],
  ['short', 'Your answer is ready.'],
  ['short', 'I could not hear that. Try again.'],
  ['short', 'That question was free.'],
  ['short', 'The engine is busy. Try again soon.'],
  ['short', 'Add funds to ask more.'],
  ['short', 'Here is what I found.'],
  ['short', 'Rain is likely after four.'],
  ['short', 'Drink water and rest today.'],
  ['short', 'The clinic opens at nine.'],
  ['short', 'Turn left at the market.'],
  ['short', 'Keep the receipt.'],
  ['short', 'This photo has no faces left.'],
  ['short', 'Burned. It is gone from this phone.'],
  ['short', 'Ask me again in your own words.'],
  ['short', 'Thank you for waiting.'],
  ['short', 'Good morning. How can I help?'],
  // Numbers and money.
  ['numbers', 'Your balance is $3.20.'],
  ['numbers', 'That costs 1,250 sats.'],
  ['numbers', 'You have 42 free questions left.'],
  ['numbers', 'The price is under $0.01.'],
  ['numbers', 'Send 0.00021 bitcoin to this address.'],
  ['numbers', 'The bus leaves at 6:45 pm.'],
  ['numbers', 'Take 2 tablets every 8 hours, no more than 6 a day.'],
  ['numbers', 'It is 27 degrees, with a 60% chance of rain.'],
  ['numbers', 'Call 112 in an emergency.'],
  ['numbers', 'The fee went from $12.50 to $14.75, a rise of 18%.'],
  ['numbers', 'On 3 December 2026 the event starts at 10:00.'],
  ['numbers', 'A family of 5 needs about 15 litres of water a day.'],
  ['numbers', 'Room 214, floor 2, building B.'],
  ['numbers', 'Version 2.0.1 fixed 37 problems.'],
  ['numbers', 'You paid 2,100 sats and got 400 back.'],
  // Names and places.
  ['names', 'Amara Okonkwo will meet you at the station.'],
  ['names', 'Siobhan and Niamh are from Galway.'],
  ['names', 'Ask for Dr Nguyen at Kibera clinic.'],
  ['names', 'The road from Nairobi to Mombasa is open.'],
  ['names', 'Thanh Huong sent eCash to Jabari.'],
  ['names', 'Port-au-Prince, Kingston and Bridgetown.'],
  ['names', 'Oaxaca, Guadalajara and Tegucigalpa.'],
  ['names', 'Aoife, Zainab, Yusuf and Lwazi joined.'],
  ['names', 'Kwame Mensah lives in Kumasi.'],
  ['names', 'Priya Raghunathan works in Chennai.'],
  // Hard cases: abbreviations, symbols, unknown words, a web address.
  ['hard', 'The UN and WHO said so in a PDF.'],
  ['hard', 'Use Wi-Fi, not 4G, for big files.'],
  ['hard', 'Open forge-reserve.com and tap More.'],
  ['hard', 'Lightning, eCash and on-chain all work.'],
  ['hard', 'Cashu, Fedimint and NFC cards.'],
  ['hard', 'e.g. a note, a card or a QR code.'],
  ['hard', 'It said "not found" (error 404).'],
  ['hard', 'Brrrr, it is cold! Really? Yes!'],
  ['hard', 'Mix 1/2 cup of flour with 3 eggs.'],
  // Longer answers, read sentence by sentence.
  ['medium', 'Boil the water for one full minute, then let it cool. Store it in a clean container with a lid. Use it within a day.'],
  ['medium', 'Your money is held as eCash on this phone until the engine confirms it. If the connection drops, nothing is lost. Open the app again and it carries on.'],
  ['medium', 'The photo was cleaned before it left the phone. Location and camera details are gone, and the two faces are covered with solid blocks.'],
  ['medium', 'Private questions go to a model in sealed hardware. The engine passes them on but cannot read them. Your network address is still seen unless you use a relay or Tor.'],
  ['long', 'Here is a simple plan for the week. On Monday, buy rice, beans, oil and salt, which keep for a long time. On Tuesday and Wednesday, cook enough for two days at once, so you use less fuel. Keep cooked food covered and cool, and eat it within a day. On Thursday, check what is left and buy fresh vegetables. On Friday, go to the market early, when prices are lower. At the weekend, rest, and plan the next week with what is left. If money runs short, beans and rice together give you most of what you need. Ask me again if you want a list for a larger family, or for someone who cannot eat certain foods.'],
  ['long', 'To add funds with a paper note, open the gold ring and choose Scan a note. Hold the phone over the code until it reads it. The app shows the amount and the mint, and adds it with one tap. If the note was already used, it says so, and nothing is taken. If it comes from a mint the engine does not take, the app offers another way to add it. Your balance goes up as soon as the engine confirms the note. Until then the note stays on this phone, so it is never lost on the way.'],
].map(([kind, text], i) => Object.freeze({ id: `c${String(i + 1).padStart(2, '0')}`, kind, text })));

/** The ways of reading the corpus a phone may have, in the order the lab runs them. */
export const CANDIDATES = Object.freeze([
  { id: 'phonon-cpu-threads', engine: 'phonon', device: 'cpu', threads: 'auto' },
  { id: 'phonon-cpu-single', engine: 'phonon', device: 'cpu', threads: 1 },
  { id: 'phonon-webgpu', engine: 'phonon', device: 'webgpu', threads: 'auto' },
  { id: 'phone-voice', engine: 'device' },
]);

/**
 * Gaps a listener would hear, from when each piece of sound arrived (ms) and how long each lasts (ms):
 * playback starts when the first piece arrives (plus `lead` ms), and a piece that arrives after the one
 * before has finished is a gap. Returns {underruns, stallMs} (the silence added in all).
 */
export function virtualUnderruns(arrivals, durations, lead = 50) {
  let underruns = 0;
  let stallMs = 0;
  if (!arrivals.length) return { underruns, stallMs };
  let end = arrivals[0] + lead;
  for (let i = 0; i < arrivals.length; i++) {
    if (i > 0 && arrivals[i] > end) {
      underruns++;
      stallMs += arrivals[i] - end;
      end = arrivals[i];
    }
    end += durations[i] ?? 0;
  }
  return { underruns, stallMs: Math.round(stallMs) };
}

/** The p-th percentile (0 to 100) of a list of numbers, by nearest rank. null for an empty list. */
export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = Math.ceil((p / 100) * v.length);
  return v[Math.min(v.length - 1, Math.max(0, rank - 1))];
}

const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

/**
 * One candidate's summary from its item rows ({firstMs, rtf, underruns, nan, silent, clipped, error}):
 * medians and 90th percentiles, and counts of the runs that went wrong.
 */
export function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  const pick = (k) => ok.map((r) => r[k]).filter((x) => x != null);
  return {
    items: rows.length,
    failed: rows.length - ok.length,
    firstMs: { median: round(percentile(pick('firstMs'), 50), 0), p90: round(percentile(pick('firstMs'), 90), 0) },
    rtf: { median: round(percentile(pick('rtf'), 50)), p90: round(percentile(pick('rtf'), 90)) },
    underruns: ok.reduce((s, r) => s + (r.underruns ?? 0), 0),
    nanRuns: ok.filter((r) => r.nan > 0).length,
    silentRuns: ok.filter((r) => r.silent).length,
    clippedRuns: ok.filter((r) => r.clipped > 0).length,
    // Phone voice lines whose end never came (iOS often drops it): cancelled at their deadline.
    timedOutRuns: ok.filter((r) => r.timedOut).length,
  };
}

/** The file the owner sends back: what was run, on what, and every number. */
export function report({ env, voice, voiceLocale = null, accentTest = false, candidates }) {
  return {
    kind: 'forge-voice-lab',
    version: 1,
    corpusVersion: CORPUS_VERSION,
    at: new Date().toISOString(),
    env,
    voice,
    voiceLocale,
    // An accent-test voice: a speaker from another locale read by the English model (docs/VOICE.md).
    accentTest,
    candidates: candidates.map((c) => ({ ...c, summary: c.rows ? summarize(c.rows) : null })),
  };
}

/** A voice's language as BCP 47 in lower case: en-GB, en_GB (older WebKit) and en-gb all read en-gb. */
export const voiceLang = (v) => String(v?.lang ?? '').replace(/_/g, '-').toLowerCase();

/**
 * The phone's own voices that read English on the phone: localService (never one that sends the text
 * to a voice service, as Chrome's Google voices do), language en or en-*. WebKit marks every iOS and
 * macOS voice local, with languages like en-GB and en-US. British English first, then American, then
 * any other English; the system's default first within each.
 */
export function phoneVoices(list) {
  const rank = (v) => {
    const l = voiceLang(v);
    return (l === 'en-gb' ? 0 : l === 'en-us' ? 2 : 4) + (v.default ? 0 : 1);
  };
  return [...(list ?? [])]
    .filter((v) => v?.localService && /^en(-|$)/.test(voiceLang(v)))
    .map((v, i) => [v, i])
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([v]) => v);
}

/**
 * The browser's voice list once it has one. getVoices() is often empty at first and fills later
 * (iOS Safari among others): this waits for the voiceschanged event, and also looks again every
 * `poll` ms (some browsers fill the list without the event), for up to `ms`. Resolves to the list,
 * empty when the phone has no voice at all (GrapheneOS has no speech engine).
 */
export function waitForVoices(synth, ms = 4000, poll = 250) {
  const now = () => {
    try {
      return synth?.getVoices?.() ?? [];
    } catch {
      return [];
    }
  };
  const first = now();
  if (first.length || !synth) return Promise.resolve(first);
  return new Promise((resolve) => {
    let timer = null;
    let ticker = null;
    const finish = () => {
      clearTimeout(timer);
      clearInterval(ticker);
      synth.removeEventListener?.('voiceschanged', check);
      resolve(now());
    };
    const check = () => now().length && finish();
    synth.addEventListener?.('voiceschanged', check);
    ticker = setInterval(check, poll);
    timer = setTimeout(finish, ms);
  });
}

/** How long a line may go without sound, at its start or between two pieces, before the lab calls it hung. */
export const LINE_STALL_MS = 30_000;

/** A failed line: code 'stalled' (no sound in time), 'no-sound' (ended with none) or the stream's own error. */
const lineError = (code, message) => Object.assign(new Error(message), { code });

/**
 * Reads one line with a loaded model and times each piece of sound: resolves to {arrivals, durations,
 * chunks, totalMs, stopped} (ms from the start; stopped when signal was aborted). Throws when the
 * stream fails, when no sound comes for stallMs (a model that hangs would otherwise hold the run for
 * ever), and when the stream ends with no sound and no error: that is a failure, never a line of
 * silence (a WebGPU run on desktop Safari read nothing and said nothing).
 */
export async function readLine(tts, text, { voice, signal, stallMs = LINE_STALL_MS, now = () => performance.now(), onPcm } = {}) {
  const inner = new AbortController();
  const stop = () => inner.abort();
  if (signal?.aborted) inner.abort();
  else signal?.addEventListener('abort', stop, { once: true });
  const it = tts.stream(text, { voice, signal: inner.signal })[Symbol.asyncIterator]();
  const s0 = now();
  const out = { arrivals: [], durations: [], chunks: [], totalMs: 0, stopped: false };
  let timer = null;
  const abortedP = whenAborted(signal);
  try {
    for (;;) {
      const stalled = new Promise((_, reject) => {
        timer = setTimeout(() => reject(lineError('stalled', `no sound for ${Math.round(stallMs / 1000)} s${out.chunks.length ? ` after ${out.chunks.length} pieces` : ''}`)), stallMs);
      });
      // Stop ends the line at once, even when the model never answers again (a hung worker).
      const r = await Promise.race([it.next(), stalled, abortedP]);
      clearTimeout(timer);
      if (r === ABORTED || r.done) break;
      out.arrivals.push(now() - s0);
      out.durations.push((r.value.length / tts.sampleRate) * 1000);
      out.chunks.push(r.value);
      onPcm?.(r.value);
    }
  } catch (e) {
    if (e?.code === 'stalled') inner.abort();
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    it.return?.()?.catch?.(() => {});
  }
  out.totalMs = now() - s0;
  out.stopped = !!signal?.aborted;
  if (!out.stopped && !out.chunks.some((c) => c.length > 0)) throw lineError('no-sound', 'the model ended the line with no sound and no error');
  return out;
}

/**
 * Why a candidate's run gave no result to read, or null when it did: its own error (a failed load),
 * no line read although nobody pressed Stop, or every line failed (the first line's error). A run
 * stopped before its first line is not a failure (stopped, from the caller).
 */
export function candidateError(c, { stopped = false } = {}) {
  if (c.error) return c.error;
  const rows = c.rows ?? [];
  if (!rows.length) return stopped ? null : 'no line was read, and no error was given';
  if (rows.every((r) => r.error)) return `every line failed: ${rows[0].error}`;
  return null;
}

const ABORTED = Symbol('aborted');
/** Resolves to ABORTED once signal aborts (never, without a signal). */
function whenAborted(signal) {
  if (!signal) return new Promise(() => {});
  if (signal.aborted) return Promise.resolve(ABORTED);
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(ABORTED), { once: true }));
}

/**
 * The promise, or an AbortError as soon as signal aborts, whichever comes first: so Stop never waits on
 * something that ignores it (a load, a sound that never ends, a hung worker).
 */
export async function untilAborted(promise, signal) {
  const r = await Promise.race([promise, whenAborted(signal)]);
  if (r === ABORTED) throw Object.assign(new Error('stopped'), { name: 'AbortError' });
  return r;
}

/**
 * A line cut for the phone's own voice: pieces of at most max characters, at sentence ends where it
 * can, else at a comma or a space. iOS reads a long utterance badly and often never says it ended.
 */
export function splitForSpeech(text, max = 200) {
  const sentences = String(text).trim().split(/(?<=[.!?])\s+/).filter(Boolean);
  const cut = (s) => {
    const parts = [];
    let rest = s;
    while (rest.length > max) {
      const head = rest.slice(0, max + 1);
      const at = Math.max(head.lastIndexOf(', ') + 1, head.lastIndexOf(' '));
      const end = at > 0 ? at : max;
      parts.push(rest.slice(0, end).trim());
      rest = rest.slice(end).trim();
    }
    if (rest) parts.push(rest);
    return parts;
  };
  const pieces = [];
  for (const s of sentences.flatMap(cut)) {
    const last = pieces.at(-1);
    if (last != null && last.length + 1 + s.length <= max) pieces[pieces.length - 1] = `${last} ${s}`;
    else pieces.push(s);
  }
  return pieces;
}

/** Characters a voice says in a second, for the phone voice's deadline (as core/voice.js reckons). */
export const SPEECH_CPS = 16;

/** How long a piece of the phone's voice may take before the lab gives up on its end: 2.5 times its length, plus 5 s. */
export const speechDeadlineMs = (text, cps = SPEECH_CPS) => Math.round(2.5 * (String(text).length / cps) * 1000 + 5000);

/**
 * Says one corpus line with the phone's own voice (speechSynthesis), piece by piece (splitForSpeech),
 * and times it. Every piece has a deadline (speechDeadlineMs): when its end never comes, as iOS often
 * does, it is cancelled and the line is timedOut, and the rest of it is skipped. Stop resolves at once
 * (stopped), whatever the voice does. Resolves to {firstMs, totalMs, started, timedOut, stopped,
 * pieces, error}; never rejects. Utterance: SpeechSynthesisUtterance (tests pass a fake).
 */
export async function speakLine({ synth, Utterance, voice, text, signal, now = () => performance.now(), deadline = speechDeadlineMs, settleMs = 250 }) {
  const pieces = splitForSpeech(text);
  const s0 = now();
  const out = { firstMs: null, totalMs: null, started: false, timedOut: false, stopped: false, pieces: pieces.length, error: null };
  for (const piece of pieces) {
    if (signal?.aborted) break;
    const r = await new Promise((resolve) => {
      let timer = null;
      const end = (how) => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(how);
      };
      const onAbort = () => {
        try {
          synth.cancel();
        } catch {
          /* nothing to cancel */
        }
        end({ stopped: true });
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      const u = new Utterance(piece);
      if (voice) {
        u.voice = voice;
        u.lang = voice.lang;
      }
      u.onstart = () => {
        out.started = true;
        out.firstMs ??= now() - s0;
      };
      u.onend = () => end({});
      u.onerror = (e) => {
        const why = String(e?.error ?? 'error');
        // A cancel (ours or the system's) is not this piece's failure.
        end(why === 'interrupted' || why === 'canceled' ? {} : { error: why });
      };
      timer = setTimeout(() => {
        try {
          synth.cancel();
        } catch {
          /* nothing to cancel */
        }
        end({ timedOut: true });
      }, deadline(piece));
      try {
        synth.speak(u);
      } catch (e) {
        end({ error: String(e?.message ?? e) });
      }
    });
    if (r.stopped) {
      out.stopped = true;
      break;
    }
    if (r.error) {
      out.error = r.error;
      break;
    }
    if (r.timedOut) {
      out.timedOut = true;
      // iOS needs a moment after a cancel before it speaks again.
      await Promise.race([new Promise((res) => setTimeout(res, settleMs)), whenAborted(signal)]);
      break;
    }
  }
  out.totalMs = now() - s0;
  out.stopped ||= !!signal?.aborted;
  return out;
}
