import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Taking a photo inside the app (core/camera.js): the size asked of the camera, the shape of the still it
// gives (so a sideways one is never used), and the mark that a photo picker was open when the phone
// stopped the app. The camera itself is driven in test/ui/photo-camera.ui.test.ts.
const V2 = resolve(import.meta.dirname, '../../../public/v2');
const PHOTOS = resolve(import.meta.dirname, '../fixtures/photos');
const CREW = new Uint8Array(readFileSync(resolve(PHOTOS, 'crew.jpg')));
const SIGN = new Uint8Array(readFileSync(resolve(PHOTOS, 'sign.jpg')));
const CAM: any = await import(resolve(V2, 'core/camera.js') as string);

const cat = (...parts: (Uint8Array | number[])[]) => Uint8Array.from(parts.flatMap((p) => [...p]));
const seg = (marker: number, body: Uint8Array | number[]) => cat([0xff, marker, (body.length + 2) >> 8, (body.length + 2) & 0xff], body);

/** An Exif block (APP1 body) with only an orientation tag, big or little endian. */
function exifTurn(turn: number, le = false): number[] {
  const w16 = (v: number) => (le ? [v & 0xff, v >> 8] : [v >> 8, v & 0xff]);
  const w32 = (v: number) => (le ? [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, v >>> 24] : [v >>> 24, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]);
  const tiff = [...(le ? [0x49, 0x49] : [0x4d, 0x4d]), ...w16(42), ...w32(8), ...w16(1), ...w16(0x0112), ...w16(3), ...w32(1), ...w16(turn), 0, 0, ...w32(0)];
  return [...Buffer.from('Exif\0\0', 'latin1'), ...tiff];
}

/** The start of a JPEG, w by h, with these segments before its frame header (SOF0). */
const jpegHead = (w: number, h: number, before: Uint8Array[] = [], sof = 0xc0) => cat([0xff, 0xd8], ...before, seg(0xc4, [0, ...new Array(16).fill(0)]), seg(sof, [8, h >> 8, h & 0xff, w >> 8, w & 0xff, 1, 1, 0x11, 0]));

/** The first bytes of a PNG, w by h. */
const pngHead = (w: number, h: number) => cat([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, w >>> 24, (w >> 16) & 0xff, (w >> 8) & 0xff, w & 0xff, h >>> 24, (h >> 16) & 0xff, (h >> 8) & 0xff, h & 0xff, 8, 6, 0, 0, 0]);

/** A Storage in memory. */
function memory(fail = false) {
  const m = new Map<string, string>();
  const no = () => {
    throw new Error('blocked');
  };
  return {
    m,
    getItem: (k: string) => (fail ? no() : (m.get(k) ?? null)),
    setItem: (k: string, v: string) => (fail ? no() : void m.set(k, v)),
    removeItem: (k: string) => (fail ? no() : void m.delete(k)),
  };
}

describe('the in-app camera', () => {
  it('turns from one camera to the other', () => {
    expect(CAM.otherFacing('environment')).toBe('user');
    expect(CAM.otherFacing('user')).toBe('environment');
    expect(CAM.otherFacing(undefined)).toBe('user');
  });

  it('asks for the largest still, or leaves it to the browser when the camera does not say', () => {
    expect(CAM.stillSize({ imageWidth: { min: 160, max: 4080, step: 1 }, imageHeight: { min: 120, max: 3060, step: 1 } })).toEqual({ imageWidth: 4080, imageHeight: 3060 });
    expect(CAM.stillSize({})).toEqual({});
    expect(CAM.stillSize(null)).toEqual({});
    expect(CAM.stillSize({ imageWidth: { max: 0 }, imageHeight: { max: 3060 } })).toEqual({});
  });

  it('takes the stream at its largest picture where there are no stills', () => {
    expect(CAM.largestFrame({ width: { min: 1, max: 4032 }, height: { min: 1, max: 3024 } })).toEqual({ width: 4032, height: 3024 });
    expect(CAM.largestFrame({ width: { max: 1920 } })).toBeNull();
    expect(CAM.largestFrame(undefined)).toBeNull();
  });

  it('reads the shape a still shows at, turned as its Exif says', () => {
    expect(CAM.stillShape(CREW)).toEqual({ width: 960, height: 754 });
    expect(CAM.stillShape(SIGN.subarray(0, 64 * 1024))).toMatchObject({ width: expect.any(Number), height: expect.any(Number) });
    expect(CAM.stillShape(jpegHead(4080, 3060))).toEqual({ width: 4080, height: 3060 });
    for (const le of [false, true]) {
      for (const turn of [1, 2, 3, 4]) expect(CAM.stillShape(jpegHead(4080, 3060, [seg(0xe1, exifTurn(turn, le))])), `${turn} ${le}`).toEqual({ width: 4080, height: 3060 });
      for (const turn of [5, 6, 7, 8]) expect(CAM.stillShape(jpegHead(4080, 3060, [seg(0xe1, exifTurn(turn, le))])), `${turn} ${le}`).toEqual({ width: 3060, height: 4080 });
    }
    // A progressive frame header counts; the Huffman table before it (C4, in the same range) does not.
    expect(CAM.stillShape(jpegHead(800, 600, [], 0xc2))).toEqual({ width: 800, height: 600 });
    expect(CAM.stillShape(pngHead(960, 754))).toEqual({ width: 960, height: 754 });
    // Cut short before the frame header, or not a picture: unknown.
    expect(CAM.stillShape(jpegHead(800, 600).subarray(0, 30))).toBeNull();
    expect(CAM.stillShape(new Uint8Array([1, 2, 3, 4, 5]))).toBeNull();
    expect(CAM.stillShape(new Uint8Array(0))).toBeNull();
  });

  it('uses a still only when it is turned the way the screen showed', () => {
    const portrait = { width: 1440, height: 1920 };
    expect(CAM.turnedAway({ width: 3060, height: 4080 }, portrait)).toBe(false);
    expect(CAM.turnedAway({ width: 4080, height: 3060 }, portrait)).toBe(true);
    expect(CAM.turnedAway({ width: 4080, height: 3060 }, { width: 1920, height: 1440 })).toBe(false);
    expect(CAM.turnedAway({ width: 3000, height: 3000 }, portrait)).toBe(false);
    expect(CAM.turnedAway(null, portrait)).toBe(false);
    expect(CAM.turnedAway({ width: 4080, height: 3060 }, { width: 0, height: 0 })).toBe(false);
  });
});

describe('a photo picker open when the phone stopped the app', () => {
  it('is marked with the time only, and read once', () => {
    const s = memory();
    CAM.markPicking(s, 1_000_000);
    expect([...s.m]).toEqual([[CAM.PICKING_KEY, '1000000']]);
    expect(CAM.PICKING_KEY).toBe('forge2.picking');
    expect(CAM.wasPicking(s, 1_000_000 + 60_000)).toBe(true);
    expect(s.m.size).toBe(0);
    expect(CAM.wasPicking(s, 1_000_000 + 60_000)).toBe(false);
  });

  it('counts for ten minutes after the picker opened, and never from the future', () => {
    const s = memory();
    CAM.markPicking(s, 5_000);
    expect(CAM.wasPicking(s, 5_000 + CAM.PICKING_MS - 1)).toBe(true);
    CAM.markPicking(s, 5_000);
    expect(CAM.wasPicking(s, 5_000 + CAM.PICKING_MS)).toBe(false);
    expect(s.m.size).toBe(0);
    CAM.markPicking(s, 5_000);
    expect(CAM.wasPicking(s, 4_000)).toBe(false);
    s.m.set(CAM.PICKING_KEY, 'junk');
    expect(CAM.wasPicking(s, 5_000)).toBe(false);
    expect(s.m.size).toBe(0);
  });

  it('is taken away when the picker closes, and does nothing without storage', () => {
    const s = memory();
    CAM.markPicking(s);
    CAM.clearPicking(s);
    expect(s.m.size).toBe(0);
    for (const none of [null, undefined, memory(true)]) {
      expect(() => CAM.markPicking(none)).not.toThrow();
      expect(() => CAM.clearPicking(none)).not.toThrow();
      expect(CAM.wasPicking(none)).toBe(false);
    }
  });
});
