import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

// The face filter's model, loaded by the real vendored face-api from each address the app is served
// at: the website, the Android app (https://localhost) and the iPhone app (capacitor://localhost). The
// page's fetch is a stand-in that serves the vendored files at that address only and fails like WebKit
// ("Load failed") for any other, so a rebuilt or mangled address fails here as it did on the iPhone.
const PUBLIC = resolve(import.meta.dirname, '../../../public');

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
const FACES: any = await import(resolve(PUBLIC, 'v2/modules/filter/cover-faces/index.js') as string);
// The plain processor: Node has no graphics chip, and the weights only need a place to live.
await api.tf.setBackend('cpu');

/** Serves public/vendor/face-api/model/* at `origin` only; records every address asked for. */
function serve(origin: string): string[] {
  const asked: string[] = [];
  answer = async (url) => {
    asked.push(url);
    const prefix = `${origin}/vendor/face-api/model/`;
    if (!url.startsWith(prefix)) throw new TypeError('Load failed');
    return new Response(readFileSync(resolve(PUBLIC, 'vendor/face-api/model', url.slice(prefix.length))));
  };
  return asked;
}

describe('the face filter’s model (cover-faces)', () => {
  for (const origin of ['capacitor://localhost', 'https://localhost', 'https://ai.example.org']) {
    it(`loads from the app's own files at ${origin}`, async () => {
      const asked = serve(origin);
      api.nets.tinyFaceDetector.dispose();
      expect(api.nets.tinyFaceDetector.isLoaded).toBe(false);
      await FACES.loadModel(api, `${origin}/vendor/face-api/model/`);
      expect(api.nets.tinyFaceDetector.isLoaded).toBe(true);
      expect(asked).toEqual([`${origin}/vendor/face-api/model/tiny_face_detector_model-weights_manifest.json`, `${origin}/vendor/face-api/model/tiny_face_detector_model.bin`]);
    });
  }

  it('says why when the model file is not there', async () => {
    answer = async () => new Response('', { status: 404 });
    await expect(FACES.loadModel(api, 'capacitor://localhost/vendor/face-api/model/')).rejects.toThrow('face model: 404');
  });
});
