// Taking a photo inside the app, for Share unseen (screens/camera.js, through the camera adapter's
// still()). The phone's own camera app is not opened: on a phone short of memory, Android stopped Forge
// while that app was open, and the photo it took had nowhere to go. Pure helpers, tested in Node: which
// size to ask for, the shape of the still the camera gave, and the mark that a photo picker was open.

/** The other camera: the back one ('environment') or the one on the screen's side ('user'). */
export const otherFacing = (facing) => (facing === 'user' ? 'environment' : 'user');

/**
 * The settings for ImageCapture.takePhoto from its photo capabilities: the largest still the camera
 * takes. {} (the browser's own choice) when the capabilities do not say.
 */
export function stillSize(caps) {
  const w = caps?.imageWidth?.max;
  const h = caps?.imageHeight?.max;
  return w > 0 && h > 0 ? { imageWidth: w, imageHeight: h } : {};
}

/**
 * The largest picture a camera's stream offers, from the track's capabilities: {width, height}, or null
 * when it does not say. Used where there is no ImageCapture, so a frame of the stream is the photo.
 */
export function largestFrame(caps) {
  const w = caps?.width?.max;
  const h = caps?.height?.max;
  return w > 0 && h > 0 ? { width: w, height: h } : null;
}

/** A 16 bit number at b[i], big endian or little endian. */
const u16 = (b, i, le) => (le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);

/** The Exif orientation (1 to 8) in a TIFF block at b[from, to), or 1. */
function exifTurn(b, from, to) {
  if (to - from < 8) return 1;
  const le = b[from] === 0x49 && b[from + 1] === 0x49;
  if (!le && !(b[from] === 0x4d && b[from + 1] === 0x4d)) return 1;
  const off = le ? (b[from + 4] | (b[from + 5] << 8) | (b[from + 6] << 16) | (b[from + 7] << 24)) >>> 0 : ((b[from + 4] << 24) | (b[from + 5] << 16) | (b[from + 6] << 8) | b[from + 7]) >>> 0;
  const ifd = from + off;
  if (off < 8 || ifd + 2 > to) return 1;
  const n = u16(b, ifd, le);
  for (let k = 0; k < n; k++) {
    const e = ifd + 2 + k * 12;
    if (e + 12 > to) break;
    if (u16(b, e, le) === 0x0112) {
      const v = u16(b, e + 8, le);
      return v >= 1 && v <= 8 ? v : 1;
    }
  }
  return 1;
}

/**
 * The width and height a still shows at, turned as its Exif orientation says (a JPEG) or as it is (a
 * PNG), from its first bytes. null when they cannot be read.
 */
export function stillShape(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    return w && h ? { width: w, height: h } : null;
  }
  if (!(b.length >= 4 && b[0] === 0xff && b[1] === 0xd8)) return null;
  let turn = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    const from = i + 4;
    if (m === 0xe1 && from + 6 <= b.length && String.fromCharCode(...b.subarray(from, from + 4)) === 'Exif') turn = exifTurn(b, from + 6, Math.min(b.length, i + 2 + len));
    // A start of frame (not DHT, JPG or DAC, which share the range): the picture's own size.
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (from + 5 > b.length) return null;
      const h = (b[from + 1] << 8) | b[from + 2];
      const w = (b[from + 3] << 8) | b[from + 4];
      if (!w || !h) return null;
      return turn >= 5 ? { width: h, height: w } : { width: w, height: h };
    }
    if (m === 0xda) return null;
    i += 2 + len;
  }
  return null;
}

/**
 * Whether a still the camera gave is turned the other way from what the screen showed: one is wider than
 * tall and the other taller than wide. Then the frame the screen showed is used instead, so the photo is
 * never sideways. A square, or a shape that could not be read, is taken as it is.
 */
export function turnedAway(shape, view) {
  if (!shape || !view?.width || !view?.height) return false;
  if (shape.width === shape.height || view.width === view.height) return false;
  return shape.width > shape.height !== view.width > view.height;
}

// ------------------------------------------------------------------ a photo picker that was open

/**
 * While the phone's photo picker (or its own camera app, where the in-app camera cannot open) is up,
 * Android may stop the app to free memory, and start it again afresh when the picker closes: the photo
 * picked then has nowhere to go. A mark in localStorage, the time the picker opened and nothing else,
 * lets the app open on Share unseen again in that case (app.js start), so the person picks again. It is
 * taken away when the picker closes with the app still running, and when the app reads it.
 */
export const PICKING_KEY = 'forge2.picking';
/** How long after the picker opened a fresh start still returns to Share unseen. */
export const PICKING_MS = 10 * 60_000;

export function markPicking(storage, now = Date.now()) {
  try {
    storage?.setItem(PICKING_KEY, String(now));
  } catch {
    /* no storage: a restart opens the home */
  }
}

export function clearPicking(storage) {
  try {
    storage?.removeItem(PICKING_KEY);
  } catch {
    /* no storage */
  }
}

/** Whether a picker was open when the app last stopped, not too long ago. Takes the mark away. */
export function wasPicking(storage, now = Date.now()) {
  let at = null;
  try {
    at = storage?.getItem(PICKING_KEY) ?? null;
  } catch {
    return false;
  }
  if (at === null) return false;
  clearPicking(storage);
  const age = now - Number(at);
  return Number.isFinite(age) && age >= 0 && age < PICKING_MS;
}
