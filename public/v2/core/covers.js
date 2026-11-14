// Cover blocks for Share unseen: solid blocks painted over faces, writing and whatever the person
// covers by hand. Pure maths on boxes in the photo's own pixels ({x, y, w, h}), tested in Node.
//
// A block is painted solid, never blurred (a blur can be undone). Before it is painted it is widened to
// the JPEG encoder's 16 pixel grid, so no 16 by 16 block of the new file mixes covered and uncovered
// pixels: each covered block is one flat colour and holds nothing of what was under it.

/** The grid the JPEG encoder works on with colour subsampling (16 by 16 pixel blocks). */
export const GRID = 16;

/** The colour painted over a covered area. */
export const COVER_FILL = '#000000';

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

/** The box widened outwards to the GRID, within the photo. */
export function alignBox(b, W, H, grid = GRID) {
  const x0 = Math.max(0, Math.floor(b.x / grid) * grid);
  const y0 = Math.max(0, Math.floor(b.y / grid) * grid);
  const x1 = Math.min(W, Math.ceil((b.x + b.w) / grid) * grid);
  const y1 = Math.min(H, Math.ceil((b.y + b.h) / grid) * grid);
  return { ...b, x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** The box with a margin on each side, as fractions of its own width and height. */
export function padBox(b, { left = 0, right = left, top = 0, bottom = top } = {}, W = Infinity, H = Infinity) {
  return clampBox({ ...b, x: b.x - b.w * left, y: b.y - b.h * top, w: b.w * (1 + left + right), h: b.h * (1 + top + bottom) }, W, H);
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

/** The index of the top block under the point (x, y), or -1. `slop` widens each block for a finger. */
export function hitCover(covers, x, y, slop = 0) {
  for (let i = covers.length - 1; i >= 0; i--) {
    const c = covers[i];
    if (x >= c.x - slop && x <= c.x + c.w + slop && y >= c.y - slop && y <= c.y + c.h + slop) return i;
  }
  return -1;
}

/** A block for one tap at (x, y): a square a seventh of the photo's shorter side, centred there. */
export function tapBox(x, y, W, H) {
  const s = Math.max(GRID, Math.round(Math.min(W, H) / 7));
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
