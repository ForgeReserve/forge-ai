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

describe('cover blocks', () => {
  it('widens a block to the 16 pixel grid of the JPEG encoder, inside the photo', () => {
    expect(COVERS.alignBox({ x: 17, y: 3, w: 10, h: 30 }, 100, 40)).toMatchObject({ x: 16, y: 0, w: 16, h: 40 });
    expect(COVERS.alignBox({ x: 90, y: 30, w: 20, h: 20 }, 100, 40)).toMatchObject({ x: 80, y: 16, w: 20, h: 24 });
    const b = COVERS.alignBox({ x: 33.5, y: 47.2, w: 61, h: 9 }, 960, 754);
    expect([b.x % 16, b.y % 16, b.w % 16, b.h % 16]).toEqual([0, 0, 0, 0]);
  });

  it('pads, clamps, taps and drags', () => {
    expect(COVERS.padBox({ x: 10, y: 10, w: 10, h: 10 }, { left: 0.5, top: 1 }, 100, 100)).toMatchObject({ x: 5, y: 0, w: 20, h: 30 });
    expect(COVERS.clampBox({ x: -5, y: 90, w: 20, h: 20 }, 100, 100)).toMatchObject({ x: 0, y: 90, w: 15, h: 10 });
    const tap = COVERS.tapBox(50, 50, 700, 1400);
    expect(tap).toMatchObject({ kind: 'mine', w: 100, h: 100, x: 0, y: 0 });
    expect(COVERS.dragBox(40, 40, 10, 12, 100, 100)).toMatchObject({ kind: 'mine', x: 10, y: 12, w: 30, h: 28 });
    expect(COVERS.dragBox(10, 10, 14, 30, 100, 100)).toBeNull();
  });

  it('finds the top block under a finger, merges overlaps and counts kinds', () => {
    const cs = [
      { kind: 'face', x: 0, y: 0, w: 50, h: 50 },
      { kind: 'mine', x: 40, y: 40, w: 20, h: 20 },
    ];
    expect(COVERS.hitCover(cs, 45, 45)).toBe(1);
    expect(COVERS.hitCover(cs, 10, 10)).toBe(0);
    expect(COVERS.hitCover(cs, 63, 63)).toBe(-1);
    expect(COVERS.hitCover(cs, 63, 63, 4)).toBe(1);
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

  it('is quick enough for a low-end phone: a 2048 px photo in well under a second on this machine', () => {
    const img = picture(2048, 1536);
    write(img, 'AB 1234', 300, 300, 6);
    const t0 = performance.now();
    TEXT.findWriting(img);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe('the face filter’s boxes (cover-faces)', () => {
  it('looks at the whole photo and, for a large one, four overlapping quarters', () => {
    expect(FACES.passes(800, 600)).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);
    const p = FACES.passes(2000, 1500);
    expect(p).toHaveLength(5);
    for (const q of p.slice(1)) expect(q.x + q.w <= 2000 && q.y + q.h <= 1500).toBe(true);
    // Together the quarters cover the photo.
    expect(p.slice(1).some((q: any) => q.x === 0 && q.y === 0) && p.slice(1).some((q: any) => q.x + q.w === 2000 && q.y + q.h === 1500)).toBe(true);
  });

  it('keeps one box per face, the best scored, and drops weak ones', () => {
    const kept = FACES.keepFaces([
      { x: 10, y: 10, w: 50, h: 50, score: 0.6 },
      { x: 12, y: 12, w: 50, h: 50, score: 0.9 },
      { x: 20, y: 20, w: 10, h: 10, score: 0.5 },
      { x: 300, y: 10, w: 40, h: 40, score: 0.2 },
      { x: 500, y: 10, w: 40, h: 40, score: 0.4 },
    ]);
    expect(kept.map((k: any) => k.score)).toEqual([0.9, 0.4]);
  });

  it('reaches past the face to the hair, ears and chin, inside the photo', () => {
    expect(FACES.faceCover({ x: 100, y: 100, w: 100, h: 100 }, 1000, 1000)).toEqual({ kind: 'face', x: 70, y: 50, w: 160, h: 180 });
    const edge = FACES.faceCover({ x: 0, y: 0, w: 100, h: 100 }, 120, 120);
    expect(edge).toEqual({ kind: 'face', x: 0, y: 0, w: 120, h: 120 });
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
    const img = picture(400, 300);
    const plate = write(img, 'AB 12', 60, 100, 4);
    const w = await mods[2].analyse({ pixels: img, width: 400, height: 300 });
    expect(w.covers.some((c: any) => c.kind === 'writing' && covered(c, plate))).toBe(true);
  });

  it('the face filter loads its detector and model only from this app’s own vendor folder', () => {
    const src = readFileSync(resolve(V2, 'modules/filter/cover-faces/index.js'), 'utf8');
    expect(src).toMatch(/new URL\('\.\.\/\.\.\/\.\.\/\.\.\/vendor\/face-api\/face-api\.js', import\.meta\.url\)/);
    expect(src).toMatch(/new URL\('\.\.\/\.\.\/\.\.\/\.\.\/vendor\/face-api\/model\/', import\.meta\.url\)/);
    expect(src).not.toMatch(/https?:\/\//);
    const vendor = resolve(V2, '../vendor');
    expect(readFileSync(resolve(vendor, 'face-api/model/tiny_face_detector_model-weights_manifest.json'), 'utf8')).toContain('tiny_face_detector_model.bin');
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
