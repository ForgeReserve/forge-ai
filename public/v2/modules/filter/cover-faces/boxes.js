// Box maths for the face filter, kept apart from the detector so it is tested in Node.
import { clampBox, iou } from '../../../core/covers.js';

/** The side of each picture the detector is given, in its own pixels: one tile. */
export const TILE = 640;

/** The long side the photo is looked at in tiles: a smaller photo is enlarged to it, up to MAX_ZOOM. */
export const LOOK_SIDE = 2048;

/** The most a photo is enlarged. YuNet finds faces from about 10 of its pixels across, so twice is enough. */
export const MAX_ZOOM = 2;

/** The most tiles one photo gets, besides the look at the whole photo: 12 is a 2048 x 1536 photo at its own size. */
export const MAX_TILES = 12;

/** How much neighbouring tiles share, as a part of a tile: a face up to 128 of the detector's pixels is whole in one. */
export const OVERLAP = 0.2;

/** The lowest detector score taken as a face. Low on purpose: a block too many is better than a face shown. */
export const MIN_SCORE = 0.6;

/** From this score down to MIN_SCORE the detector is less sure where the face is, and its cover grows. */
export const SURE_SCORE = 0.8;

/** The smallest face kept, in the photo's pixels across: smaller, nobody can tell who it is. */
export const MIN_SIDE = 10;

/** From this score up to MIN_SCORE a find is offered to the person as a spot that may be a face. */
export const MAYBE_SCORE = 0.5;

const count = (len, side) => (len <= side ? 1 : Math.ceil((len - side) / (side * (1 - OVERLAP))) + 1);

/**
 * The parts of a W x H photo the detector looks at, each {x, y, w, h} in the photo's pixels with the
 * `scale` it is drawn at for the detector. First the whole photo, made to fit one tile, for faces too
 * large for a tile. Then overlapping tiles covering all of it, each TILE of the detector's pixels, at a
 * zoom that brings the photo's long side to LOOK_SIDE (at most MAX_ZOOM): a face 10 pixels across in a
 * 1280 px photo reaches the detector at 16. When that would take more than MAX_TILES tiles (a square
 * photo), the zoom is lowered until it takes no more, so every part of the photo is still looked at. A
 * photo that fits in one tile at its zoom is one look. `look` is the long side to look at instead: 0
 * looks at the photo's own size, about half the work for a phone with no graphics chip to use.
 */
export function passes(W, H, look = LOOK_SIDE) {
  const long = Math.max(W, H);
  let zoom = Math.min(MAX_ZOOM, Math.max(1, look / long));
  for (;;) {
    const side = TILE / zoom;
    if (W <= side && H <= side) return [{ x: 0, y: 0, w: W, h: H, scale: zoom }];
    const nx = count(W, side);
    const ny = count(H, side);
    if (nx * ny > MAX_TILES) {
      zoom /= 1.1;
      continue;
    }
    const tw = Math.min(W, Math.round(side));
    const th = Math.min(H, Math.round(side));
    const list = [{ x: 0, y: 0, w: W, h: H, scale: Math.min(1, TILE / long) }];
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) list.push({ x: nx > 1 ? Math.round((i * (W - tw)) / (nx - 1)) : 0, y: ny > 1 ? Math.round((j * (H - th)) / (ny - 1)) : 0, w: tw, h: th, scale: zoom });
    return list;
  }
}

/** One box per face: where boxes overlap (the same face seen twice), the higher score stays. Weak finds and ones under MIN_SIDE are dropped. */
export function keepFaces(dets, maxIou = 0.3) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const out = [];
  for (const d of sorted) if (d.score >= MIN_SCORE && Math.max(d.w, d.h) >= MIN_SIDE && !out.some((o) => iou(o, d) > maxIou || inside(d, o))) out.push(d);
  return out;
}

const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
const meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

/**
 * Finds too weak to cover (from MAYBE_SCORE up to MIN_SCORE) that meet none of the kept faces: spots that
 * may be faces too small or blurred for the detector to be sure of. One per place, the best scored.
 */
export function maybeFaces(dets, kept) {
  const out = [];
  for (const d of [...dets].sort((a, b) => b.score - a.score))
    if (d.score >= MAYBE_SCORE && d.score < MIN_SCORE && Math.max(d.w, d.h) >= MIN_SIDE && !kept.some((k) => meets(k, d)) && !out.some((o) => meets(o, d))) out.push(d);
  return out;
}

/**
 * The cover for one face: an ellipse round the detector's box, which holds the face itself. It reaches
 * half the box's height above it for the hair, three tenths of its width to each side for the ears and
 * three tenths of its height below it for the chin: the ellipse that fits in a rectangle that far round
 * the box, whose corners are beside the head rather than on it. The box's own corners stay at least a
 * twentieth of its size inside. For where the detector places the box, a tenth of the box's size (at most
 * 4 pixels: it matters for a small face) is added all round, and two of the detector's pixels at the look at the whole photo (about 6 in a 2048 px photo),
 * and up to 15% more for a face it was not sure of. `found` keeps the box.
 */
export function faceCover(d, W, H) {
  const unsure = d.score == null ? 0 : Math.min(1, Math.max(0, (SURE_SCORE - d.score) / (SURE_SCORE - MIN_SCORE)));
  const k = 1 + 0.15 * unsure;
  const pad = 2 * Math.max(1, Math.max(W, H) / TILE);
  const m = Math.min(4, 0.1 * Math.max(d.w, d.h));
  const cx = d.x + d.w / 2;
  const cy = d.y + 0.4 * d.h;
  const rx = (0.8 * d.w + m) * k + pad;
  const ry = (0.9 * d.h + m) * k + pad;
  const x = Math.floor(cx - rx);
  const y = Math.floor(cy - ry);
  const b = clampBox({ x, y, w: Math.ceil(cx + rx) - x, h: Math.ceil(cy + ry) - y }, W, H);
  return { kind: 'face', shape: 'ellipse', cx, cy, rx, ry, x: b.x, y: b.y, w: b.w, h: b.h, found: { x: d.x, y: d.y, w: d.w, h: d.h } };
}
