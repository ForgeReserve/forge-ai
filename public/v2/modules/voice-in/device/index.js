// Voice in through the browser's own speech recogniser, where the browser has one and the person
// chooses it. The browser decides where the sound goes (Chrome sends it to Google), so this is never
// private and is not offered while Private only is on. Free: the engine is not used.
// Handed only t and the recogniser adapter (core/registry.js).
export function create({ recognizer }) {
  return {
    id: 'device',
    available: () => recognizer.available(),
    private: () => false,
    price: () => null,
    maxSeconds: () => 60,
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
