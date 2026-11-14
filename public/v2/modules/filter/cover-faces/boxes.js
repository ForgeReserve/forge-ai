// Box maths for the face filter, kept apart from the detector so it is tested in Node.
import { iou, padBox } from '../../../core/covers.js';

/** The detector's input size (pixels on a side): face-api's usual balance of speed and small faces. */
export const INPUT_SIZE = 416;

/** The lowest detector score taken as a face. Low on purpose: a block too many is better than a face shown. */
export const MIN_SCORE = 0.35;

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
 * The block for one face: the detector's box is the face itself, so the block reaches out to the hair,
 * the ears and the chin, which also identify a person.
 */
export function faceCover(d, W, H) {
  const b = padBox({ x: d.x, y: d.y, w: d.w, h: d.h }, { left: 0.3, right: 0.3, top: 0.5, bottom: 0.3 }, W, H);
  return { kind: 'face', x: b.x, y: b.y, w: b.w, h: b.h };
}
