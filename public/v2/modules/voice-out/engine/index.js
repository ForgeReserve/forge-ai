// Voice out through the engine: each piece of the answer is sent to the engine's text to speech model
// (paid per request) and played as it arrives, the next piece fetched while one plays. Each piece is
// kept in this page's memory as soon as it arrives, for the last few answers, so Listen never pays twice
// for a piece already paid for: not after a stop part way, and not when playing it failed.
// Handed only t, the speaker adapter and the audio calls for text to speech (core/registry.js).
const KEEP = 4;

export function create({ speaker, audio }) {
  const model = () => audio.model('speech');
  // key -> {count, pieces: [{text, blob}]}, sparse: a piece is there once it was paid for.
  const cache = new Map();
  const have = (key, pieces, i) => {
    const e = cache.get(key);
    return e && e.pieces[i]?.text === pieces[i] ? e.pieces[i].blob : null;
  };
  const missing = (pieces, key) => pieces.map((_, i) => i).filter((i) => !have(key, pieces, i));
  /** Keeps one paid piece, the answer it belongs to becoming the most recent. */
  const keep = (key, count, i, text, blob) => {
    if (key == null) return;
    const e = cache.get(key) ?? { count, pieces: [] };
    cache.delete(key);
    e.count = count;
    e.pieces[i] = { text, blob };
    cache.set(key, e);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
  };
  return {
    id: 'engine',
    available: () => !!model(),
    private: () => model()?.tier === 'enclave',
    pieceSize: () => model()?.max_chars ?? 500,
    /** True when every piece of this answer is here. */
    cached: (key) => {
      const e = cache.get(key);
      if (!e) return false;
      for (let i = 0; i < e.count; i++) if (!e.pieces[i]) return false;
      return true;
    },
    /** msub to read these pieces aloud: only the pieces not here yet, 0 when they all are. */
    price: (pieces, key) => {
      const need = missing(pieces, key);
      if (!need.length) return 0;
      return audio.price('speech', { requests: need.length, chars: need.reduce((s, i) => s + [...pieces[i]].length, 0) });
    },
    speak(pieces, { key, onState = () => {} } = {}) {
      const ctrl = new AbortController();
      let playing = null;
      let charged = 0;
      const done = (async () => {
        // Fetches piece i unless it is here, and keeps it the moment it arrives, before it plays.
        const get = (i) => {
          const blob = have(key, pieces, i);
          if (blob) return Promise.resolve(blob);
          const p = audio.speak(pieces[i], { signal: ctrl.signal }).then((r) => {
            charged += r.chargedMsub ?? 0;
            keep(key, pieces.length, i, pieces[i], r.blob);
            return r.blob;
          });
          p.catch(() => {});
          return p;
        };
        if (pieces.length && !have(key, pieces, 0)) onState('loading');
        let next = pieces.length ? get(0) : null;
        for (let i = 0; i < pieces.length; i++) {
          if (ctrl.signal.aborted) break;
          const blob = await next;
          next = i + 1 < pieces.length ? get(i + 1) : null;
          if (ctrl.signal.aborted) break;
          onState('playing');
          playing = speaker.play(blob);
          await playing.done;
          playing = null;
        }
        return { chargedMsub: charged };
      })();
      return {
        done,
        stop() {
          ctrl.abort();
          playing?.stop();
        },
      };
    },
  };
}
