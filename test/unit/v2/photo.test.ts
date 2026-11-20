import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Share unseen: the hidden details in a photo file (read and taken out, with real camera files), cover
// blocks, the writing finder, the face filter's box maths, the filter chain and its list of changes,
// and the share target in the manifest and the service worker.
const V2 = resolve(import.meta.dirname, '../../../public/v2');
const PHOTOS = resolve(import.meta.dirname, '../fixtures/photos');
const SIGN = new Uint8Array(readFileSync(resolve(PHOTOS, 'sign.jpg')));
const CREW = new Uint8Array(readFileSync(resolve(PHOTOS, 'crew.jpg')));
const imp = (p: string) => import(resolve(V2, p) as string) as Promise<any>;
const META = await imp('core/photometa.js');
const COVERS = await imp('core/covers.js');
const FILTERS = await imp('core/filters.js');
const TEXT = await imp('modules/filter/cover-numbers/textfind.js');
const FACES = await imp('modules/filter/cover-faces/boxes.js');
const { decodeJpeg } = await import('./jpeg.ts');
const en: Record<string, string> = (await imp('strings/en.js')).default;

const has = (b: Uint8Array, s: string) => Buffer.from(b).includes(Buffer.from(s, 'latin1'));
const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const seg = (marker: number, body: Uint8Array | number[]) => cat([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff], body);
const str = (s: string) => [...Buffer.from(s, 'latin1')];

/** A big-endian TIFF block with a GPS position (tags 1 to 4) and a camera make. */
function tiffWithGps(): Uint8Array {
  const b: number[] = [0x4d, 0x4d, 0, 42, 0, 0, 0, 8];
  // IFD0 at 8: two entries: Make (ASCII, inline 'Acme'), GPS IFD pointer.
  b.push(0, 2);
  b.push(0x01, 0x0f, 0, 2, 0, 0, 0, 4, ...str('Acme'));
  b.push(0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, 0, 38);
  b.push(0, 0, 0, 0); // no IFD1
  // GPS IFD at 38: one entry, GPSLatitudeRef 'N'.
  b.push(0, 1, 0x00, 0x01, 0, 2, 0, 0, 0, 2, ...str('N'), 0, 0, 0, 0, 0, 0, 0);
  return Uint8Array.from(b);
}

describe('hidden details in a photo file', () => {
  it('reads a real phone photo: where, which phone, when', () => {
    const r = META.readDetails(SIGN);
    expect(r.type).toBe('jpeg');
    expect(r.known).toBe(true);
    for (const d of ['location', 'device', 'time']) expect(r.found).toContain(d);
    expect(has(SIGN, 'SM-S906U1')).toBe(true);
  });

  it('reads a real edited photo: software, dates and the hidden thumbnail', () => {
    expect(META.readDetails(CREW).found).toEqual(['device', 'time', 'thumbnail']);
    expect(META.leftDetails(CREW)).toEqual(['an APP1 segment (exif)', 'an APP2 segment (icc)']);
  });

  it('takes every place for notes out of a JPEG and leaves the picture exactly as it was', () => {
    for (const src of [SIGN, CREW]) {
      const out = META.stripJpeg(src);
      expect(META.readDetails(out)).toEqual({ type: 'jpeg', known: true, found: [] });
      expect(META.leftDetails(out)).toEqual([]);
      for (const s of ['Exif', 'samsung', 'SM-S906U1', 'Photoshop', 'ICC_PROFILE']) expect(has(out, s), s).toBe(false);
      // The picture's own segments (tables, frame, scan) are byte for byte the same.
      const pic = (b: Uint8Array) =>
        META.jpegSegments(b)
          .segs.filter((s: any) => s.marker < 0xe0 || s.marker > 0xef)
          .map((s: any) => Buffer.from(b.subarray(s.start, s.end)).toString('hex'))
          .join('');
      expect(pic(out)).toBe(pic(src));
    }
  });

  it('finds and removes comments, IPTC, extra images, thumbnail headers and data after the end', () => {
    const clean = META.stripJpeg(SIGN);
    const body = clean.subarray(2);
    const odd = cat(
      [0xff, 0xd8],
      seg(0xe0, cat(str('JFXX\0'), [0x10, 1, 2, 3])),
      seg(0xe2, cat(str('MPF\0'), [1, 2])),
      seg(0xed, str('Photoshop 3.0\0name')),
      seg(0xfe, str('taken by Ana')),
      body,
      str('trailing notes'),
    );
    expect(META.readDetails(odd).found).toEqual(['thumbnail', 'other']);
    expect(META.leftDetails(odd)).toHaveLength(5);
    const out = META.stripJpeg(odd);
    expect(Buffer.from(out).equals(Buffer.from(clean))).toBe(true);
    // An Exif block with a GPS position, put into a clean file, is found and taken out again.
    const gps = cat([0xff, 0xd8], seg(0xe1, cat(str('Exif\0\0'), tiffWithGps())), body);
    expect(META.readDetails(gps).found).toEqual(['location', 'device']);
    expect(META.readDetails(META.stripJpeg(gps)).found).toEqual([]);
  });

  it('reads PNG and WebP notes, and says when it cannot read a format', () => {
    const chunk = (type: string, data: Uint8Array | number[]) => cat([0, 0, 0, data.length].map((v, i) => (i === 3 ? data.length & 0xff : 0)), str(type), data, [0, 0, 0, 0]);
    const png = cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], chunk('IHDR', new Uint8Array(13)), chunk('tIME', new Uint8Array(7)), chunk('tEXt', str('Author\0Ana')), chunk('eXIf', tiffWithGps()), chunk('IEND', []));
    expect(META.readDetails(png)).toEqual({ type: 'png', known: true, found: ['location', 'device', 'time', 'other'] });
    const exif = cat(str('Exif\0\0'), tiffWithGps());
    const webp = cat(str('RIFF'), [0, 0, 0, 0], str('WEBP'), str('EXIF'), [exif.length, 0, 0, 0], exif);
    expect(META.readDetails(webp)).toEqual({ type: 'webp', known: true, found: ['location', 'device'] });
    expect(META.readDetails(cat([0, 0, 0, 24], str('ftypheic'), new Uint8Array(16)))).toEqual({ type: 'heic', known: false, found: [] });
    expect(META.readDetails(SIGN.subarray(0, 4000)).known).toBe(false); // cut short
    expect(() => META.stripJpeg(webp)).toThrow(/not a JPEG/);
    expect(META.leftDetails(webp)).toEqual(['not a well formed JPEG']);
  });
});

/** The pixels a cover takes, as a set of y * W + x. */
const taken = (c: any, W: number, H: number) => {
  const out = new Set<number>();
  for (const [y, x0, x1] of COVERS.coverSpans(c, W, H)) for (let x = x0; x < x1; x++) out.add(y * W + x);
  return out;
};
/** True when every pixel of the box (cut to the photo) is under the mask. */
const holds = (mask: Uint8Array, W: number, H: number, b: { x: number; y: number; w: number; h: number }) => {
  const c = COVERS.clampBox(b, W, H);
  for (let y = c.y; y < c.y + c.h; y++) for (let x = c.x; x < c.x + c.w; x++) if (!mask[y * W + x]) return false;
  return true;
};

describe('covers', () => {
  it('a box takes every pixel it touches, cut to the photo', () => {
    expect(COVERS.coverSpans({ x: 2.5, y: 1.2, w: 3, h: 1.5 }, 10, 10)).toEqual([
      [1, 2, 6],
      [2, 2, 6],
    ]);
    expect(COVERS.coverSpans({ x: -3, y: 8, w: 5, h: 5 }, 10, 10)).toEqual([
      [8, 0, 2],
      [9, 0, 2],
    ]);
    expect(COVERS.coverSpans({ x: 12, y: 0, w: 5, h: 5 }, 10, 10)).toEqual([]);
  });

  it('an ellipse takes every pixel any part of it touches, and no pixel it does not touch', () => {
    const W = 64;
    const H = 48;
    for (const e of [
      { cx: 30.3, cy: 20.7, rx: 11.2, ry: 7.9 },
      { cx: 2, cy: 45, rx: 9.5, ry: 6 },
      { cx: 32, cy: 24, rx: 0.4, ry: 0.4 },
    ]) {
      const c = { shape: 'ellipse', ...e };
      const set = taken(c, W, H);
      // Every point of the ellipse inside the photo, on a fine grid, is on a taken pixel.
      for (let y = 0; y < H; y += 0.125)
        for (let x = 0; x < W; x += 0.125) if (((x - e.cx) / e.rx) ** 2 + ((y - e.cy) / e.ry) ** 2 < 1) expect(set.has(Math.floor(y) * W + Math.floor(x)), `${x},${y}`).toBe(true);
      // Every taken pixel has a part inside the ellipse: the cover is no larger than it must be.
      for (const i of set) {
        const px = i % W;
        const py = (i - px) / W;
        const nx = Math.min(Math.max(e.cx, px), px + 1);
        const ny = Math.min(Math.max(e.cy, py), py + 1);
        expect(((nx - e.cx) / e.rx) ** 2 + ((ny - e.cy) / e.ry) ** 2).toBeLessThanOrEqual(1);
      }
    }
  });

  it('pads, clamps, taps and drags', () => {
    expect(COVERS.clampBox({ x: -5, y: 90, w: 20, h: 20 }, 100, 100)).toMatchObject({ x: 0, y: 90, w: 15, h: 10 });
    const tap = COVERS.tapBox(50, 50, 700, 1400);
    expect(tap).toMatchObject({ kind: 'mine', w: 100, h: 100, x: 0, y: 0 });
    expect(COVERS.dragBox(40, 40, 10, 12, 100, 100)).toMatchObject({ kind: 'mine', x: 10, y: 12, w: 30, h: 28 });
    expect(COVERS.dragBox(10, 10, 14, 30, 100, 100)).toBeNull();
  });

  it('finds the top cover under a finger, by its shape, merges overlaps and counts kinds', () => {
    const cs = [
      { kind: 'face', x: 0, y: 0, w: 50, h: 50 },
      { kind: 'mine', x: 40, y: 40, w: 20, h: 20 },
    ];
    expect(COVERS.hitCover(cs, 45, 45)).toBe(1);
    expect(COVERS.hitCover(cs, 10, 10)).toBe(0);
    expect(COVERS.hitCover(cs, 63, 63)).toBe(-1);
    expect(COVERS.hitCover(cs, 63, 63, 4)).toBe(1);
    // An ellipse is hit inside its outline, not in the corners of its bounds.
    const face = { kind: 'face', shape: 'ellipse', cx: 100, cy: 100, rx: 40, ry: 50, x: 60, y: 50, w: 80, h: 100 };
    expect(COVERS.hitCover([face], 100, 145)).toBe(0);
    expect(COVERS.hitCover([face], 64, 54)).toBe(-1);
    expect(COVERS.hitCover([face], 141, 100, 2)).toBe(0);
    expect(COVERS.mergeBoxes([...cs, { x: 90, y: 90, w: 5, h: 5 }])).toEqual([
      { kind: 'face', x: 0, y: 0, w: 60, h: 60 },
      { x: 90, y: 90, w: 5, h: 5 },
    ]);
    expect(COVERS.countKinds([...cs, { kind: 'face' }])).toEqual({ face: 2, writing: 0, mine: 1 });
  });

  it('isFlat tells a solid block from a picture', () => {
    const img = { width: 4, height: 4, data: new Uint8ClampedArray(64) };
    for (let i = 3; i < 64; i += 4) img.data[i] = 255;
    expect(COVERS.isFlat(img, { x: 0, y: 0, w: 4, h: 4 })).toBe(true);
    img.data[(2 * 4 + 2) * 4] = 9;
    expect(COVERS.isFlat(img, { x: 0, y: 0, w: 4, h: 4 })).toBe(false);
    expect(COVERS.isFlat(img, { x: 0, y: 0, w: 4, h: 4 }, [0, 0, 0], 10)).toBe(true);
    expect(COVERS.isFlat(img, { x: 0, y: 0, w: 2, h: 2 })).toBe(true);
  });
});

/** A W x H RGBA picture of coloured noise, the same for the same seed. */
function noise(W: number, H: number, seed = 1) {
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    data.set([60 + ((seed >>> 8) % 80), 90 + ((seed >>> 16) % 60), 30 + ((seed >>> 4) % 100), 255], i * 4);
  }
  return { width: W, height: H, data };
}

describe('cover colours', () => {
  const W = 160;
  const H = 120;
  const covers = [
    { kind: 'face', shape: 'ellipse', cx: 150, cy: 20, rx: 25, ry: 30 },
    { kind: 'writing', x: 20, y: 60, w: 50, h: 14 },
    // Two that overlap, and one inside another.
    { kind: 'mine', x: 60, y: 66, w: 30, h: 30 },
    { kind: 'mine', x: 30, y: 63, w: 6, h: 6 },
  ];

  it('each cover is one flat colour, the middle of the uncovered pixels in a thin ring round it', () => {
    const img = noise(W, H);
    const before = noise(W, H);
    const fills = COVERS.paintCovers(img, covers);
    const mask = COVERS.coverMask(covers, W, H);
    covers.forEach((c, k) => {
      // The ring: pixels within ringWidth of the cover, under no cover, twice as wide until it holds 16.
      // Its middle value, per colour.
      const grown = (r: number) => (c.shape === 'ellipse' ? { ...c, rx: c.rx! + r, ry: c.ry! + r } : { ...c, x: c.x! - r, y: c.y! - r, w: c.w! + 2 * r, h: c.h! + 2 * r });
      let ring: number[] = [];
      let r = COVERS.ringWidth(W, H);
      for (; ; r *= 2) if ((ring = [...taken(grown(r), W, H)].filter((i) => !mask[i])).length >= 16) break;
      // Only the cover inside another one needs a wider ring.
      expect(r > COVERS.ringWidth(W, H)).toBe(k === 3);
      const mid = [0, 1, 2].map((ch) => ring.map((i) => before.data[i * 4 + ch]!).sort((a, b) => a - b)[Math.ceil(ring.length / 2) - 1]);
      expect(fills[k]).toEqual(mid);
    });
    // Painted later, a cover takes its colour over one painted before it; every covered pixel is one of the fills.
    covers.forEach((c, k) => {
      for (const i of taken(c, W, H)) {
        const top = covers.findLastIndex((d) => taken(d, W, H).has(i));
        if (top === k) expect([...img.data.subarray(i * 4, i * 4 + 4)]).toEqual([...fills[k], 255]);
      }
    });
    // Outside the covers the picture is as it was.
    for (let i = 0; i < W * H; i++) if (!mask[i]) expect(img.data.subarray(i * 4, i * 4 + 4)).toEqual(before.data.subarray(i * 4, i * 4 + 4));
  });

  it('whatever is under the covers, the painted picture is the same byte for byte', () => {
    const a = noise(W, H);
    const b = noise(W, H);
    const mask = COVERS.coverMask(covers, W, H);
    // b gets other pixels under every cover: bright, and different from pixel to pixel.
    let changed = 0;
    for (let i = 0; i < W * H; i++)
      if (mask[i]) {
        b.data.set([255, (i * 37) % 256, 255 - ((i * 11) % 256), 255], i * 4);
        changed++;
      }
    expect(changed).toBeGreaterThan(2000);
    COVERS.paintCovers(a, covers);
    COVERS.paintCovers(b, covers);
    expect(Buffer.from(b.data).equals(Buffer.from(a.data))).toBe(true);
    // No pixel of what was under the covers is left: none of b's bright pixels remains.
    for (let i = 0; i < W * H; i++) expect(b.data[i * 4] === 255 && b.data[i * 4 + 2]! > 200).toBe(false);
  });

  it('a cover with no uncovered pixel near it takes a wider ring, and a photo covered whole takes grey', () => {
    const img = noise(40, 30);
    // The only uncovered pixels, the bottom four rows, are one colour.
    for (let i = 26 * 40; i < 30 * 40; i++) img.data.set([10, 200, 30], i * 4);
    const fills = COVERS.paintCovers(img, [
      { kind: 'mine', x: 0, y: 0, w: 40, h: 26 },
      { kind: 'mine', x: 10, y: 10, w: 4, h: 4 },
    ]);
    expect(fills).toEqual([
      [10, 200, 30],
      [10, 200, 30],
    ]);
    expect(COVERS.paintCovers(noise(40, 30), [{ kind: 'mine', x: 0, y: 0, w: 40, h: 30 }])).toEqual([[...COVERS.NEUTRAL_FILL]]);
  });
});

// A 5 x 7 bitmap font for the writing finder's tests: enough letters for a number plate.
const FONT: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
};

/** An RGBA picture of `w` x `h`, a background level with a little noise. */
function picture(w: number, h: number, level = 200) {
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 7;
  for (let i = 0; i < w * h; i++) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const v = level + ((seed >>> 16) % 9) - 4;
    data.set([v, v, v, 255], i * 4);
  }
  return { width: w, height: h, data };
}

/** Writes `text` at (x, y), each font dot `scale` pixels, in grey level `ink`. Returns its box. */
function write(img: ReturnType<typeof picture>, text: string, x: number, y: number, scale: number, ink = 30) {
  let cx = x;
  for (const ch of text) {
    const g = FONT[ch];
    if (g)
      for (let r = 0; r < 7; r++)
        for (let c = 0; c < 5; c++)
          if (g[r]![c] === '1')
            for (let dy = 0; dy < scale; dy++)
              for (let dx = 0; dx < scale; dx++) {
                const i = ((y + r * scale + dy) * img.width + cx + c * scale + dx) * 4;
                img.data.set([ink, ink, ink], i);
              }
    cx += 6 * scale + (ch === ' ' ? scale : 0);
  }
  return { x, y, w: cx - x, h: 7 * scale };
}

const covered = (outer: any, inner: any) => outer.x <= inner.x && outer.y <= inner.y && outer.x + outer.w >= inner.x + inner.w && outer.y + outer.h >= inner.y + inner.h;

describe('the writing finder (cover-numbers)', () => {
  it('finds a number plate, dark on light and light on dark, and covers all of it with a margin', () => {
    const img = picture(800, 600);
    const plate = write(img, 'AB 1234', 120, 140, 4);
    const light = picture(800, 600, 40);
    const sign = write(light, 'K7 31', 300, 400, 5, 235);
    const found = TEXT.findWriting(img);
    expect(found).toHaveLength(1);
    expect(covered(found[0], plate)).toBe(true);
    expect(found[0].w).toBeLessThan(plate.w * 1.5);
    const f2 = TEXT.findWriting(light);
    expect(f2.some((b: any) => covered(b, sign))).toBe(true);
  });

  it('works in the photo’s own pixels when the photo is larger than its working size', () => {
    const img = picture(2400, 1600);
    const plate = write(img, '2173 AB', 900, 1000, 9);
    const found = TEXT.findWriting(img);
    expect(found.some((b: any) => covered(b, plate))).toBe(true);
  });

  it('finds nothing on a plain picture, a soft gradient, or a row of thin posts', () => {
    expect(TEXT.findWriting(picture(640, 480))).toEqual([]);
    const grad = picture(640, 480);
    for (let i = 0; i < 640 * 480; i++) grad.data.fill(Math.round(((i % 640) / 640) * 255), i * 4, i * 4 + 3);
    expect(TEXT.findWriting(grad)).toEqual([]);
    const fence = picture(640, 480);
    for (let x = 40; x < 600; x += 14) for (let y = 200; y < 260; y++) for (let dx = 0; dx < 3; dx++) fence.data.set([20, 20, 20], (y * 640 + x + dx) * 4);
    expect(TEXT.findWriting(fence)).toEqual([]);
    expect(TEXT.findWriting({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toEqual([]);
  });

  it('reaches along a line to letters run together at its end, so the tight block still holds them', () => {
    const img = picture(800, 600);
    const line = write(img, 'AB12', 100, 200, 4);
    // Four 7s with no gap between them: one wide mark, not shaped like a letter.
    const run = { x: line.x + line.w, y: 200, w: 4 * 5 * 4, h: 7 * 4 };
    for (let k = 0; k < 4; k++) write(img, '7', run.x + k * 20, 200, 4);
    const found = TEXT.findWriting(img);
    expect(found).toHaveLength(1);
    expect(covered(found[0], line) && covered(found[0], run)).toBe(true);
  });

  it('joins lines into one block only where it covers little more than the lines', () => {
    // Two lines of a paragraph: one block. Two lines that meet only at a corner: two blocks.
    const para = picture(800, 600);
    const a = write(para, 'AB 1234', 100, 100, 4);
    const b = write(para, 'K7 4321', 100, 136, 4);
    const one = TEXT.findWriting(para);
    expect(one).toHaveLength(1);
    expect(covered(one[0], a) && covered(one[0], b)).toBe(true);
    const stairs = picture(800, 600);
    const c = write(stairs, 'AB 1234', 100, 100, 4);
    const d = write(stairs, 'K7 4321', 100 + c.w - 9, 132, 4);
    const two = TEXT.findWriting(stairs);
    expect(two).toHaveLength(2);
    expect(two.some((x: any) => covered(x, c)) && two.some((x: any) => covered(x, d))).toBe(true);
    // The two blocks cover far less than one block round both would.
    const both = COVERS.coverMask(two, 800, 600).reduce((n: number, v: number) => n + v, 0);
    const x0 = Math.min(...two.map((x: any) => x.x));
    const y0 = Math.min(...two.map((x: any) => x.y));
    const round = (Math.max(...two.map((x: any) => x.x + x.w)) - x0) * (Math.max(...two.map((x: any) => x.y + x.h)) - y0);
    expect(both).toBeLessThan(0.7 * round);
  });

  it('on the sample photos, every mark it takes for writing is under a block fitted closely to it', () => {
    for (const [name, bytes] of [
      ['crew', CREW],
      ['sign', SIGN],
    ] as const) {
      const img = decodeJpeg(bytes);
      const s = Math.min(1, TEXT.WORK_SIDE / Math.max(img.width, img.height));
      const blocks = TEXT.findWriting(img);
      expect(blocks.length, name).toBeGreaterThanOrEqual(2);
      const mask = COVERS.coverMask(blocks, img.width, img.height);
      for (const b of blocks) {
        expect(holds(mask, img.width, img.height, b.found), name).toBe(true);
        for (const m of b.marks) expect(holds(mask, img.width, img.height, m), `${name} ${JSON.stringify(m)}`).toBe(true);
        // The margin round the writing is a third of a letter's height, or two working pixels.
        const pad = Math.max(TEXT.PAD * b.found.h, 2 / s) + 1;
        expect(b.x >= b.found.x - pad && b.y >= b.found.y - pad && b.x + b.w <= b.found.x + b.found.w + pad && b.y + b.h <= b.found.y + b.found.h + pad, `${name} ${JSON.stringify(b)}`).toBe(true);
      }
    }
    // The road sign's "138A" is under a block.
    expect(TEXT.findWriting(decodeJpeg(SIGN)).some((b: any) => b.x <= 243 && b.x + b.w >= 243 && b.y <= 220 && b.y + b.h >= 220)).toBe(true);
  });

  it('on crowd photos, takes no head, window, branch or backpack for a large letter', () => {
    // A row of heads or windows larger than the area each pixel is compared with left rims shaped like an
    // O, side by side like a line of large letters: blocks over sky, buildings and a backpack in the wide
    // protest photo, and over most of the march.
    for (const name of ['protest-wide.jpg', 'march.jpg']) {
      const img = decodeJpeg(new Uint8Array(readFileSync(resolve(PHOTOS, 'crowd', name))));
      const A = img.width * img.height;
      const blocks = TEXT.findWriting(img);
      for (const b of blocks) expect(b.w * b.h, `${name} ${JSON.stringify([b.x, b.y, b.w, b.h])}`).toBeLessThan(0.04 * A);
      expect(COVERS.coverMask(blocks, img.width, img.height).reduce((n: number, v: number) => n + v, 0), name).toBeLessThan(0.12 * A);
    }
    // The backpack in the wide photo, at the bottom of the frame.
    const wide = decodeJpeg(new Uint8Array(readFileSync(resolve(PHOTOS, 'crowd/protest-wide.jpg'))));
    expect(TEXT.findWriting(wide).some((b: any) => b.y + b.h > 700 && b.x < 800 && b.x + b.w > 500)).toBe(false);
  });

  it('is quick enough for a low-end phone: a 2048 px photo in well under a second on this machine', () => {
    const img = picture(2048, 1536);
    write(img, 'AB 1234', 300, 300, 6);
    const t0 = performance.now();
    TEXT.findWriting(img);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('the face filter’s boxes (cover-faces)', () => {
  /** Every pixel of the W x H photo is in at least one tile, and each tile is inside the photo. */
  const tiled = (W: number, H: number, tiles: any[]) => {
    const seen = new Uint8Array(W * H);
    for (const t of tiles) {
      expect(t.x >= 0 && t.y >= 0 && t.x + t.w <= W && t.y + t.h <= H, JSON.stringify(t)).toBe(true);
      for (let y = t.y; y < t.y + t.h; y++) seen.fill(1, y * W + t.x, y * W + t.x + t.w);
    }
    return seen.every((v) => v === 1);
  };

  it('looks at the whole photo, then in overlapping tiles that bring a small face to a size the detector sees', () => {
    // A 12 MP camera photo, opened at 2048 x 1536: the whole photo made to fit one tile, then 4 by 3 tiles
    // at its own size, 640 pixels each.
    const p = FACES.passes(2048, 1536);
    expect(p[0]).toEqual({ x: 0, y: 0, w: 2048, h: 1536, scale: FACES.TILE / 2048 });
    const tiles = p.slice(1);
    expect(tiles).toHaveLength(12);
    for (const t of tiles) expect([t.w, t.h, t.scale]).toEqual([640, 640, 1]);
    expect(tiled(2048, 1536, tiles)).toBe(true);
    // The wide protest photo (1280 x 853) is enlarged 1.6 times: a face 12 pixels across reaches the
    // detector at about 19, where YuNet finds faces from about 10.
    const wide = FACES.passes(1280, 853);
    const z = wide[1].scale;
    expect(z).toBeCloseTo(2048 / 1280);
    expect(12 * z).toBeGreaterThan(18);
    expect(wide.slice(1).every((t: any) => Math.round(t.w * t.scale) === FACES.TILE)).toBe(true);
    expect(tiled(1280, 853, wide.slice(1))).toBe(true);
  });

  it('neighbouring tiles share a fifth of a tile, so a face up to that size is whole in one of them', () => {
    const tiles = FACES.passes(1440, 960).slice(1);
    const xs = [...new Set(tiles.map((t: any) => t.x))].sort((a: any, b: any) => a - b) as number[];
    const w = tiles[0].w;
    for (let i = 1; i < xs.length; i++) expect(xs[i - 1]! + w - xs[i]!).toBeGreaterThanOrEqual(Math.floor(FACES.OVERLAP * w));
  });

  it('enlarges a small photo at most twice, and one that fits a tile is one look', () => {
    const p = FACES.passes(800, 600);
    expect(p.slice(1).every((t: any) => t.scale === FACES.MAX_ZOOM)).toBe(true);
    expect(tiled(800, 600, p.slice(1))).toBe(true);
    expect(FACES.passes(300, 200)).toEqual([{ x: 0, y: 0, w: 300, h: 200, scale: 2 }]);
  });

  it('keeps to MAX_TILES on any shape of photo, lowering the zoom, and still looks at all of it', () => {
    for (const [W, H] of [
      [2048, 2048],
      [2048, 1536],
      [1536, 2048],
      [2048, 300],
      [1440, 1440],
      [4000, 3000],
      [1, 1],
    ] as const) {
      const p = FACES.passes(W, H);
      expect(p.length, `${W}x${H}`).toBeLessThanOrEqual(FACES.MAX_TILES + 1);
      expect(tiled(W, H, p.length > 1 ? p.slice(1) : p), `${W}x${H}`).toBe(true);
    }
    // The square photo is looked at a little smaller than its own size, in 3 by 3 tiles.
    const sq = FACES.passes(2048, 2048);
    expect(sq.length).toBe(10);
    expect(sq[1].scale).toBeLessThan(1);
  });

  it('keeps one box per face, the best scored, and drops weak ones', () => {
    // The same face seen by two tiles, a box inside another, a weak find and a second face.
    const kept = FACES.keepFaces([
      { x: 10, y: 10, w: 50, h: 50, score: 0.7 },
      { x: 12, y: 12, w: 50, h: 50, score: 0.9 },
      { x: 20, y: 20, w: 10, h: 10, score: 0.8 },
      { x: 300, y: 10, w: 40, h: 40, score: 0.4 },
      { x: 500, y: 10, w: 40, h: 40, score: 0.65 },
      { x: 700, y: 10, w: 8, h: 9, score: 0.95 }, // too small for anyone to tell who it is
    ]);
    expect(kept.map((k: any) => k.score)).toEqual([0.9, 0.65]);
    expect(FACES.MIN_SCORE).toBe(0.6);
  });

  it('offers the weak finds the kept faces do not already cover, one per place', () => {
    const faces = [{ x: 100, y: 100, w: 40, h: 40, score: 0.9 }];
    const maybe = FACES.maybeFaces(
      [
        ...faces,
        { x: 104, y: 98, w: 30, h: 44, score: 0.5 }, // the same face, found weakly by a neighbour
        { x: 400, y: 300, w: 14, h: 16, score: 0.5 },
        { x: 401, y: 301, w: 13, h: 15, score: 0.45 }, // the same small spot twice
        { x: 600, y: 300, w: 14, h: 16, score: 0.2 }, // too weak to offer
      ],
      faces,
    );
    expect(maybe.map((m: any) => [m.x, m.y])).toEqual([[400, 300]]);
  });

  it('covers the face with an ellipse round the detector’s box, reaching to the hair, ears and chin', () => {
    const W = 1000;
    const H = 1000;
    const d = { x: 300, y: 300, w: 100, h: 120, score: 0.9 };
    const f = FACES.faceCover(d, W, H);
    expect(f).toMatchObject({ kind: 'face', shape: 'ellipse', cx: 350, found: { x: 300, y: 300, w: 100, h: 120 } });
    const mask = COVERS.coverMask([f], W, H);
    // The whole box, and the box grown by a twentieth of its size.
    expect(holds(mask, W, H, d)).toBe(true);
    expect(holds(mask, W, H, { x: 295, y: 294, w: 110, h: 132 })).toBe(true);
    // Half the box's height above it (hair), three tenths of its width to each side at the eyes (ears),
    // three tenths of its height below it (chin).
    for (const [x, y] of [
      [350, 240],
      [270, 348],
      [430, 348],
      [350, 455],
    ])
      expect(mask[y! * W + x!], `${x},${y}`).toBe(1);
    // Its bounds are the ellipse's, inside the photo.
    expect([f.x, f.y, f.x + f.w, f.y + f.h]).toEqual([Math.floor(f.cx - f.rx), Math.floor(f.cy - f.ry), Math.ceil(f.cx + f.rx), Math.ceil(f.cy + f.ry)]);
    // Tighter than the rectangle round it, and at least the ellipse without the detector's pixels.
    const n = mask.reduce((a: number, v: number) => a + v, 0);
    expect(n).toBeLessThan(0.9 * 4 * f.rx * f.ry);
    expect(n).toBeGreaterThan(Math.PI * (0.8 * 100 + 4) * (0.9 * 120 + 4));
  });

  it('a face the detector was less sure of gets a larger cover', () => {
    const d = { x: 300, y: 300, w: 100, h: 120 };
    const sure = FACES.faceCover({ ...d, score: 0.9 }, 1000, 1000);
    const unsure = FACES.faceCover({ ...d, score: FACES.MIN_SCORE }, 1000, 1000);
    expect(FACES.faceCover({ ...d, score: FACES.SURE_SCORE }, 1000, 1000).rx).toBe(sure.rx);
    expect(unsure.rx).toBeGreaterThan(1.14 * sure.rx);
    expect(unsure.ry).toBeGreaterThan(1.14 * sure.ry);
  });

  it('a face at the photo’s edge, or a very small one, is still covered inside the photo', () => {
    // Half out of the photo at its top left corner, and a face 9 pixels wide at the bottom right.
    const cases: [{ x: number; y: number; w: number; h: number; score: number }, number, number][] = [
      [{ x: -40, y: -50, w: 100, h: 110, score: 0.5 }, 640, 480],
      [{ x: 2040, y: 1528, w: 9, h: 10, score: 0.4 }, 2048, 1536],
    ];
    for (const [d, W, H] of cases) {
      const f = FACES.faceCover(d, W, H);
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= W && f.y + f.h <= H).toBe(true);
      const mask = COVERS.coverMask([f], W, H);
      expect(holds(mask, W, H, d)).toBe(true);
      // Every row and column of the box inside the photo reaches to the edge it is cut at.
      for (const [y, x0, x1] of COVERS.coverSpans(f, W, H)) expect(x0 >= 0 && x1 <= W && y >= 0 && y < H).toBe(true);
    }
    // The small face still gets two of the whole look's pixels round it (about 6 in a 2048 px photo) and a
    // tenth of its size.
    const small = FACES.faceCover({ x: 1000, y: 700, w: 9, h: 10, score: 0.9 }, 2048, 1536);
    expect(small.rx - 0.8 * 9).toBeCloseTo((2 * 2048) / FACES.TILE + 1);
  });
});

describe('the filter chain and the list of changes', () => {
  const photo = { width: 100, height: 80, pixels: null, bytes: SIGN };
  const details = { id: 'd', what: 'details', analyse: async () => ({ found: ['location', 'time'] }), finish: (b: Uint8Array) => cat(b, [1]) };
  const faces = { id: 'f', what: 'faces', analyse: async () => ({ covers: [{ x: 90, y: 70, w: 30, h: 30 }, { x: 5, y: 5, w: 0, h: 9 }] }) };
  const writing = { id: 'w', what: 'writing', analyse: async () => ({ covers: [{ kind: 'writing', x: 1, y: 1, w: 9, h: 9 }, { kind: 'writing', x: 20, y: 1, w: 9, h: 9 }] }) };

  it('runs every filter in order, reports each step, and keeps blocks inside the photo', async () => {
    const seen: string[] = [];
    const r = await FILTERS.runFilters([details, faces, writing], photo, { onStep: (s: any) => seen.push(`${s.id}:${s.state}`) });
    expect(seen).toEqual(['d:running', 'd:done', 'f:running', 'f:done', 'w:running', 'w:done']);
    expect(r.steps.map((s: any) => [s.id, s.ok, s.count])).toEqual([
      ['d', true, 0],
      ['f', true, 1],
      ['w', true, 2],
    ]);
    expect(r.covers[0]).toMatchObject({ kind: 'face', x: 90, y: 70, w: 10, h: 10, by: 'f' });
    expect(new Set(r.covers.map((c: any) => c.id)).size).toBe(3);
    expect(FILTERS.changeRows(r.steps, r.covers)).toEqual([
      { key: 'photo.change.location', state: 'removed' },
      { key: 'photo.change.time', state: 'removed' },
      { key: 'photo.change.face', n: 1, state: 'covered' },
      { key: 'photo.change.writing', n: 2, state: 'covered' },
    ]);
  });

  it('keeps the places a filter was not sure of apart from its blocks, and says Not sure when it covered none', async () => {
    const unsure = { id: 'f', what: 'faces', analyse: async () => ({ covers: [], maybe: [{ x: 90, y: 70, w: 30, h: 30 }, { x: 5, y: 5, w: 0, h: 9 }] }) };
    const r = await FILTERS.runFilters([unsure, writing], photo);
    // The spot is cut to the photo, the empty one dropped, and nothing is painted for it.
    expect(r.steps[0].maybe).toEqual([{ x: 90, y: 70, w: 10, h: 10, kind: 'face', by: 'f' }]);
    expect(r.covers.every((c: any) => c.kind === 'writing')).toBe(true);
    expect(FILTERS.changeRows(r.steps, r.covers)[0]).toEqual({ key: 'photo.change.face', state: 'unsure' });
    // With faces covered as well, the row counts them; with neither, it says None found.
    const both = await FILTERS.runFilters([{ ...unsure, analyse: async () => ({ covers: [{ x: 1, y: 1, w: 9, h: 9 }], maybe: [{ x: 40, y: 40, w: 9, h: 9 }] }) }], photo);
    expect(FILTERS.changeRows(both.steps, both.covers)).toEqual([{ key: 'photo.change.face', n: 1, state: 'covered' }]);
    const none = await FILTERS.runFilters([{ ...unsure, analyse: async () => ({ covers: [] }) }], photo);
    expect(none.steps[0].maybe).toEqual([]);
    expect(FILTERS.changeRows(none.steps, none.covers)).toEqual([{ key: 'photo.change.face', state: 'none' }]);
    expect(en['photo.state.unsure']).toBeTruthy();
  });

  it('a filter that fails or hangs is reported as not checked, and the others still run', async () => {
    const broken = { id: 'f', what: 'faces', analyse: async () => Promise.reject(new Error('no model')) };
    const hangs = { id: 'w', what: 'writing', analyse: () => new Promise(() => {}) };
    const r = await FILTERS.runFilters([broken, hangs, details], photo, { timeoutMs: 50 });
    expect(r.steps.map((s: any) => [s.id, s.ok])).toEqual([
      ['f', false],
      ['w', false],
      ['d', true],
    ]);
    expect(r.steps[1].error).toBe('took too long');
    expect(FILTERS.changeRows(r.steps, r.covers)).toEqual([
      { key: 'photo.change.face', state: 'failed' },
      { key: 'photo.change.writing', state: 'failed' },
      { key: 'photo.change.location', state: 'removed' },
      { key: 'photo.change.time', state: 'removed' },
    ]);
  });

  it('lists blocks taken away, blocks added by hand, and what was not found', async () => {
    const none = { id: 'd', what: 'details', analyse: async () => ({ found: [] }) };
    const unknown = { id: 'd', what: 'details', analyse: async () => ({ found: [], known: false }) };
    const r = await FILTERS.runFilters([none, faces, writing], photo);
    const left = [r.covers[1], FILTERS.withId({ kind: 'mine', x: 0, y: 0, w: 5, h: 5 }), FILTERS.withId({ kind: 'mine', x: 9, y: 0, w: 5, h: 5 })];
    expect(FILTERS.changeRows(r.steps, left)).toEqual([
      { key: 'photo.change.details', state: 'none' },
      { key: 'photo.change.faceTaken', n: 1, state: 'uncovered' },
      { key: 'photo.change.writing', n: 1, state: 'covered' },
      { key: 'photo.change.writingTaken', n: 1, state: 'uncovered' },
      { key: 'photo.change.mine', n: 2, state: 'covered' },
    ]);
    const r2 = await FILTERS.runFilters([unknown, { id: 'x', what: 'faces', analyse: async () => ({}) }], photo);
    expect(FILTERS.changeRows(r2.steps, r2.covers)).toEqual([
      { key: 'photo.change.unknown', state: 'removed' },
      { key: 'photo.change.face', state: 'none' },
    ]);
  });

  it('every row the list can show has its words in the string table', () => {
    for (const k of ['location', 'device', 'time', 'thumbnail', 'other', 'details', 'unknown', 'face', 'writing']) expect(en[`photo.change.${k}`], k).toBeTruthy();
    for (const k of ['face', 'faceTaken', 'writing', 'writingTaken', 'mine']) for (const f of ['one', 'many']) expect(en[`photo.change.${k}.${f}`], `${k}.${f}`).toBeTruthy();
    for (const s of ['removed', 'covered', 'none', 'failed', 'uncovered']) expect(en[`photo.state.${s}`]).toBeTruthy();
    for (const w of ['details', 'faces', 'writing']) expect(en[`photo.step.${w}`]).toBeTruthy();
    expect(en['photo.change.face.many']).toContain('{n}');
  });

  it('cleans the new file with each filter’s finish(), in order', async () => {
    const add = (n: number) => ({ id: String(n), what: 'x', analyse: async () => ({}), finish: (b: Uint8Array) => cat(b, [n]) });
    expect([...(await FILTERS.finishFile([add(1), { id: 'n', what: 'x' }, add(2)], Uint8Array.from([0])))]).toEqual([0, 1, 2]);
  });
});

describe('the bundled filter modules', () => {
  it('run in the order hidden details, faces, writing, and are handed only t', async () => {
    const R = await imp('core/registry.js');
    expect(R.BUNDLED.filter((b: any) => b.kind === 'filter').map((b: any) => b.folder)).toEqual(['strip-details', 'cover-faces', 'cover-numbers']);
    expect(R.INPUTS.filter).toEqual(['t']);
    const mods = await Promise.all(['strip-details', 'cover-faces', 'cover-numbers'].map(async (f) => (await imp(`modules/filter/${f}/index.js`)).create({ t: () => '' })));
    expect(mods.map((m: any) => [m.id, m.what])).toEqual([
      ['strip-details', 'details'],
      ['cover-faces', 'faces'],
      ['cover-numbers', 'writing'],
    ]);
    const d = await mods[0].analyse({ bytes: SIGN });
    expect(d.found).toEqual(expect.arrayContaining(['location', 'device', 'time']));
    expect(META.leftDetails(mods[0].finish(SIGN))).toEqual([]);
    const img = picture(640, 480);
    const plate = write(img, 'AB 12', 60, 100, 4);
    const w = await mods[2].analyse({ pixels: img, width: 640, height: 480 });
    expect(w.covers.some((c: any) => c.kind === 'writing' && covered(c, plate))).toBe(true);
  });

  it('the face filter loads TensorFlow.js and its model only from this app’s own vendor folders', () => {
    const src = readFileSync(resolve(V2, 'modules/filter/cover-faces/index.js'), 'utf8');
    expect(src).toMatch(/new URL\('\.\.\/\.\.\/\.\.\/\.\.\/vendor\/face-api\/face-api\.js', import\.meta\.url\)/);
    expect(src).toMatch(/new URL\('\.\.\/\.\.\/\.\.\/\.\.\/vendor\/yunet\/', import\.meta\.url\)/);
    expect(readFileSync(resolve(V2, 'modules/filter/cover-faces/yunet.js'), 'utf8')).not.toMatch(/https?:\/\//);
    expect(src).not.toMatch(/https?:\/\//);
    const vendor = resolve(V2, '../vendor');
    expect(JSON.parse(readFileSync(resolve(vendor, 'yunet/yunet.json'), 'utf8')).weights[0].paths).toEqual(['yunet.bin']);
    expect(readFileSync(resolve(vendor, 'licenses/yunet.txt'), 'utf8')).toContain('MIT License');
    const lic = readFileSync(resolve(vendor, 'licenses/face-api.txt'), 'utf8');
    for (const s of ['Vladimir Mandic', 'Vincent Mühler', 'TensorFlow.js', 'Apache License']) expect(lic).toContain(s);
    // The bundled library fetches nothing from another address on its own.
    expect(readFileSync(resolve(vendor, 'face-api/face-api.js'), 'utf8')).not.toMatch(/(cdn\.jsdelivr|unpkg\.com|tfhub\.dev|storage\.googleapis)/);
  });
});

describe('shared in from another app', () => {
  const manifest = JSON.parse(readFileSync(resolve(V2, 'manifest.webmanifest'), 'utf8'));
  const sw = readFileSync(resolve(V2, 'sw.js'), 'utf8');

  it('the manifest offers Forge as a share target for photos only', () => {
    expect(manifest.share_target).toEqual({
      action: '/v2/share',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: { files: [{ name: 'photo', accept: ['image/jpeg', 'image/png', 'image/webp', 'image/*'] }] },
    });
  });

  it('the worker catches that POST before anything else and keeps the photo where the page takes it', async () => {
    const P = await imp('core/photo.js');
    expect(sw).toContain(`const SHARE = '${P.SHARE_CACHE}';`);
    expect(sw).toContain(`const SHARE_KEY = '${P.SHARE_KEY}';`);
    expect(sw).toMatch(/req\.method !== 'POST' \|\| url\.origin !== self\.location\.origin \|\| url\.pathname !== '\/v2\/share'/);
    expect(sw).toContain("form.getAll('photo')");
    // The share handler is registered before the handler that passes every non-GET request by.
    expect(sw.indexOf('receiveShare(req)')).toBeLessThan(sw.indexOf("if (req.method !== 'GET') return;"));
    for (const to of ['/v2/#/photo/shared', '/v2/#/photo/none', '/v2/#/photo/missed']) expect(sw).toContain(`Response.redirect('${to}', 303)`);
    const R = await imp('core/router.js');
    expect(['shared', 'none', 'missed'].map((x) => R.parse(`#/photo/${x}`).name)).toEqual(['photoShared', 'photoNone', 'photoMissed']);
  });

  it('a photo the gateway dropped (no worker) has its own route and words, apart from the worker failing', async () => {
    const R = await imp('core/router.js');
    expect(R.parse('#/photo/sent').name).toBe('photoSent');
    expect(R.href('photoSent')).toBe('#/photo/sent');
    expect(R.parentOf('photoSent')).toBe('home');
    const app = readFileSync(resolve(V2, '../../src/app.ts'), 'utf8');
    expect(app).toContain("app.post('/v2/share', (c) => c.redirect('/v2/#/photo/sent', 303));");
    expect(sw).not.toContain('/v2/#/photo/sent');
    expect(en['photo.sent']).toMatch(/sent this photo to the Forge server/);
    expect(en['photo.missed']).toMatch(/did not reach Forge/);
  });

  it('Choose a model for a photo has its own route, under Share unseen', async () => {
    const R = await imp('core/router.js');
    expect(R.parse('#/photo/model')).toEqual({ name: 'modelPhoto', params: {} });
    expect(R.href('modelPhoto')).toBe('#/photo/model');
    // With no history (the page opened on it), Back goes to Share unseen.
    expect(R.parentOf('modelPhoto')).toBe('photo');
  });

  it('a new worker activating clears its old caches but keeps a shared photo waiting for the page', async () => {
    const store = new Set(['forge2-runtime-v0', 'forge2-share', 'forge2-runtime-v1', 'forge-shell-v9']);
    const on: Record<string, ((e: any) => void)[]> = {};
    const self = { addEventListener: (k: string, f: (e: any) => void) => (on[k] ??= []).push(f), clients: { claim: async () => {} }, skipWaiting: async () => {}, location: { origin: 'https://forge.test' } };
    const caches = { keys: async () => [...store], delete: async (k: string) => store.delete(k) };
    new Function('self', 'caches', sw)(self, caches);
    const waits: Promise<unknown>[] = [];
    for (const f of on.activate!) f({ waitUntil: (p: Promise<unknown>) => waits.push(p) });
    await Promise.all(waits);
    expect([...store].sort()).toEqual(['forge-shell-v9', 'forge2-runtime-v1', 'forge2-share']);
  });

  it('the page takes the shared photo once and deletes the copy, even when reading it fails', async () => {
    const P = await imp('core/photo.js');
    const store = new Map<string, Map<string, any>>();
    const fake = {
      async match(key: string, { cacheName }: { cacheName: string }) {
        return store.get(cacheName)?.get(key);
      },
      async delete(name: string) {
        return store.delete(name);
      },
    };
    expect(await P.takeShared(fake)).toBeNull();
    store.set(P.SHARE_CACHE, new Map([[P.SHARE_KEY, new Response(new Blob([SIGN], { type: 'image/jpeg' }))]]));
    const f = await P.takeShared(fake);
    expect(f.type).toBe('image/jpeg');
    expect(new Uint8Array(await f.arrayBuffer())).toEqual(SIGN);
    expect(store.has(P.SHARE_CACHE)).toBe(false);
    store.set(P.SHARE_CACHE, new Map([[P.SHARE_KEY, { blob: () => Promise.reject(new Error('gone')) }]]));
    await expect(P.takeShared(fake)).rejects.toThrow('gone');
    expect(store.has(P.SHARE_CACHE)).toBe(false);
  });
});
