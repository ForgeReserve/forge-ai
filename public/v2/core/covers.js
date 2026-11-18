// Covers for Share unseen: what is painted over faces, writing and whatever the person covers by hand.
// Pure maths on covers in the photo's own pixels, tested in Node.
//
// A cover is a box {x, y, w, h} or, for a face, an ellipse {shape: 'ellipse', cx, cy, rx, ry}; an
// ellipse's x, y, w and h are its bounds in the photo. Every pixel a cover touches is covered whole, with
// no soft edge that keeps part of what was under it. A cover is never blurred or pixelated (both can be
// undone or matched): it is painted one flat colour, taken from the uncovered pixels just around it, so it
// reads as a smudge and the new file holds nothing of what was under it.

/** The colour a cover takes when no uncovered pixel is near it (the whole photo is covered). */
export const NEUTRAL_FILL = Object.freeze([128, 128, 128]);

/** Uncovered pixels a cover's colour is taken from, at least; with fewer the ring around it widens. */
const MIN_RING = 16;

/** Cover kinds, and the filter that makes each. 'mine' is a block the person added. */
export const KINDS = Object.freeze(['face', 'writing', 'mine']);

/** The box limited to the photo. */
export function clampBox(b, W, H) {
  const x0 = Math.max(0, Math.min(W, Math.floor(b.x)));
  const y0 = Math.max(0, Math.min(H, Math.floor(b.y)));
  const x1 = Math.max(x0, Math.min(W, Math.ceil(b.x + b.w)));
  const y1 = Math.max(y0, Math.min(H, Math.ceil(b.y + b.h)));
  return { ...b, x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

const area = (b) => Math.max(0, b.w) * Math.max(0, b.h);

/** The area two boxes share. */
export function overlapArea(a, b) {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Intersection over union. */
export function iou(a, b) {
  const i = overlapArea(a, b);
  return i ? i / (area(a) + area(b) - i) : 0;
}

/** The smallest box holding both. */
export function union(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { ...a, x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
}

/** Boxes that overlap are joined into one, until none overlap. Keeps the first box's other fields. */
export function mergeBoxes(boxes) {
  let list = boxes.map((b) => ({ ...b }));
  let changed = true;
  while (changed) {
    changed = false;
    const out = [];
    for (const b of list) {
      const hit = out.findIndex((o) => overlapArea(o, b) > 0);
      if (hit >= 0) {
        out[hit] = union(out[hit], b);
        changed = true;
      } else out.push(b);
    }
    list = out;
  }
  return list;
}

/** True when the point (x, y) is on the cover. `slop` widens the cover for a finger. */
export function onCover(c, x, y, slop = 0) {
  if (c.shape === 'ellipse') return ((x - c.cx) / (c.rx + slop)) ** 2 + ((y - c.cy) / (c.ry + slop)) ** 2 <= 1;
  return x >= c.x - slop && x <= c.x + c.w + slop && y >= c.y - slop && y <= c.y + c.h + slop;
}

/** The index of the top cover under the point (x, y), or -1. `slop` widens each cover for a finger. */
export function hitCover(covers, x, y, slop = 0) {
  for (let i = covers.length - 1; i >= 0; i--) if (onCover(covers[i], x, y, slop)) return i;
  return -1;
}

/** A block for one tap at (x, y): a square a seventh of the photo's shorter side, centred there. */
export function tapBox(x, y, W, H) {
  const s = Math.max(16, Math.round(Math.min(W, H) / 7));
  return clampBox({ kind: 'mine', x: Math.round(x - s / 2), y: Math.round(y - s / 2), w: s, h: s }, W, H);
}

/** A block dragged from (x0, y0) to (x1, y1), or null when the drag is too small to mean a block. */
export function dragBox(x0, y0, x1, y1, W, H, min = 8) {
  const b = clampBox({ kind: 'mine', x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }, W, H);
  return b.w >= min && b.h >= min ? b : null;
}

/** How many blocks of each kind. */
export function countKinds(covers) {
  const n = { face: 0, writing: 0, mine: 0 };
  for (const c of covers) if (c.kind in n) n[c.kind]++;
  return n;
}

/**
 * True when every pixel of `box` in an RGBA image is within `tol` of `rgb`. Used by the tests on the
 * file that is shared.
 */
export function isFlat(img, box, rgb = [0, 0, 0], tol = 0) {
  const b = clampBox(box, img.width, img.height);
  if (!b.w || !b.h) return false;
  for (let y = b.y; y < b.y + b.h; y++)
    for (let x = b.x; x < b.x + b.w; x++) {
      const i = (y * img.width + x) * 4;
      if (Math.abs(img.data[i] - rgb[0]) > tol || Math.abs(img.data[i + 1] - rgb[1]) > tol || Math.abs(img.data[i + 2] - rgb[2]) > tol) return false;
    }
  return true;
}

/**
 * The pixels a cover takes, as rows [y, x0, x1) inside a W x H photo. A pixel is taken when any part of it
 * is under the cover, so a cover never leaves a sliver of what it covers. An ellipse is cut to the photo
 * at its edges and still takes every pixel of it inside the photo.
 */
export function coverSpans(c, W, H) {
  const out = [];
  if (c.shape === 'ellipse') {
    const { cx, cy, rx, ry } = c;
    if (!(rx > 0 && ry > 0)) return out;
    const y1 = Math.min(H, Math.ceil(cy + ry));
    for (let y = Math.max(0, Math.floor(cy - ry)); y < y1; y++) {
      // The row's widest part of the ellipse is at its point nearest the centre.
      const ny = Math.min(Math.max(cy, y), y + 1);
      const t = 1 - ((ny - cy) / ry) ** 2;
      if (t <= 0) continue;
      const hw = rx * Math.sqrt(t);
      const x0 = Math.max(0, Math.floor(cx - hw));
      const x1 = Math.min(W, Math.ceil(cx + hw));
      if (x1 > x0) out.push([y, x0, x1]);
    }
    return out;
  }
  const b = clampBox(c, W, H);
  if (b.w > 0) for (let y = b.y; y < b.y + b.h; y++) out.push([y, b.x, b.x + b.w]);
  return out;
}

/** Every pixel under any of the covers: 1 where covered, 0 elsewhere, one byte per pixel. */
export function coverMask(covers, W, H) {
  const mask = new Uint8Array(W * H);
  for (const c of covers) for (const [y, x0, x1] of coverSpans(c, W, H)) mask.fill(1, y * W + x0, y * W + x1);
  return mask;
}

/** The cover grown by r pixels on every side. */
function grow(c, r) {
  if (c.shape === 'ellipse') return { ...c, rx: c.rx + r, ry: c.ry + r };
  return { ...c, x: c.x - r, y: c.y - r, w: c.w + 2 * r, h: c.h + 2 * r };
}

/** How wide a ring around a cover its colour is taken from: thin, a few pixels on a phone photo. */
export const ringWidth = (W, H) => Math.max(3, Math.round(Math.max(W, H) / 256));

/**
 * A cover's colour: the middle value of each of red, green and blue over a thin ring of pixels just
 * outside it. Only pixels under no cover count (`mask`, from coverMask, holds every cover, this one too),
 * so the colour says nothing about what any cover hides: it is made only of pixels the new file shows.
 */
export function fillColour(img, c, mask, ring = ringWidth(img.width, img.height)) {
  const { width: W, height: H, data } = img;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let r = ring; ; r *= 2) {
    let n = 0;
    for (const [y, x0, x1] of coverSpans(grow(c, r), W, H))
      for (let i = y * W + x0, end = y * W + x1; i < end; i++) {
        if (mask[i]) continue;
        hist[0][data[i * 4]]++;
        hist[1][data[i * 4 + 1]]++;
        hist[2][data[i * 4 + 2]]++;
        n++;
      }
    if (n >= MIN_RING || r >= Math.max(W, H)) return n ? hist.map((h) => middle(h, n)) : [...NEUTRAL_FILL];
    for (const h of hist) h.fill(0);
  }
}

function middle(hist, n) {
  for (let v = 0, seen = 0; v < 256; v++) if ((seen += hist[v]) * 2 >= n) return v;
  return 255;
}

/**
 * Paints the covers into an RGBA image ({width, height, data}), in place: each cover one flat colour from
 * fillColour. Every colour is taken before any is painted, so the order of the covers does not change
 * them. Returns the colours, one [r, g, b] per cover.
 */
export function paintCovers(img, covers) {
  const { width: W, height: H, data } = img;
  const spans = covers.map((c) => coverSpans(c, W, H));
  const mask = new Uint8Array(W * H);
  for (const s of spans) for (const [y, x0, x1] of s) mask.fill(1, y * W + x0, y * W + x1);
  const fills = covers.map((c) => fillColour(img, c, mask));
  spans.forEach((s, k) => {
    const [r, g, b] = fills[k];
    for (const [y, x0, x1] of s)
      for (let i = (y * W + x0) * 4, end = (y * W + x1) * 4; i < end; i += 4) {
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
  });
  return fills;
}
