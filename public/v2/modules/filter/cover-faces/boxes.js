// Box maths for the face filter, kept apart from the detector so it is tested in Node.
import { clampBox, iou } from '../../../core/covers.js';

/** The detector's input size (pixels on a side): face-api's usual balance of speed and small faces. */
export const INPUT_SIZE = 416;

/** The lowest detector score taken as a face. Low on purpose: a block too many is better than a face shown. */
export const MIN_SCORE = 0.35;

/** From this score down to MIN_SCORE the detector is less sure where the face is, and its cover grows. */
export const SURE_SCORE = 0.6;

/**
 * The parts of a W x H photo the detector looks at: the whole photo and, for a large one, four
 * overlapping quarters, so small faces in a group photo are seen at a useful size.
 */
export function passes(W, H) {
  const list = [{ x: 0, y: 0, w: W, h: H }];
  if (Math.max(W, H) >= 1000) {
    const tw = Math.ceil(W * 0.6);
    const th = Math.ceil(H * 0.6);
    for (const y of [0, H - th]) for (const x of [0, W - tw]) list.push({ x, y, w: tw, h: th });
  }
  return list;
}

/** One box per face: where boxes overlap (the same face seen in two passes), the higher score stays. */
export function keepFaces(dets, maxIou = 0.3) {
  const sorted = [...dets].sort((a, b) => b.score - a.score);
  const out = [];
  for (const d of sorted) if (d.score >= MIN_SCORE && !out.some((o) => iou(o, d) > maxIou || inside(d, o))) out.push(d);
  return out;
}

const inside = (a, b) => a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;

/**
 * The cover for one face: an ellipse round the detector's box, which holds the face itself. It reaches
 * half the box's height above it for the hair, three tenths of its width to each side for the ears and
 * three tenths of its height below it for the chin: the ellipse that fits in a rectangle that far round
 * the box, whose corners are beside the head rather than on it. The box's own corners stay at least a
 * twentieth of its size inside. Two of the detector's pixels are added all round for where it places the
 * box, and up to 15% more for a face it was not sure of. `found` keeps the box.
 */
export function faceCover(d, W, H) {
  const unsure = d.score == null ? 0 : Math.min(1, Math.max(0, (SURE_SCORE - d.score) / (SURE_SCORE - MIN_SCORE)));
  const k = 1 + 0.15 * unsure;
  const pad = (2 * Math.max(W, H)) / INPUT_SIZE;
  const cx = d.x + d.w / 2;
  const cy = d.y + 0.4 * d.h;
  const rx = 0.8 * d.w * k + pad;
  const ry = 0.9 * d.h * k + pad;
  const x = Math.floor(cx - rx);
  const y = Math.floor(cy - ry);
  const b = clampBox({ x, y, w: Math.ceil(cx + rx) - x, h: Math.ceil(cy + ry) - y }, W, H);
  return { kind: 'face', shape: 'ellipse', cx, cy, rx, ry, x: b.x, y: b.y, w: b.w, h: b.h, found: { x: d.x, y: d.y, w: d.w, h: d.h } };
}
