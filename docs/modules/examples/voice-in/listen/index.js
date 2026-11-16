// A voice-in module: the browser's own speech recogniser (the recognizer input). It costs nothing. The
// browser decides where the sound goes (Chrome sends it to Google), so private() is false and the app
// does not use it while Private only is on.
export function create({ recognizer }) {
  return {
    id: 'listen',
    available: () => recognizer.available(),
    private: () => false,
    price: () => 0,
    maxSeconds: () => 30,
    async start({ onText = () => {} } = {}) {
      const r = await recognizer.start({ lang: 'en', onText });
      return {
        async finish() {
          return { text: await r.stop(), chargedMsub: 0, balanceMsub: null };
        },
        cancel: () => r.cancel(),
      };
    },
  };
}
