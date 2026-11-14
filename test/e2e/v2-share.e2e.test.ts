import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type Gateway, startGateway } from './helpers.ts';

// Share unseen as the gateway serves it: the share target in the manifest, the filter modules with the
// face detector and its model from this origin, and the fallback for a photo shared in while the app's
// worker is not running (dropped unread, the page says it did not arrive).
const SIGN = readFileSync(resolve(import.meta.dirname, '../unit/fixtures/photos/sign.jpg'));

describe('v2 Share unseen', () => {
  let g: Gateway;
  beforeAll(async () => {
    g = await startGateway();
  });
  afterAll(() => g.close());

  it('names /v2/share as the share target for photos', async () => {
    const m = await (await fetch(`${g.url}/v2/manifest.webmanifest`)).json();
    expect(m.share_target).toMatchObject({ action: '/v2/share', method: 'POST', enctype: 'multipart/form-data' });
    expect(m.share_target.params.files[0].name).toBe('photo');
  });

  it('serves the filter modules, the face detector, its model and its licence from this origin', async () => {
    for (const f of ['strip-details', 'cover-faces', 'cover-numbers']) {
      const man = await (await fetch(`${g.url}/v2/modules/filter/${f}/manifest.json`)).json();
      expect(man.kind, f).toBe('filter');
      expect((await fetch(`${g.url}/v2/modules/filter/${f}/${man.entry}`)).status, f).toBe(200);
    }
    for (const p of ['/v2/modules/filter/cover-faces/boxes.js', '/v2/modules/filter/cover-numbers/textfind.js', '/v2/core/photo.js', '/v2/core/photometa.js', '/v2/core/covers.js', '/v2/core/filters.js', '/v2/screens/photo.js']) expect((await fetch(g.url + p)).status, p).toBe(200);
    const lib = await fetch(`${g.url}/vendor/face-api/face-api.js`);
    expect(lib.status).toBe(200);
    expect(lib.headers.get('content-type')).toMatch(/javascript/);
    const weights = await (await fetch(`${g.url}/vendor/face-api/model/tiny_face_detector_model-weights_manifest.json`)).json();
    expect(weights[0].paths).toEqual(['tiny_face_detector_model.bin']);
    const bin = await fetch(`${g.url}/vendor/face-api/model/tiny_face_detector_model.bin`);
    expect(bin.status).toBe(200);
    expect((await bin.arrayBuffer()).byteLength).toBe(193321);
    expect((await fetch(`${g.url}/vendor/licenses/face-api.txt`)).status).toBe(200);
  });

  it('a photo posted to the share target without the worker is dropped unread and the page opens on "did not arrive"', async () => {
    const form = new FormData();
    form.append('photo', new Blob([SIGN], { type: 'image/jpeg' }), 'IMG_1.jpg');
    const r = await fetch(`${g.url}/v2/share`, { method: 'POST', body: form, redirect: 'manual' });
    expect(r.status).toBe(303);
    expect(r.headers.get('location')).toBe('/v2/#/photo/missed');
    expect(await r.text()).toBe('');
    // Nothing else answers to it.
    expect((await fetch(`${g.url}/v2/share`, { redirect: 'manual' })).status).not.toBe(303);
  });
});
