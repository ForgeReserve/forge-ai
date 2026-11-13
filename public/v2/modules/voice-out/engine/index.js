// Voice out through the engine: each piece of the answer is sent to the engine's text to speech model
// (paid per request) and played as it arrives, the next piece fetched while one plays. The sound is
// kept in this page's memory for the last few answers, so Again replays it without paying twice.
// Handed only t, the speaker adapter and the audio calls for text to speech (core/registry.js).
const KEEP = 4;

export function create({ speaker, audio }) {
  const model = () => audio.model('speech');
  const cache = new Map(); // key -> Blob[]
  const remember = (key, blobs) => {
    cache.delete(key);
    cache.set(key, blobs);
    while (cache.size > KEEP) cache.delete(cache.keys().next().value);
  };
  return {
    id: 'engine',
    available: () => !!model(),
    private: () => model()?.tier === 'enclave',
    pieceSize: () => model()?.max_chars ?? 500,
    cached: (key) => cache.has(key),
    /** msub to read these pieces aloud, 0 when they are already here. */
    price: (pieces, key) => (cache.has(key) ? 0 : audio.price('speech', { requests: pieces.length, chars: pieces.reduce((s, p) => s + [...p].length, 0) })),
    speak(pieces, { key, onState = () => {} } = {}) {
      const ctrl = new AbortController();
      let playing = null;
      let charged = 0;
      const done = (async () => {
        const have = cache.get(key);
        const blobs = have ? [...have] : [];
        const fetchPiece = (i) => audio.speak(pieces[i], { signal: ctrl.signal }).then((r) => ((charged += r.chargedMsub ?? 0), r.blob));
        let next = have ? null : fetchPiece(0);
        next?.catch(() => {});
        if (!have) onState('loading');
        for (let i = 0; i < pieces.length; i++) {
          if (ctrl.signal.aborted) break;
          let blob = blobs[i];
          if (!blob) {
            blob = await next;
            blobs[i] = blob;
            next = i + 1 < pieces.length ? fetchPiece(i + 1) : null;
            next?.catch(() => {});
          }
          if (ctrl.signal.aborted) break;
          onState('playing');
          playing = speaker.play(blob);
          await playing.done;
          playing = null;
        }
        if (!have && blobs.length === pieces.length && blobs.every(Boolean)) remember(key, blobs);
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
