// YuNet, the face detector the face filter runs (MIT, from the OpenCV Zoo), on the TensorFlow.js that
// face-api bundles. scripts/yunet-model.ts turns its ONNX file into public/vendor/yunet/: yunet.json lists
// the layers (convolutions, pools, upsamplings, additions) and yunet.bin holds the weights. This file runs
// those layers on one picture and decodes what the three heads say, as OpenCV's FaceDetectorYN does.

/**
 * Loads the model from the folder at `base`: the layer list, then the weights, by fetch with the address
 * whole (see loadModel in index.js for why it is never rebuilt).
 */
export async function loadYunet(tf, base) {
  const res = await fetch(new URL('yunet.json', base));
  if (!res.ok) throw new Error(`face model: ${res.status}`);
  const model = await res.json();
  const w = await tf.io.loadWeights(model.weights, base);
  // When each tensor is read for the last time, so it is let go of then: a large picture's first layers
  // hold tens of megabytes each.
  const last = new Map();
  model.ops.forEach((o, i) => (o.op === 'add' ? [o.a, o.b] : [o.in]).forEach((n) => last.set(n, i)));
  for (const n of Object.values(model.heads).flat()) last.set(n, Infinity);
  return { ...model, w, last };
}

/**
 * The faces YuNet finds in `canvas` (any size; the sides are padded to a multiple of 32), as boxes in the
 * canvas's pixels with a score from 0 to 1, at `minScore` or above.
 */
export async function detectYunet(tf, net, canvas, minScore) {
  const W = canvas.width;
  const H = canvas.height;
  const PW = Math.ceil(W / 32) * 32;
  const PH = Math.ceil(H / 32) * 32;
  const t = new Map();
  t.set('input', tf.tidy(() => tf.browser.fromPixels(canvas).toFloat().pad([[0, PH - H], [0, PW - W], [0, 0]]).expandDims(0)));
  net.ops.forEach((o, i) => {
    const y = tf.tidy(() => {
      if (o.op === 'conv') {
        const x = t.get(o.in);
        const c = (o.dw ? tf.depthwiseConv2d(x, net.w[o.w], o.s, o.p) : tf.conv2d(x, net.w[o.w], o.s, o.p)).add(net.w[o.b]);
        return o.relu ? c.relu() : c;
      }
      if (o.op === 'pool') return tf.maxPool(t.get(o.in), 2, 2, 'valid');
      if (o.op === 'up') {
        const [, h, w] = t.get(o.in).shape;
        return tf.image.resizeNearestNeighbor(t.get(o.in), [2 * h, 2 * w]);
      }
      return tf.add(t.get(o.a), t.get(o.b));
    });
    t.set(o.out, y);
    for (const n of o.op === 'add' ? [o.a, o.b] : [o.in])
      if (net.last.get(n) === i) {
        t.get(n).dispose();
        t.delete(n);
      }
  });
  const read = (names) => Promise.all(names.map((n) => t.get(n).data()));
  const [cls, obj, bbox] = await Promise.all([read(net.heads.cls), read(net.heads.obj), read(net.heads.bbox)]);
  for (const v of t.values()) v.dispose();
  const sigmoid = (v) => 1 / (1 + Math.exp(-v));
  const out = [];
  net.strides.forEach((s, l) => {
    const cols = PW / s;
    const rows = PH / s;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(sigmoid(cls[l][i]) * sigmoid(obj[l][i]));
        if (score < minScore) continue;
        const b = bbox[l];
        const cx = (c + b[4 * i]) * s;
        const cy = (r + b[4 * i + 1]) * s;
        const w = Math.exp(b[4 * i + 2]) * s;
        const h = Math.exp(b[4 * i + 3]) * s;
        out.push({ x: cx - w / 2, y: cy - h / 2, w, h, score });
      }
  });
  return out;
}
