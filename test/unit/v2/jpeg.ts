// A small JPEG decoder for the unit tests, which run in Node and have no image decoder: enough to read
// the sample photos into RGBA. Baseline and extended Huffman frames only (no progressive), any colour
// sampling, restart markers. Colour is enlarged by repeating samples, where a browser smooths it, so the
// pixels differ from a browser's by a little; the tests use them as a picture, not as the browser's copy.

const ZIGZAG = [0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63];

interface Huff {
  maxcode: Int32Array;
  valptr: Int32Array;
  mincode: Int32Array;
  syms: number[];
}

interface Comp {
  id: number;
  h: number;
  v: number;
  tq: number;
  td: number;
  ta: number;
  bw: number;
  bh: number;
  plane: Uint8ClampedArray;
  pred: number;
}

function huffman(counts: number[], syms: number[]): Huff {
  const maxcode = new Int32Array(17).fill(-1);
  const valptr = new Int32Array(17);
  const mincode = new Int32Array(17);
  let code = 0;
  let k = 0;
  for (let l = 1; l <= 16; l++) {
    valptr[l] = k;
    mincode[l] = code;
    code += counts[l - 1]!;
    k += counts[l - 1]!;
    if (counts[l - 1]) maxcode[l] = code - 1;
    code <<= 1;
  }
  return { maxcode, valptr, mincode, syms };
}

// cos((2x + 1) u pi / 16) times the DCT's scale for u, for the inverse transform.
const IDCT = Array.from({ length: 64 }, (_, i) => {
  const x = i >> 3;
  const u = i & 7;
  return (u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
});

function idct(coef: Float64Array, out: Uint8ClampedArray, stride: number, at: number) {
  const tmp = new Float64Array(64);
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) s += IDCT[x * 8 + u]! * coef[y * 8 + u]!;
      tmp[y * 8 + x] = s / 2;
    }
  for (let x = 0; x < 8; x++)
    for (let y = 0; y < 8; y++) {
      let s = 0;
      for (let v = 0; v < 8; v++) s += IDCT[y * 8 + v]! * tmp[v * 8 + x]!;
      out[at + y * stride + x] = Math.round(s / 2 + 128);
    }
}

export function decodeJpeg(buf: Uint8Array): { width: number; height: number; data: Uint8ClampedArray } {
  const u16 = (o: number) => (buf[o]! << 8) | buf[o + 1]!;
  const quant: Int32Array[] = [];
  const dcs: Huff[] = [];
  const acs: Huff[] = [];
  let comps: Comp[] = [];
  let width = 0;
  let height = 0;
  let hmax = 1;
  let vmax = 1;
  let restart = 0;
  let p = 2;
  while (p < buf.length) {
    if (buf[p] !== 0xff) throw new Error(`not a marker at ${p}`);
    const m = buf[p + 1]!;
    if (m === 0xd9) break;
    const len = u16(p + 2);
    const s = p + 4;
    const e = p + 2 + len;
    if (m === 0xdb) {
      for (let o = s; o < e; ) {
        const wide = buf[o]! >> 4;
        const t = new Int32Array(64);
        for (let i = 0; i < 64; i++) t[i] = wide ? u16(o + 1 + 2 * i) : buf[o + 1 + i]!;
        quant[buf[o]! & 15] = t;
        o += 1 + (wide ? 128 : 64);
      }
    } else if (m === 0xc4) {
      for (let o = s; o < e; ) {
        const counts = [...buf.subarray(o + 1, o + 17)];
        const n = counts.reduce((a, b) => a + b, 0);
        const table = huffman(counts, [...buf.subarray(o + 17, o + 17 + n)]);
        (buf[o]! >> 4 ? acs : dcs)[buf[o]! & 15] = table;
        o += 17 + n;
      }
    } else if (m === 0xc0 || m === 0xc1) {
      height = u16(s + 1);
      width = u16(s + 3);
      comps = Array.from({ length: buf[s + 5]! }, (_, i) => {
        const o = s + 6 + 3 * i;
        return { id: buf[o]!, h: buf[o + 1]! >> 4, v: buf[o + 1]! & 15, tq: buf[o + 2]!, td: 0, ta: 0, bw: 0, bh: 0, plane: new Uint8ClampedArray(0), pred: 0 };
      });
      hmax = Math.max(...comps.map((c) => c.h));
      vmax = Math.max(...comps.map((c) => c.v));
    } else if (m >= 0xc2 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      throw new Error(`unsupported JPEG frame 0x${m.toString(16)}`);
    } else if (m === 0xdd) {
      restart = u16(s);
    } else if (m === 0xda) {
      const n = buf[s]!;
      if (n !== comps.length) throw new Error('only interleaved scans');
      for (let i = 0; i < n; i++) {
        const c = comps.find((x) => x.id === buf[s + 1 + 2 * i])!;
        c.td = buf[s + 2 + 2 * i]! >> 4;
        c.ta = buf[s + 2 + 2 * i]! & 15;
      }
      p = scan(e);
      continue;
    }
    p = e;
  }

  function scan(start: number): number {
    const mx = Math.ceil(width / (8 * hmax));
    const my = Math.ceil(height / (8 * vmax));
    for (const c of comps) {
      c.bw = mx * c.h * 8;
      c.bh = my * c.v * 8;
      c.plane = new Uint8ClampedArray(c.bw * c.bh);
      c.pred = 0;
    }
    let o = start;
    let bits = 0;
    let nbits = 0;
    const bit = () => {
      if (!nbits) {
        bits = buf[o++]!;
        if (bits === 0xff) {
          const next = buf[o]!;
          if (next === 0) o++;
          else if (next < 0xd0 || next > 0xd7) throw new Error('marker inside the scan');
        }
        nbits = 8;
      }
      nbits--;
      return (bits >> nbits) & 1;
    };
    const receive = (n: number) => {
      let v = 0;
      for (let i = 0; i < n; i++) v = (v << 1) | bit();
      return v;
    };
    const extend = (v: number, n: number) => (n && v < 1 << (n - 1) ? v - (1 << n) + 1 : v);
    const decode = (t: Huff) => {
      let code = 0;
      for (let l = 1; l <= 16; l++) {
        code = (code << 1) | bit();
        if (code <= t.maxcode[l]!) return t.syms[t.valptr[l]! + code - t.mincode[l]!]!;
      }
      throw new Error('bad Huffman code');
    };
    const coef = new Float64Array(64);
    const block = (c: Comp, at: number) => {
      coef.fill(0);
      const q = quant[c.tq]!;
      const t = decode(dcs[c.td]!);
      c.pred += t ? extend(receive(t), t) : 0;
      coef[0] = c.pred * q[0]!;
      for (let k = 1; k < 64; ) {
        const rs = decode(acs[c.ta]!);
        const r = rs >> 4;
        const z = rs & 15;
        if (!z) {
          if (r !== 15) break;
          k += 16;
          continue;
        }
        k += r;
        coef[ZIGZAG[k]!] = extend(receive(z), z) * q[k]!;
        k++;
      }
      idct(coef, c.plane, c.bw, at);
    };
    for (let i = 0; i < mx * my; i++) {
      if (restart && i && i % restart === 0) {
        // Restart: drop the bits left in the byte, step over the marker, start the predictions again.
        nbits = 0;
        while (o < buf.length && !(buf[o] === 0xff && buf[o + 1]! >= 0xd0 && buf[o + 1]! <= 0xd7)) o++;
        o += 2;
        for (const c of comps) c.pred = 0;
      }
      const bx = i % mx;
      const by = (i - bx) / mx;
      for (const c of comps)
        for (let v = 0; v < c.v; v++) for (let h = 0; h < c.h; h++) block(c, ((by * c.v + v) * 8) * c.bw + (bx * c.h + h) * 8);
    }
    while (o < buf.length && !(buf[o] === 0xff && buf[o + 1] !== 0 && (buf[o + 1]! < 0xd0 || buf[o + 1]! > 0xd7))) o++;
    return o;
  }

  const data = new Uint8ClampedArray(width * height * 4);
  const sample = (c: Comp, x: number, y: number) => c.plane[Math.floor((y * c.v) / vmax) * c.bw + Math.floor((x * c.h) / hmax)]!;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const Y = sample(comps[0]!, x, y);
      if (comps.length === 1) data.set([Y, Y, Y, 255], i);
      else {
        const cb = sample(comps[1]!, x, y) - 128;
        const cr = sample(comps[2]!, x, y) - 128;
        data[i] = Y + 1.402 * cr;
        data[i + 1] = Y - 0.344136 * cb - 0.714136 * cr;
        data[i + 2] = Y + 1.772 * cb;
        data[i + 3] = 255;
      }
    }
  return { width, height, data };
}
