// Finds places in a photo that look like a line of writing: a number plate, a sign, a page, a name tag.
// Plain JavaScript on the photo's pixels, no model file and no network, so it runs on a low-end phone
// in well under a second (a 1024 px picture is a few million simple steps).
//
// How: the picture is made grey and smaller (at most 1024 px on its long side). Each pixel is compared
// with the average around it, which picks out marks darker or lighter than their background (letters on
// a sign, digits on a plate). Each connected mark that is shaped like a letter becomes a candidate.
// Candidates of a similar height and shade that sit side by side on one line are joined. A line of three
// or more is taken as writing and covered, with a margin.
//
// What it misses: very small or blurred writing, handwriting that joins up, and writing on a slant
// steeper than about 20 degrees. What it can cover that is not writing: rows of similar marks, such as
// a fence or a row of windows. The person sees every block and can take one away or add their own.

/** Pixels on the long side the search works at. */
export const WORK_SIDE = 1024;

/**
 * Lines of writing in an RGBA image ({width, height, data}). Returns boxes in the image's own pixels,
 * {x, y, w, h, chars}, with a margin, joined where they overlap.
 */
export function findWriting(img, opts = {}) {
  const { width, height, data } = img;
  if (!width || !height) return [];
  const s = Math.min(1, (opts.workSide ?? WORK_SIDE) / Math.max(width, height));
  const W = Math.max(1, Math.round(width * s));
  const H = Math.max(1, Math.round(height * s));
  const grey = shrinkGrey(data, width, height, W, H, s);
  const chars = candidates(grey, W, H, opts);
  const lines = joinLines(chars, W);
  const out = [];
  for (const line of lines) {
    const pad = 0.35 * line.med;
    out.push({ x: (line.x0 - pad) / s, y: (line.y0 - pad) / s, w: (line.x1 - line.x0 + 1 + 2 * pad) / s, h: (line.y1 - line.y0 + 1 + 2 * pad) / s, chars: line.n });
  }
  return mergeOverlapping(out.map((b) => clamp(b, width, height)));
}

/** Grey levels at W x H, each the average of the source pixels that fall in it. */
function shrinkGrey(data, width, height, W, H, s) {
  const sum = new Float32Array(W * H);
  const cnt = new Uint32Array(W * H);
  for (let y = 0; y < height; y++) {
    const ty = Math.min(H - 1, Math.floor(y * s)) * W;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const t = ty + Math.min(W - 1, Math.floor(x * s));
      sum[t] += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      cnt[t]++;
    }
  }
  for (let i = 0; i < W * H; i++) sum[i] = cnt[i] ? sum[i] / cnt[i] : 0;
  return sum;
}

/** Marks shaped like letters: connected pixels clearly darker, or clearly lighter, than around them. */
function candidates(g, W, H, opts) {
  const r = opts.radius ?? Math.max(7, Math.round(Math.max(W, H) / 40));
  const C = opts.contrast ?? 12;
  // Local averages from an integral image.
  const I = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) {
    let row = 0;
    for (let x = 0; x < W; x++) {
      row += g[y * W + x];
      I[(y + 1) * (W + 1) + x + 1] = I[y * (W + 1) + x + 1] + row;
    }
  }
  const mark = new Uint8Array(W * H); // 1 darker, 2 lighter
  for (let y = 0; y < H; y++) {
    const ay = Math.max(0, y - r);
    const by = Math.min(H, y + r + 1);
    for (let x = 0; x < W; x++) {
      const ax = Math.max(0, x - r);
      const bx = Math.min(W, x + r + 1);
      const m = (I[by * (W + 1) + bx] - I[ay * (W + 1) + bx] - I[by * (W + 1) + ax] + I[ay * (W + 1) + ax]) / ((bx - ax) * (by - ay));
      const v = g[y * W + x];
      if (v < m - C) mark[y * W + x] = 1;
      else if (v > m + C) mark[y * W + x] = 2;
    }
  }
  const maxH = Math.max(W, H) / 8;
  const seen = new Uint8Array(W * H);
  const stack = new Int32Array(W * H);
  const out = [];
  for (let i = 0; i < W * H; i++) {
    const kind = mark[i];
    if (!kind || seen[i]) continue;
    let top = 0;
    stack[top++] = i;
    seen[i] = 1;
    let x0 = W;
    let y0 = H;
    let x1 = 0;
    let y1 = 0;
    let n = 0;
    let lum = 0;
    while (top) {
      const j = stack[--top];
      const x = j % W;
      const y = (j - x) / W;
      n++;
      lum += g[j];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= W) continue;
          const k = yy * W + xx;
          if (mark[k] === kind && !seen[k]) {
            seen[k] = 1;
            stack[top++] = k;
          }
        }
      }
    }
    const w = x1 - x0 + 1;
    const h = y1 - y0 + 1;
    const fill = n / (w * h);
    if (h >= 6 && h <= maxH && w <= 1.6 * h && fill >= 0.12 && fill <= 0.92 && n >= 10) out.push({ x0, y0, x1, y1, w, h, cy: (y0 + y1) / 2, lum: lum / n });
  }
  return out;
}

/** Candidates joined into lines: similar height and shade, side by side, close together. */
function joinLines(chars, W) {
  chars.sort((a, b) => a.x0 - b.x0);
  const parent = chars.map((_, i) => i);
  const find = (i) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let i = 0; i < chars.length; i++) {
    const a = chars[i];
    for (let j = i + 1; j < chars.length; j++) {
      const b = chars[j];
      const mh = Math.max(a.h, b.h);
      if (b.x0 - a.x1 > 1.6 * mh) {
        if (b.x0 - a.x0 > 4 * mh + W / 20) break;
        continue;
      }
      if (mh / Math.min(a.h, b.h) > 1.5) continue;
      if (Math.abs(a.cy - b.cy) > 0.3 * mh) continue;
      if (Math.abs(a.lum - b.lum) > 40) continue;
      if (b.x0 < a.x0 + 0.3 * a.w && b.x1 <= a.x1) continue; // one inside the other: a letter's hole
      parent[find(i)] = find(j);
    }
  }
  const groups = new Map();
  chars.forEach((c, i) => {
    const k = find(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c);
  });
  const lines = [];
  for (const m of groups.values()) {
    if (m.length < 3) continue;
    // At least two marks as wide as a letter: a row of thin posts is not writing.
    if (m.filter((c) => c.w >= 0.35 * c.h).length < 2) continue;
    const hs = m.map((c) => c.h).sort((a, b) => a - b);
    const med = hs[hs.length >> 1];
    const y0 = Math.min(...m.map((c) => c.y0));
    const y1 = Math.max(...m.map((c) => c.y1));
    // A line is about one letter tall (with room for tails such as g and y).
    if (y1 - y0 + 1 > 2 * med) continue;
    lines.push({ x0: Math.min(...m.map((c) => c.x0)), x1: Math.max(...m.map((c) => c.x1)), y0, y1, med, n: m.length });
  }
  return lines;
}

function clamp(b, W, H) {
  const x = Math.max(0, Math.floor(b.x));
  const y = Math.max(0, Math.floor(b.y));
  return { ...b, x, y, w: Math.max(0, Math.min(W, Math.ceil(b.x + b.w)) - x), h: Math.max(0, Math.min(H, Math.ceil(b.y + b.h)) - y) };
}

function mergeOverlapping(boxes) {
  let list = boxes;
  for (let changed = true; changed; ) {
    changed = false;
    const out = [];
    for (const b of list) {
      const o = out.find((a) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h);
      if (!o) {
        out.push({ ...b });
        continue;
      }
      const x = Math.min(o.x, b.x);
      const y = Math.min(o.y, b.y);
      o.w = Math.max(o.x + o.w, b.x + b.w) - x;
      o.h = Math.max(o.y + o.h, b.y + b.h) - y;
      o.x = x;
      o.y = y;
      o.chars += b.chars;
      changed = true;
    }
    list = out;
  }
  return list;
}
