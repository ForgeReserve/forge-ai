import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decodeJpeg } from './jpeg.ts';

// The face filter's model (YuNet, public/vendor/yunet/), loaded by the real vendored TensorFlow.js from
// each address the app is served at: the website, the Android app (https://localhost) and the iPhone app
// (capacitor://localhost). The page's fetch is a stand-in that serves the vendored files at that address
// only and fails like WebKit ("Load failed") for any other, so a rebuilt or mangled address fails here as
// it did on the iPhone. Then the model finds the three faces in the crew photo on the plain processor.
const PUBLIC = resolve(import.meta.dirname, '../../../public');
const PHOTOS = resolve(import.meta.dirname, '../fixtures/photos');

// face-api picks its platform when it is imported: a page (window and document) makes it use the
// page's fetch, as in the app. Nothing here draws, so the elements are empty stand-ins.
const g = globalThis as any;
g.window ??= g;
g.document ??= { createElement: () => ({}) };
for (const k of ['HTMLImageElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'ImageData', 'CanvasRenderingContext2D', 'Image']) g[k] ??= class {};
// face-api keeps the fetch it finds when it is imported, so the stand-in is in place first and each test
// swaps what it answers.
const realFetch = globalThis.fetch;
let answer: (url: string) => Promise<Response> = () => Promise.reject(new TypeError('Load failed'));
globalThis.fetch = ((u: string | URL) => answer(String(u))) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
});
const api: any = await import(resolve(PUBLIC, 'vendor/face-api/face-api.js') as string);
const YUNET: any = await import(resolve(PUBLIC, 'v2/modules/filter/cover-faces/yunet.js') as string);
const BOXES: any = await import(resolve(PUBLIC, 'v2/modules/filter/cover-faces/boxes.js') as string);
const { SOURCE }: any = await import('../../../scripts/yunet-model.ts');
// The plain processor: Node has no graphics chip.
await api.tf.setBackend('cpu');

/** Serves public/vendor/yunet/* at `origin` only; records every address asked for. */
function serve(origin: string): string[] {
  const asked: string[] = [];
  answer = async (url) => {
    asked.push(url);
    const prefix = `${origin}/vendor/yunet/`;
    if (!url.startsWith(prefix)) throw new TypeError('Load failed');
    return new Response(readFileSync(resolve(PUBLIC, 'vendor/yunet', url.slice(prefix.length))));
  };
  return asked;
}

describe('the face filter’s model (cover-faces)', () => {
  for (const origin of ['capacitor://localhost', 'https://localhost', 'https://ai.example.org']) {
    it(`loads from the app's own files at ${origin}`, async () => {
      const asked = serve(origin);
      const net = await YUNET.loadYunet(api.tf, `${origin}/vendor/yunet/`);
      expect(net.ops.length).toBeGreaterThan(40);
      expect(asked).toEqual([`${origin}/vendor/yunet/yunet.json`, `${origin}/vendor/yunet/yunet.bin`]);
      api.tf.dispose(Object.values(net.w));
    });
  }

  it('says why when the model file is not there', async () => {
    answer = async () => new Response('', { status: 404 });
    await expect(YUNET.loadYunet(api.tf, 'capacitor://localhost/vendor/yunet/')).rejects.toThrow('face model: 404');
  });

  it('is the pinned OpenCV Zoo model, as scripts/yunet-model.ts writes it: 16-bit weights for every layer', () => {
    const json = JSON.parse(readFileSync(resolve(PUBLIC, 'vendor/yunet/yunet.json'), 'utf8'));
    expect(json.about).toContain(SOURCE.sha256);
    expect(json.about).toContain(SOURCE.commit);
    const n = json.weights[0].weights.reduce((s: number, w: any) => s + w.shape.reduce((a: number, b: number) => a * b, 1), 0);
    expect(readFileSync(resolve(PUBLIC, 'vendor/yunet/yunet.bin')).length).toBe(2 * n);
    expect(json.weights[0].weights.every((w: any) => w.quantization.dtype === 'float16')).toBe(true);
    // The licence ships beside the other vendored ones.
    expect(readFileSync(resolve(PUBLIC, 'vendor/licenses/yunet.txt'), 'utf8')).toContain('Copyright (c) 2020 Shiqi Yu');
  });

  it('finds the three faces in the crew photo', async () => {
    serve('https://localhost');
    const net = await YUNET.loadYunet(api.tf, 'https://localhost/vendor/yunet/');
    const img = decodeJpeg(new Uint8Array(readFileSync(resolve(PHOTOS, 'crew.jpg'))));
    // fromPixels takes {width, height, data} as well as a canvas; the crew photo is 960 x 754.
    const pic = { width: img.width, height: img.height, data: new Uint8Array(img.data.buffer, img.data.byteOffset, img.data.byteLength) };
    const faces = BOXES.keepFaces(await YUNET.detectYunet(api.tf, net, pic, BOXES.MIN_SCORE));
    const centres = faces.map((f: any) => [Math.round(f.x + f.w / 2), Math.round(f.y + f.h / 2)]);
    expect(faces).toHaveLength(3);
    for (const [x, y] of [
      [457, 195],
      [700, 344],
      [236, 326],
    ])
      expect(centres.some(([cx, cy]: number[]) => Math.abs(cx! - x!) < 20 && Math.abs(cy! - y!) < 25), `${x},${y}: ${JSON.stringify(centres)}`).toBe(true);
    api.tf.dispose(Object.values(net.w));
  }, 60_000);
});
