/**
 * Makes the face filter's model files (public/vendor/yunet/) from YuNet, the face detector in the OpenCV
 * Zoo (MIT): its ONNX file, pinned here by commit and SHA-256, is read and written out as weights that
 * TensorFlow.js loads (the TensorFlow.js face-api already bundles), with the list of layers the filter runs
 * them through (cover-faces/yunet.js). No ONNX runtime is shipped; nothing is fetched by the app.
 *
 *   node scripts/yunet-model.ts            download the ONNX file into .tmp/, check it, write the files
 *   node scripts/yunet-model.ts --check    check that the committed files are what this script writes
 *
 * The network is a fixed chain of convolutions, so the layers are read straight from the ONNX graph:
 * each convolution with the ReLU after it, 2x2 max pools, the two 2x upsamplings and additions of the
 * feature pyramid, and the class, objectness and box heads at strides 8, 16 and 32. The landmark heads are
 * left out (the filter does not use them), and so are the final transposes and reshapes, which the filter
 * does in its own decoding. Weights move from ONNX's (out, in, h, w) to TensorFlow's (h, w, in, out), the
 * first layer's colour order from BGR to RGB, grouped convolutions become ordinary ones with zeros, and
 * every weight is stored as a 16-bit float, which halves the download.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'public', 'vendor', 'yunet');
const COMMIT = 'eb9f4f2d4b79b58e5513b5d25d5f0243a8357bf4';
export const SOURCE = {
  name: 'face_detection_yunet_2023mar.onnx',
  repo: 'https://github.com/opencv/opencv_zoo',
  commit: COMMIT,
  url: `https://media.githubusercontent.com/media/opencv/opencv_zoo/${COMMIT}/models/face_detection_yunet/face_detection_yunet_2023mar.onnx`,
  size: 232589,
  sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
  license: 'MIT',
};
const STAGE = join(ROOT, '.tmp', 'yunet', SOURCE.name);

// ---------------------------------------------------------------- a small protobuf reader, for ONNX

type Field = [number, number, bigint | Uint8Array | number];

function* fields(buf: Uint8Array): Generator<Field> {
  let p = 0;
  const varint = () => {
    let r = 0n;
    let s = 0n;
    for (;;) {
      const b = buf[p++]!;
      r |= BigInt(b & 0x7f) << s;
      if (!(b & 0x80)) return r;
      s += 7n;
    }
  };
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (p < buf.length) {
    const key = Number(varint());
    const f = key >> 3;
    const wt = key & 7;
    if (wt === 0) yield [f, wt, varint()];
    else if (wt === 2) {
      const n = Number(varint());
      yield [f, wt, buf.subarray(p, (p += n))];
    } else if (wt === 5) yield [f, wt, view.getFloat32((p += 4) - 4, true)];
    else if (wt === 1) yield [f, wt, view.getFloat64((p += 8) - 8, true)];
    else throw new Error(`protobuf wire type ${wt}`);
  }
}

const text = (v: Field[2]) => new TextDecoder().decode(v as Uint8Array);
const int = (v: Field[2]) => Number(BigInt.asIntN(64, v as bigint));
function ints(v: Field[2], wt: number): number[] {
  if (wt !== 2) return [int(v)];
  const out: number[] = [];
  const b = v as Uint8Array;
  for (let i = 0; i < b.length; ) {
    let x = 0n;
    let s = 0n;
    for (;;) {
      const c = b[i++]!;
      x |= BigInt(c & 0x7f) << s;
      if (!(c & 0x80)) break;
      s += 7n;
    }
    out.push(Number(BigInt.asIntN(64, x)));
  }
  return out;
}

interface Tensor {
  name: string;
  dims: number[];
  data: Float32Array;
}
interface Node {
  op: string;
  inputs: string[];
  outputs: string[];
  attrs: Record<string, number[]>;
}

function tensor(buf: Uint8Array): Tensor {
  const t: Tensor = { name: '', dims: [], data: new Float32Array(0) };
  let type = 0;
  for (const [f, wt, v] of fields(buf)) {
    if (f === 1) t.dims.push(...ints(v, wt));
    else if (f === 2) type = int(v);
    else if (f === 8) t.name = text(v);
    else if (f === 9) {
      const raw = Uint8Array.from(v as Uint8Array); // a copy that starts the buffer (a Buffer's slice would share it)
      t.data = new Float32Array(raw.buffer, 0, raw.byteLength / 4);
    }
  }
  if (type !== 1) t.data = new Float32Array(0); // not float: shapes and scales, which are not needed
  return t;
}

function node(buf: Uint8Array): Node {
  const n: Node = { op: '', inputs: [], outputs: [], attrs: {} };
  for (const [f, , v] of fields(buf)) {
    if (f === 1) n.inputs.push(text(v));
    else if (f === 2) n.outputs.push(text(v));
    else if (f === 4) n.op = text(v);
    else if (f === 5) {
      let name = '';
      const vals: number[] = [];
      for (const [af, awt, av] of fields(v as Uint8Array)) {
        if (af === 1) name = text(av);
        else if (af === 3 || af === 8) vals.push(...ints(av, awt));
      }
      n.attrs[name] = vals;
    }
  }
  return n;
}

/** The graph's nodes in order and its float initializers by name. */
export function readOnnx(bytes: Uint8Array) {
  const nodes: Node[] = [];
  const inits = new Map<string, Tensor>();
  for (const [f, , v] of fields(bytes)) {
    if (f !== 7) continue;
    for (const [gf, , gv] of fields(v as Uint8Array)) {
      if (gf === 1) nodes.push(node(gv as Uint8Array));
      else if (gf === 5) {
        const t = tensor(gv as Uint8Array);
        inits.set(t.name, t);
      }
    }
  }
  return { nodes, inits };
}

// ---------------------------------------------------------------- the layers

export type Op =
  | { op: 'conv'; in: string; out: string; w: string; b: string; k: number; s: number; p: number; dw: boolean; relu: boolean }
  | { op: 'pool'; in: string; out: string }
  | { op: 'up'; in: string; out: string }
  | { op: 'add'; a: string; b: string; out: string };

/** The 16-bit float nearest to x (round half to even), as its bits. */
export function half(x: number): number {
  const f = new Float32Array([x]);
  const u = new Uint32Array(f.buffer)[0]!;
  const sign = (u >>> 16) & 0x8000;
  const exp = (u >>> 23) & 0xff;
  let man = u & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (man ? 0x200 : 0);
  let e = exp - 127 + 15;
  if (e >= 0x1f) return sign | 0x7c00;
  if (e <= 0) {
    if (e < -10) return sign;
    man |= 0x800000;
    const shift = 14 - e;
    let h = man >> shift;
    const rest = man & ((1 << shift) - 1);
    const mid = 1 << (shift - 1);
    if (rest > mid || (rest === mid && h & 1)) h++;
    return sign | h;
  }
  let h = (e << 10) | (man >> 13);
  const rest = man & 0x1fff;
  if (rest > 0x1000 || (rest === 0x1000 && h & 1)) h++;
  return sign | h;
}

/**
 * The layers and weights for TensorFlow.js from YuNet's ONNX graph. Heads: for each of cls, obj and
 * bbox, the tensor names at strides 8, 16 and 32, before the sigmoid (cls, obj) the graph applies after.
 */
export function convert(bytes: Uint8Array) {
  const { nodes, inits } = readOnnx(bytes);
  const ops: Op[] = [];
  const weights: { name: string; shape: number[]; data: Float32Array }[] = [];
  const heads: Record<'cls' | 'obj' | 'bbox', string[]> = { cls: [], obj: [], bbox: [] };
  const producer = new Map<string, Node>();
  for (const n of nodes) for (const o of n.outputs) producer.set(o, n);
  const consumers = (name: string) => nodes.filter((n) => n.inputs.includes(name));
  const relu = new Map<string, string>(); // a conv's output -> the ReLU's output, when a ReLU is all that reads it
  for (const n of nodes) if (n.op === 'Relu' && consumers(n.inputs[0]!).length === 1) relu.set(n.inputs[0]!, n.outputs[0]!);
  // What each graph output (cls_8, ...) is computed from: back through Sigmoid, Reshape and Transpose.
  const outputs = new Map<string, string>();
  for (const n of nodes) {
    let name = n.outputs[0]!;
    const out = /^(cls|obj|bbox)_(8|16|32)$/.exec(name);
    if (!out) continue;
    let p = producer.get(name);
    while (p && ['Sigmoid', 'Reshape', 'Transpose'].includes(p.op)) {
      name = p.inputs[0]!;
      p = producer.get(name);
    }
    outputs.set(name, `${out[1]}_${out[2]}`);
  }
  // Only the layers the three heads need.
  const needed = new Set<string>();
  const want = (name: string) => {
    if (needed.has(name)) return;
    needed.add(name);
    const p = producer.get(name);
    if (p) for (const i of p.inputs) want(i);
  };
  for (const o of outputs.keys()) want(o);

  let w = 0;
  const firstConv = nodes.find((n) => n.op === 'Conv')!;
  for (const n of nodes) {
    const out = n.outputs[0]!;
    if (n.op === 'Conv') {
      const fused = relu.get(out);
      if (!needed.has(out) && !(fused && needed.has(fused))) continue;
      const W = inits.get(n.inputs[1]!)!;
      const B = inits.get(n.inputs[2]!)!;
      const [O, Ig, kh, kw] = W.dims as [number, number, number, number];
      const g = n.attrs.group?.[0] ?? 1;
      const I = Ig * g;
      const stride = n.attrs.strides?.[0] ?? 1;
      const pads = n.attrs.pads ?? [0, 0, 0, 0];
      if (kh !== kw || new Set(pads).size !== 1 || (n.attrs.strides ?? [1, 1])[0] !== (n.attrs.strides ?? [1, 1])[1] || (n.attrs.dilations ?? [1]).some((d) => d !== 1)) throw new Error(`unexpected convolution ${out}`);
      const dw = g > 1 && g === I && g === O;
      const data = new Float32Array(dw ? kh * kw * I : kh * kw * I * O);
      for (let o = 0; o < O; o++)
        for (let ig = 0; ig < Ig; ig++)
          for (let y = 0; y < kh; y++)
            for (let x = 0; x < kw; x++) {
              const v = W.data[((o * Ig + ig) * kh + y) * kw + x]!;
              if (dw) data[(y * kw + x) * I + o] = v;
              else {
                // Grouped: input channel ig of o's group. The first layer's colours turn from BGR to RGB.
                let i = Math.floor(o / (O / g)) * Ig + ig;
                if (n === firstConv) i = 2 - i;
                data[((y * kw + x) * I + i) * O + o] = v;
              }
            }
      const wn = `w${w}`;
      const bn = `b${w++}`;
      weights.push({ name: wn, shape: dw ? [kh, kw, I, 1] : [kh, kw, I, O], data }, { name: bn, shape: [O], data: B.data.slice() });
      ops.push({ op: 'conv', in: n.inputs[0]!, out: fused ?? out, w: wn, b: bn, k: kh, s: stride, p: pads[0]!, dw, relu: !!fused });
    } else if (n.op === 'MaxPool' && needed.has(out)) {
      if ((n.attrs.kernel_shape ?? []).join() !== '2,2' || (n.attrs.strides ?? []).join() !== '2,2' || (n.attrs.pads ?? [0]).some((p) => p)) throw new Error(`unexpected pool ${out}`);
      ops.push({ op: 'pool', in: n.inputs[0]!, out });
    } else if (n.op === 'Resize' && needed.has(out)) ops.push({ op: 'up', in: n.inputs[0]!, out });
    else if (n.op === 'Add' && needed.has(out)) ops.push({ op: 'add', a: n.inputs[0]!, b: n.inputs[1]!, out });
    else if (n.op === 'Relu' && needed.has(out) && !relu.has(n.inputs[0]!)) throw new Error(`unfused ReLU ${out}`);
  }
  // Short names: t0, t1, ... in the order they are made; the photo is 'input'.
  const names = new Map<string, string>([['input', 'input']]);
  const short = (s: string) => names.get(s) ?? (names.set(s, `t${names.size - 1}`), names.get(s)!);
  for (const o of ops) {
    if (o.op === 'add') Object.assign(o, { a: short(o.a), b: short(o.b), out: short(o.out) });
    else Object.assign(o, { in: short(o.in), out: short(o.out) });
  }
  for (const [name, head] of outputs) {
    const [kind, stride] = head.split('_') as ['cls' | 'obj' | 'bbox', string];
    heads[kind][[8, 16, 32].indexOf(Number(stride))] = short(name);
  }
  return { ops, heads, weights };
}

/** The model files: yunet.json (layers, heads and the weights manifest) and yunet.bin (16-bit floats). */
export function modelFiles(bytes: Uint8Array) {
  const { ops, heads, weights } = convert(bytes);
  const n = weights.reduce((s, w) => s + w.data.length, 0);
  const bin = new Uint16Array(n);
  let at = 0;
  for (const w of weights) for (const v of w.data) bin[at++] = half(v);
  const json = {
    about: `YuNet face detector (MIT), from ${SOURCE.repo} at ${SOURCE.commit}, models/face_detection_yunet/${SOURCE.name} (SHA-256 ${SOURCE.sha256}), converted by scripts/yunet-model.ts. Input: RGB, 0 to 255, sides a multiple of 32. Heads at strides 8, 16 and 32; cls and obj before their sigmoid.`,
    strides: [8, 16, 32],
    ops,
    heads,
    weights: [{ paths: ['yunet.bin'], weights: weights.map((w) => ({ name: w.name, shape: w.shape, dtype: 'float32', quantization: { dtype: 'float16' } })) }],
  };
  return { json: `${JSON.stringify(json, null, 1)}\n`, bin: new Uint8Array(bin.buffer) };
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function source(): Promise<Uint8Array> {
  if (existsSync(STAGE)) {
    const b = readFileSync(STAGE);
    if (sha256(b) === SOURCE.sha256) return b;
  }
  const res = await fetch(SOURCE.url);
  if (!res.ok) throw new Error(`${SOURCE.url}: ${res.status}`);
  const b = new Uint8Array(await res.arrayBuffer());
  if (b.length !== SOURCE.size || sha256(b) !== SOURCE.sha256) throw new Error(`${SOURCE.name}: size or SHA-256 differs from the pin`);
  mkdirSync(dirname(STAGE), { recursive: true });
  writeFileSync(STAGE, b);
  return b;
}

async function main(check: boolean) {
  const { json, bin } = modelFiles(await source());
  if (check) {
    const same = (f: string, b: Uint8Array | string) => existsSync(join(OUT, f)) && Buffer.from(readFileSync(join(OUT, f))).equals(Buffer.from(b));
    if (!same('yunet.json', json) || !same('yunet.bin', bin)) throw new Error('public/vendor/yunet differs from what scripts/yunet-model.ts writes');
    console.log('public/vendor/yunet matches the pinned YuNet model');
    return;
  }
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 'yunet.json'), json);
  writeFileSync(join(OUT, 'yunet.bin'), bin);
  console.log(`wrote public/vendor/yunet: yunet.json ${json.length} bytes, yunet.bin ${bin.length} bytes`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main(process.argv.includes('--check'));
