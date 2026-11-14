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
