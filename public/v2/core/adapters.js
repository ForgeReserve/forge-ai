// Small adapters for the phone's hardware, so tests can put a fake in their place. Only the camera is
// used in this release (scanning an eCash code); the microphone and NFC come with later slices.
import { loadScript } from '../../js/ui.js';

const defaults = {
  camera: {
    available: () => typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia,
    /** Starts reading QR codes (single or animated) from the camera into `video`. Returns {promise, stop}. */
    async open(video, onProgress = () => {}) {
      await loadScript('/js/scan.js');
      return window.ForgeScan.scan(video, onProgress);
    },
  },
};

const current = { ...defaults };

export const adapters = current;

/** Replaces an adapter (tests). */
export function setAdapter(name, impl) {
  if (!(name in defaults)) throw new Error(`unknown adapter ${name}`);
  current[name] = impl;
}
