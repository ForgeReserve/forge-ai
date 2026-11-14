// Voice out with the phone's own voices (speechSynthesis), only voices that run on the phone, so the
// answer is not sent anywhere. Free. Handed only t and the voices adapter (core/registry.js).
export function create({ synth }) {
  return {
    id: 'device',
    available: () => synth.voices('en').length > 0,
    private: () => true,
    pieceSize: () => 300,
    cached: () => true,
    price: () => 0,
    speak(pieces, { onState = () => {} } = {}) {
      let current = null;
      let stopped = false;
      const done = (async () => {
        for (const p of pieces) {
          if (stopped) break;
          onState('playing');
          current = synth.speak(p, 'en');
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
