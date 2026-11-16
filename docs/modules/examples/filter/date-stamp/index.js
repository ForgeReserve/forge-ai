// A filter for Share unseen: covers a date stamp, the orange date and time some cameras print in the
// bottom right corner of a photo. It reads only the photo's pixels, on the phone. Its blocks are of the
// kind 'writing', so the app counts them with the other writing it covered.

/** The part of the photo searched: the right half of its bottom quarter. */
const AREA = { left: 0.5, top: 0.75 };

/** True for the orange of a printed date stamp: strong red, some green, little blue. */
const stampColour = (r, g, b) => r >= 200 && g >= 70 && g <= 190 && b <= 90 && r - b >= 140;

/**
 * Where a date stamp is, as a box in the photo's pixels ({x, y, w, h}), or null. `pixels` is the photo's
 * ImageData: {width, height, data}, with four bytes (red, green, blue, alpha) per pixel.
 */
export function findStamp({ width, height, data }) {
  const x0 = Math.floor(width * AREA.left);
  const y0 = Math.floor(height * AREA.top);
  let n = 0;
  let left = width;
  let top = height;
  let right = -1;
  let bottom = -1;
  for (let y = y0; y < height; y++) {
    for (let x = x0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (!stampColour(data[i], data[i + 1], data[i + 2])) continue;
      n++;
      left = Math.min(left, x);
      right = Math.max(right, x);
      top = Math.min(top, y);
      bottom = Math.max(bottom, y);
    }
  }
  const area = (width - x0) * (height - y0);
  // Too few orange pixels to be writing, or so many that they are part of the picture (a sunset).
  if (n < 30 || n > area * 0.25) return null;
  // Orange spread over most of the corner is part of the picture too.
  if ((right - left + 1) * (bottom - top + 1) > area * 0.5) return null;
  const pad = 6;
  const x = Math.max(0, left - pad);
  const y = Math.max(0, top - pad);
  return { x, y, w: Math.min(width, right + 1 + pad) - x, h: Math.min(height, bottom + 1 + pad) - y };
}

export function create() {
  return {
    id: 'date-stamp',
    what: 'writing',
    async analyse(photo) {
      const box = findStamp(photo.pixels);
      return { covers: box ? [{ kind: 'writing', ...box }] : [] };
    },
  };
}
