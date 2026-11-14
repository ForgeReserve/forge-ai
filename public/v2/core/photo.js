// Share unseen in the page: opens a photo on the phone, draws it with its cover blocks, and makes the new
// file that is shared, saved or asked about. The photo is held in this page's memory only. Nothing here
// stores it or sends it anywhere; the original file is never shared.
import { alignBox, COVER_FILL } from './covers.js';
import { finishFile } from './filters.js';
import { leftDetails } from './photometa.js';

/** The largest photo opened, in bytes. */
export const MAX_PHOTO_BYTES = 40 * 1024 * 1024;
/** The longest side the photo is worked on and shared at, in pixels. Messengers shrink photos further. */
export const WORK_MAX_PX = 2048;
/** JPEG quality of the new file. */
export const OUT_QUALITY = 0.9;
/** The new file's name: plain, so it says nothing about the app or the person. */
export const OUT_NAME = 'photo.jpg';

export class PhotoError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

async function decode(file) {
  try {
    // Turned the way the camera meant it (the orientation note is used here, then dropped with the rest).
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/**
 * Opens a photo file: {width, height, canvas, pixels, bytes, type}. `canvas` holds the picture at no
 * more than WORK_MAX_PX on its long side, `pixels` its RGBA data and `bytes` the original file (read by
 * the hidden details filter only).
 */
export async function openPhoto(file) {
  if (!file || (file.type && !file.type.startsWith('image/'))) throw new PhotoError('not_image');
  if (file.size > MAX_PHOTO_BYTES) throw new PhotoError('too_big');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let pic;
  try {
    pic = await decode(file);
  } catch {
    throw new PhotoError('bad_image');
  }
  const w0 = pic.width || pic.naturalWidth;
  const h0 = pic.height || pic.naturalHeight;
  if (!w0 || !h0) throw new PhotoError('bad_image');
  const s = Math.min(1, WORK_MAX_PX / Math.max(w0, h0));
  const width = Math.max(1, Math.round(w0 * s));
  const height = Math.max(1, Math.round(h0 * s));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(pic, 0, 0, width, height);
  pic.close?.();
  return { width, height, canvas, pixels: ctx.getImageData(0, 0, width, height), bytes, type: file.type || 'image/*' };
}

/** Draws the photo with its blocks into `target` (a canvas of the photo's size): what will be shared. */
export function drawCovered(photo, covers, target) {
  target.width = photo.width;
  target.height = photo.height;
  const ctx = target.getContext('2d');
  ctx.drawImage(photo.canvas, 0, 0);
  ctx.fillStyle = COVER_FILL;
  for (const c of covers) {
    const b = alignBox(c, photo.width, photo.height);
    ctx.fillRect(b.x, b.y, b.w, b.h);
  }
  return target;
}

const toBlob = (canvas, type, q) => new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new PhotoError('encode_failed'))), type, q));

/**
 * The file to share: the photo drawn again with its blocks, made into a new JPEG, cleaned by each
 * filter's finish(), then checked. Throws PhotoError('unsafe') when the new file still carries any
 * place for notes, so such a file is never shared.
 */
export async function makeFile(photo, covers, filters) {
  const canvas = drawCovered(photo, covers, document.createElement('canvas'));
  const blob = await toBlob(canvas, 'image/jpeg', OUT_QUALITY);
  canvas.width = canvas.height = 0;
  const bytes = await finishFile(filters, new Uint8Array(await blob.arrayBuffer()));
  if (leftDetails(bytes).length) throw new PhotoError('unsafe');
  return new File([bytes], OUT_NAME, { type: 'image/jpeg' });
}

/** Lets go of the photo's pixels, so the memory they take is freed. */
export function closePhoto(photo) {
  if (!photo) return;
  photo.canvas.width = photo.canvas.height = 0;
  photo.pixels = null;
  photo.bytes = null;
}

/**
 * Shares a file through the phone's share sheet, or saves it where there is no sheet for files.
 * Resolves 'shared', 'opened' (the Android app's sheet opened), 'cancelled' or 'saved'.
 */
export async function shareOrSave(file, share) {
  if (share.canShareFiles([file])) {
    try {
      // The Android app's share sheet says only that it opened, not where the photo went.
      const r = await share.files([file]);
      return r?.opened ? 'opened' : 'shared';
    } catch (e) {
      if (e?.name === 'AbortError') return 'cancelled';
      throw e;
    }
  }
  share.save(file);
  return 'saved';
}

// ------------------------------------------------------------------ shared in from another app

/** Where the service worker leaves a photo shared in from another app (public/v2/sw.js). */
export const SHARE_CACHE = 'forge2-share';
export const SHARE_KEY = '/v2/__shared-photo';

/**
 * Takes the photo another app shared in: reads it from where the service worker left it and deletes
 * that copy at once. Resolves a File, or null when there is none.
 */
export async function takeShared(caches = globalThis.caches) {
  if (!caches) return null;
  try {
    const res = await caches.match(SHARE_KEY, { cacheName: SHARE_CACHE });
    const blob = res ? await res.blob() : null;
    return blob ? new File([blob], 'shared', { type: blob.type || 'image/*' }) : null;
  } finally {
    await caches.delete(SHARE_CACHE).catch(() => {});
  }
}
