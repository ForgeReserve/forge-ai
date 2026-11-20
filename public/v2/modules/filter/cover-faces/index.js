// Share unseen, second filter: finds faces on the phone and covers each with a flat ellipse (boxes.js).
// The detector is YuNet (MIT, from the OpenCV Zoo), made for small faces: about 10 of its pixels across
// and up. Its model (about 100 KB, public/vendor/yunet/) runs on TensorFlow.js (Apache-2.0), which the
// vendored face-api bundles (public/vendor/face-api); yunet.js runs it. Both are loaded from this app's own
// address when a photo is first checked; nothing is fetched from anyone else, and the photo never leaves
// the page. It looks at the whole photo and then in overlapping tiles, enlarged for a small photo, so a
// face in the back of a crowd is seen. It can miss faces (turned away, hidden, in deep shadow); the person
// sees every block before anything is shared and can add more.
// Handed only t (core/registry.js). It sees the photo being shared, never chats or the wallet.
import { faceCover, keepFaces, MAYBE_SCORE, maybeFaces, passes } from './boxes.js';
import { detectYunet, loadYunet } from './yunet.js';

const LIB = new URL('../../../../vendor/face-api/face-api.js', import.meta.url).href;
const MODEL = new URL('../../../../vendor/yunet/', import.meta.url).href;

let loading = null;

/**
 * Loads the detector once: TensorFlow.js on the graphics chip when it works, else the plain processor,
 * and the model. The model's address is built with new URL and handed to fetch whole: in the iPhone app
 * (served from capacitor://localhost) a library that rebuilds addresses keeps only http and https ones,
 * and face-api's loadFromUri asked for capacitor:/localhost/... so the face check never ran.
 */
function load() {
  loading ??= (async () => {
    const api = await import(LIB);
    const tf = api.tf;
    let gpu = false;
    try {
      gpu = await tf.setBackend('webgl');
    } catch {
      gpu = false;
    }
    if (!gpu) await tf.setBackend('cpu');
    await tf.ready();
    return { tf, gpu, net: await loadYunet(tf, MODEL) };
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** The part p of the photo's canvas, drawn at p.scale, as its own canvas. */
function part(canvas, p) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(p.w * p.scale));
  c.height = Math.max(1, Math.round(p.h * p.scale));
  c.getContext('2d').drawImage(canvas, p.x, p.y, p.w, p.h, 0, 0, c.width, c.height);
  return c;
}

export function create() {
  return {
    id: 'cover-faces',
    what: 'faces',
    /** Starts loading the detector early (when the photo screen opens), so the check is quicker. */
    prepare: () => load().then(() => undefined),
    async analyse(photo) {
      const { tf, gpu, net } = await load();
      const dets = [];
      // On the plain processor (no graphics chip to use) the tiles are at the photo's own size: half the work.
      for (const p of passes(photo.width, photo.height, gpu ? undefined : 0)) {
        const c = part(photo.canvas, p);
        const sx = p.w / c.width;
        const sy = p.h / c.height;
        for (const d of await detectYunet(tf, net, c, MAYBE_SCORE)) dets.push({ x: p.x + d.x * sx, y: p.y + d.y * sy, w: d.w * sx, h: d.h * sy, score: d.score });
      }
      const faces = keepFaces(dets);
      const cover = (d) => faceCover(d, photo.width, photo.height);
      return { covers: faces.map(cover), maybe: maybeFaces(dets, faces).map(cover) };
    },
  };
}
