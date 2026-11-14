// Voice: which engine audio models may be used, and what voice costs before it is sent. Pure, tested
// in Node. Amounts are msub (thousandths of a cent or sat), as the engine counts them.
//
// Private only applies to audio: with it on, only an audio model in sealed hardware (tier enclave) is
// used. The recording reaches that model through the engine, which holds it in memory while it passes
// and does not save it; it is not encrypted end to end the way private questions are.

/** The engine's audio models the person may use: {transcription, speech}, each the first allowed, or null. */
export function audioModels(list, { privateOnly }) {
  const ok = (m) => !privateOnly || m.tier === 'enclave';
  const first = (kind) => (list ?? []).find((m) => m.kind === kind && ok(m)) ?? null;
  return { transcription: first('transcription'), speech: first('speech') };
}

/**
 * msub for audio requests on this model: `requests` times the request price, plus seconds and
 * characters. null when the model has no price in this unit.
 */
export function audioMsub(model, unit, { seconds = 0, chars = 0, requests = 1 } = {}) {
  const p = unit === 'sat' ? model?.pricing?.sat : model?.pricing?.usd;
  if (!p || p.request == null) return null;
  const major = p.request * requests + (p.second ?? 0) * seconds + ((p.kchar ?? 0) * chars) / 1000;
  // usd: 1 USD = 100 cents = 100,000 msub. sat: 1 sat = 1,000 msub.
  return Math.ceil(major * (unit === 'sat' ? 1000 : 100_000) - 1e-9);
}

/** The price to turn a recording of `seconds` into text (whole seconds, rounded up: never less than billed). */
export const transcribeMsub = (model, unit, seconds) => audioMsub(model, unit, { seconds: Math.ceil(Math.max(0, seconds)) });

/** The price to read these pieces aloud: one request per piece. */
export function speakMsub(model, unit, pieces) {
  if (!pieces.length) return 0;
  return audioMsub(model, unit, { requests: pieces.length, chars: pieces.reduce((s, p) => s + [...p].length, 0) });
}

/** Characters a second of speech turns into, for the price of the question a recording becomes. */
export const CHARS_PER_SECOND = 16;
