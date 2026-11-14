// The hidden details a photo file carries, and how they are taken out. Pure: bytes in, bytes or a list
// out, so it is tested in Node with real camera files.
//
// A phone photo can say where it was taken (GPS), which phone took it (make, model, serial, software),
// when (date and time), and can hold a small copy of the picture (a thumbnail, or the extra images a
// phone keeps beside it). Share unseen never sends the file it was given: it draws the picture again
// and makes a new JPEG (core/photo.js), which carries none of that. stripJpeg() then removes every
// marker a JPEG can carry notes in, and leftDetails() checks the result, so a file with any of them
// left is never shared.

/** What readDetails() can find, in the order the list of changes shows them. */
export const DETAILS = Object.freeze(['location', 'device', 'time', 'thumbnail', 'other']);

/** 'jpeg', 'png', 'webp', 'gif', 'heic' or 'other', from the first bytes. */
export function fileType(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (b.length >= 6 && ascii(b, 0, 3) === 'GIF') return 'gif';
  if (b.length >= 12 && ascii(b, 4, 4) === 'ftyp') return 'heic';
  return 'other';
}

function ascii(b, at, n) {
  let s = '';
  for (let i = at; i < Math.min(b.length, at + n); i++) s += String.fromCharCode(b[i]);
  return s;
}

const APP0 = 0xe0;
const APP14 = 0xee;
const COM = 0xfe;
const SOS = 0xda;
const EOI = 0xd9;
const standalone = (m) => m === 0x01 || (m >= 0xd0 && m <= 0xd7);

/**
 * The segments of a JPEG, in order: {marker, start, end, data: [from, to)}. Each scan's entropy coded
 * data is part of its SOS segment. `trailing` is the number of bytes after the end marker (some phones
 * keep notes there). Returns null for a file that is not a well formed JPEG.
 */
export function jpegSegments(b) {
  if (fileType(b) !== 'jpeg') return null;
  const segs = [];
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) return null;
    while (b[i] === 0xff && i < b.length) i++; // fill bytes
    const marker = b[i];
    const start = i - 1;
    i++;
    if (marker === EOI) {
      segs.push({ marker, start, end: i, data: [i, i] });
      return { segs, trailing: b.length - i };
    }
    if (standalone(marker)) {
      segs.push({ marker, start, end: i, data: [i, i] });
      continue;
    }
    if (i + 2 > b.length) return null;
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2 || i + len > b.length) return null;
    const data = [i + 2, i + len];
    i += len;
    if (marker === SOS) {
      // Entropy coded data runs to the next marker that is not a stuffed 0xFF00 or a restart marker.
      while (i < b.length) {
        if (b[i] === 0xff && i + 1 < b.length && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7) && b[i + 1] !== 0xff) break;
        i++;
      }
    }
    segs.push({ marker, start, end: i, data });
  }
  return null; // no end marker
}

/** The kind of notes an APPn segment holds, by its marker and the name at its start. */
function appKind(b, seg) {
  const [from, to] = seg.data;
  const head = ascii(b, from, Math.min(32, to - from));
  if (seg.marker === APP0) return head.startsWith('JFIF\0') ? 'jfif' : 'jfxx';
  if (seg.marker === 0xe1) return head.startsWith('Exif\0') ? 'exif' : head.startsWith('http://ns.adobe.com/xap/1.0/') || head.startsWith('http://ns.adobe.com/xmp/extension/') ? 'xmp' : 'app';
  if (seg.marker === 0xe2) return head.startsWith('ICC_PROFILE\0') ? 'icc' : head.startsWith('MPF\0') ? 'mpf' : 'app';
  if (seg.marker === 0xed) return 'iptc';
  if (seg.marker === APP14) return head.startsWith('Adobe') ? 'adobe' : 'app';
  return 'app';
}

const isApp = (m) => m >= 0xe0 && m <= 0xef;

/** A JFIF header with a thumbnail in it (its thumbnail width and height are not zero). */
function jfifThumb(b, seg) {
  const [from, to] = seg.data;
  return to - from >= 14 && (b[from + 12] > 0 || b[from + 13] > 0);
}

// TIFF tags (Exif) and what they tell about the person.
const DEVICE_TAGS = new Set([0x010f, 0x0110, 0x0131, 0x013b, 0x8298, 0xa430, 0xa431, 0xa432, 0xa433, 0xa434, 0xa435]);
const TIME_TAGS = new Set([0x0132, 0x9003, 0x9004, 0x9010, 0x9011, 0x9012, 0x9290, 0x9291, 0x9292]);
const OTHER_TAGS = new Set([0x010e, 0x9286, 0xa420, 0x927c, 0x9c9b, 0x9c9c, 0x9c9d, 0x9c9e, 0x9c9f]);

/** What a TIFF (Exif) block in b[from, to) holds. Adds to `found`. */
function readTiff(b, from, to, found) {
  const n = to - from;
  if (n < 8) return;
  const le = b[from] === 0x49 && b[from + 1] === 0x49;
  if (!le && !(b[from] === 0x4d && b[from + 1] === 0x4d)) return;
  const u16 = (o) => (o + 2 > n ? -1 : le ? b[from + o] | (b[from + o + 1] << 8) : (b[from + o] << 8) | b[from + o + 1]);
  const u32 = (o) => (o + 4 > n ? -1 : le ? (b[from + o] | (b[from + o + 1] << 8) | (b[from + o + 2] << 16) | (b[from + o + 3] << 24)) >>> 0 : ((b[from + o] << 24) | (b[from + o + 1] << 16) | (b[from + o + 2] << 8) | b[from + o + 3]) >>> 0);
  const seen = new Set();
  const ifd = (off, kind) => {
    if (off <= 0 || off >= n || seen.has(off)) return 0;
    seen.add(off);
    const count = u16(off);
    if (count < 0 || count > 1000) return 0;
    for (let k = 0; k < count; k++) {
      const e = off + 2 + k * 12;
      const tag = u16(e);
      if (tag < 0) break;
      if (kind === 'gps') {
        if (tag !== 0x0000) found.add('location'); // anything beyond the GPS version number
        continue;
      }
      if (kind === 'ifd1') {
        found.add('thumbnail');
        continue;
      }
      if (tag === 0x8825) ifd(u32(e + 8), 'gps');
      else if (tag === 0x8769 || tag === 0xa005) ifd(u32(e + 8), 'exif');
      else if (DEVICE_TAGS.has(tag)) found.add('device');
      else if (TIME_TAGS.has(tag)) found.add('time');
      else if (OTHER_TAGS.has(tag)) found.add('other');
    }
    return u32(off + 2 + count * 12);
  };
  const next = ifd(u32(4), 'ifd0');
  if (next > 0) ifd(next, 'ifd1');
}

/** What an XMP packet mentions. XMP repeats Exif in text form, and can add names and places. */
function readXmp(b, from, to, found) {
  const s = ascii(b, from, to - from);
  if (/exif:GPS|GPSLatitude|GPSLongitude|photoshop:City|Iptc4xmpCore:Location/i.test(s)) found.add('location');
  if (/tiff:Make|tiff:Model|aux:SerialNumber|aux:Lens|xmp:CreatorTool/i.test(s)) found.add('device');
  if (/CreateDate|DateTimeOriginal|ModifyDate|DateCreated/i.test(s)) found.add('time');
  found.add('other');
}

function readJpeg(b, found) {
  const parsed = jpegSegments(b);
  if (!parsed) return false;
  for (const seg of parsed.segs) {
    if (seg.marker === COM) found.add('other');
    if (!isApp(seg.marker)) continue;
    const kind = appKind(b, seg);
    const [from, to] = seg.data;
    if (kind === 'exif') readTiff(b, from + 6, to, found);
    else if (kind === 'xmp') readXmp(b, from, to, found);
    else if (kind === 'mpf') found.add('thumbnail'); // extra images kept beside the photo
    else if (kind === 'jfxx') found.add('thumbnail');
    else if (kind === 'jfif') {
      if (jfifThumb(b, seg)) found.add('thumbnail');
    } else if (kind === 'iptc' || kind === 'app') found.add('other');
  }
  if (parsed.trailing > 0) found.add('other');
  return true;
}

function readPng(b, found) {
  let i = 8;
  while (i + 12 <= b.length) {
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    const type = ascii(b, i + 4, 4);
    const from = i + 8;
    if (from + len > b.length) return false;
    if (type === 'eXIf') readTiff(b, from, from + len, found);
    else if (type === 'tIME') found.add('time');
    else if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const s = ascii(b, from, Math.min(len, 4096));
      if (s.startsWith('XML:com.adobe.xmp')) readXmp(b, from, from + len, found);
      else found.add(/^Creation Time/.test(s) ? 'time' : 'other');
    }
    if (type === 'IEND') return true;
    i = from + len + 4;
  }
  return false;
}

function readWebp(b, found) {
  let i = 12;
  while (i + 8 <= b.length) {
    const type = ascii(b, i, 4);
    const len = (b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24)) >>> 0;
    const from = i + 8;
    if (from + len > b.length) return false;
    if (type === 'EXIF') {
      const exif = ascii(b, from, 6) === 'Exif\0\0' ? from + 6 : from;
      readTiff(b, exif, from + len, found);
    } else if (type === 'XMP ') readXmp(b, from, from + len, found);
    i = from + len + (len % 2);
  }
  return true;
}

/**
 * What hidden details a photo file holds: {type, known, found}. `found` lists DETAILS in their order.
 * `known` is false for a format this file cannot read (HEIC, GIF): those are made into a new file all
 * the same, so whatever they held is gone, but the list cannot say what it was.
 */
export function readDetails(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const type = fileType(b);
  const found = new Set();
  let known = false;
  if (type === 'jpeg') known = readJpeg(b, found);
  else if (type === 'png') known = readPng(b, found);
  else if (type === 'webp') known = readWebp(b, found);
  return { type, known, found: DETAILS.filter((d) => found.has(d)) };
}

/**
 * A copy of a JPEG with every place for notes taken out: all APPn segments except a JFIF header with no
 * thumbnail and Adobe's colour flag, every comment, and anything after the end marker. The picture
 * itself is left as it is. Throws on a file that is not a well formed JPEG.
 */
export function stripJpeg(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parsed = jpegSegments(b);
  if (!parsed) throw new Error('not a JPEG');
  const keep = [[0, 2]];
  for (const seg of parsed.segs) {
    if (seg.marker === COM) continue;
    if (isApp(seg.marker)) {
      const kind = appKind(b, seg);
      if (!((kind === 'jfif' && !jfifThumb(b, seg)) || kind === 'adobe')) continue;
    }
    keep.push([seg.start, seg.end]);
  }
  const size = keep.reduce((s, [f, t]) => s + t - f, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const [f, t] of keep) {
    out.set(b.subarray(f, t), o);
    o += t - f;
  }
  return out;
}

/**
 * What a file about to be shared still carries, as a list of problems (empty when clean). Share unseen
 * shares only a JPEG for which this is empty.
 */
export function leftDetails(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const parsed = jpegSegments(b);
  if (!parsed) return ['not a well formed JPEG'];
  const out = [];
  for (const seg of parsed.segs) {
    if (seg.marker === COM) out.push('a comment');
    else if (isApp(seg.marker)) {
      const kind = appKind(b, seg);
      if (!((kind === 'jfif' && !jfifThumb(b, seg)) || kind === 'adobe')) out.push(`an APP${seg.marker - APP0} segment (${kind})`);
    }
  }
  if (parsed.trailing > 0) out.push('data after the end of the picture');
  return out;
}
