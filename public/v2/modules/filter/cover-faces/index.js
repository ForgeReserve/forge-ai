// Share unseen, second filter: finds faces on the phone and covers each with a solid block.
// The detector is face-api's tiny face detector (MIT) on TensorFlow.js (Apache-2.0), vendored in
// public/vendor/face-api with its model file (about 190 KB) and licences. Both are loaded from this
// app's own address when a photo is first checked; nothing is fetched from anyone else, and the photo
// never leaves the page. It can miss faces (turned away, very small, hidden in shadow); the person sees
// every block before anything is shared and can add more.
// Handed only t (core/registry.js). It sees the photo being shared, never chats or the wallet.
import { faceCover, INPUT_SIZE, keepFaces, MIN_SCORE, passes } from './boxes.js';

const LIB = new URL('../../../../vendor/face-api/face-api.js', import.meta.url).href;
const MODEL = new URL('../../../../vendor/face-api/model/', import.meta.url).href;
const MANIFEST = 'tiny_face_detector_model-weights_manifest.json';

let loading = null;

/**
 * Loads the model's weights from the folder at `base` into face-api. Not face-api's loadFromUri: it
 * rebuilds the address and keeps it whole only for the http and https schemes, so in the iPhone app
 * (served from capacitor://localhost) it asked for capacitor:/localhost/... and the face check never ran.
 */
export async function loadModel(api, base = MODEL) {
  const res = await fetch(new URL(MANIFEST, base));
  if (!res.ok) throw new Error(`face model: ${res.status}`);
  api.nets.tinyFaceDetector.loadFromWeightMap(await api.tf.io.loadWeights(await res.json(), base));
}

/** Loads the detector once: the graphics chip when it works, else the plain processor. */
function load() {
  loading ??= (async () => {
    const api = await import(LIB);
    let gpu = false;
    try {
      gpu = await api.tf.setBackend('webgl');
    } catch {
      gpu = false;
    }
    if (!gpu) await api.tf.setBackend('cpu');
    await api.tf.ready();
    await loadModel(api);
    return api;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The part p of the photo's canvas, as its own canvas. */
function part(canvas, p) {
  if (p.x === 0 && p.y === 0 && p.w === canvas.width && p.h === canvas.height) return canvas;
  const c = document.createElement('canvas');
  c.width = p.w;
  c.height = p.h;
  c.getContext('2d').drawImage(canvas, p.x, p.y, p.w, p.h, 0, 0, p.w, p.h);
  return c;
}

export function create() {
  return {
    id: 'cover-faces',
    what: 'faces',
    /** Starts loading the detector early (when the photo screen opens), so the check is quicker. */
    prepare: () => load().then(() => undefined),
    async analyse(photo) {
      const api = await load();
      const opts = new api.TinyFaceDetectorOptions({ inputSize: INPUT_SIZE, scoreThreshold: MIN_SCORE });
      const dets = [];
      for (const p of passes(photo.width, photo.height)) {
        const found = await api.detectAllFaces(part(photo.canvas, p), opts);
        for (const d of found) dets.push({ x: d.box.x + p.x, y: d.box.y + p.y, w: d.box.width, h: d.box.height, score: d.score });
      }
      return { covers: keepFaces(dets).map((d) => faceCover(d, photo.width, photo.height)) };
    },
  };
}
