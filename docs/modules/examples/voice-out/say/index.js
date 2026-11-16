// A voice-out module: the phone's own voices (the synth input), one piece of the answer at a time. Only
// voices that run on the phone are used, so the answer is not sent anywhere and it costs nothing.
export function create({ synth }) {
  return {
    id: 'say',
    available: () => synth.voices('en').length > 0,
    private: () => true,
    pieceSize: () => 200,
    price: () => 0,
    speak(pieces, { onState = () => {} } = {}) {
      let stopped = false;
      let current = null;
      const done = (async () => {
        for (const piece of pieces) {
          if (stopped) break;
          onState('playing');
          current = synth.speak(piece, 'en');
          await current.done;
        }
        return { chargedMsub: 0 };
      })();
      return {
        done,
        stop() {
          stopped = true;
          current?.stop();
        },
      };
    },
  };
}
