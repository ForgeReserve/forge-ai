// Voice out with the natural voice made on the phone (Phonon 31m, core/phonon.js). The answer is read
// by a model running in this page; the text is never sent anywhere. Free. The sound streams to the
// speaker in 80 ms pieces as the model makes them, so reading starts before the sentence is done.
// Handed only t, the speaker adapter and the phone's Phonon engine (core/registry.js).
const PIECE = 1500;

const aborted = () => Object.assign(new Error('stopped'), { name: 'AbortError' });
const blocked = () => Object.assign(new Error('the sound is blocked until a tap'), { name: 'AudioBlocked' });

export function create({ speaker, phonon }) {
  return {
    id: 'phonon',
    available: () => !!phonon?.available(),
    private: () => true,
    pieceSize: () => PIECE,
    cached: () => true,
    price: () => 0,
    /** {needed, bytes}: whether the first use downloads the model, and how much. */
    download: () => phonon.download(),
    speak(pieces, { onState = () => {}, onProgress = () => {} } = {}) {
      const ctrl = new AbortController();
      let out = null;
      const done = (async () => {
        onState('loading');
        // {loaded, total, fraction, phase}: bytes of the whole load (the model and the voice), then
        // 'ready' once they are all here and the model is being set up.
        let last = { loaded: 0, total: 0, fraction: 0 };
        const tts = await phonon.load({
          onMeter: (m) => {
            last = m;
            onProgress({ ...m, phase: m.fraction >= 1 ? 'ready' : 'download' });
          },
        });
        if (ctrl.signal.aborted) throw aborted();
        onProgress({ ...last, fraction: 1, phase: 'ready' });
        for (const piece of pieces) {
          const stream = tts.stream(piece, { signal: ctrl.signal });
          for await (const pcm of stream) {
            if (ctrl.signal.aborted) break;
            if (!out) {
              // On iPhone the sound only starts if a tap unlocked it (speaker.unlock). When it did not,
              // say so rather than play into silence.
              if (speaker.ready && !(await speaker.ready(1500))) throw blocked();
              out = speaker.stream({ sampleRate: tts.sampleRate });
              onState('playing');
            }
            out.push(pcm);
          }
          if (ctrl.signal.aborted) throw aborted();
        }
        if (out) {
          out.end();
          await out.done;
        }
        return { chargedMsub: 0 };
      })();
      return {
        done,
        stop() {
          ctrl.abort();
          out?.stop();
        },
      };
    },
  };
}
