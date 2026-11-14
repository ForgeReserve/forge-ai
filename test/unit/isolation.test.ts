// The v2 app is cross-origin isolated, so the natural voice runs its model on several threads
// (WebAssembly threads need SharedArrayBuffer). v1 pages stay as they were, and the voice files, pinned
// to a commit in their path, are kept by the phone for a year.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createApp, ISOLATION_HEADERS } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { testCatalog } from '../e2e/helpers.ts';

setLogSilent(true);

function site() {
  const dir = mkdtempSync(join(tmpdir(), 'forge-public-'));
  const put = (p: string, body: string) => {
    mkdirSync(join(dir, p, '..'), { recursive: true });
    writeFileSync(join(dir, p), body);
  };
  put('index.html', '<!doctype html><title>v1</title>');
  put('app.js', 'export {};');
  put('sw.js', "const V = '__FORGE_SW_VERSION__';");
  put('v2/index.html', '<!doctype html><title>v2</title>');
  put('v2/app.js', 'export {};');
  put('v2/vendor/phonon-tts/worker.js', 'export {};');
  put('vendor/pdfjs/pdf.worker.min.mjs', 'export {};');
  put('v2/voice/phonon/index.json', '{}');
  put('v2/voice/phonon/31m-en-92741c5/config.json', '{}');
  return dir;
}

function gateway() {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_MARKUP: '1', FORGE_RATE_LIMIT_RPM: '100000', TEST_TINFOIL_KEY: 'k' };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog(1));
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  return createApp({ ...deps, publicDir: site() });
}

const isolatedRes = (r: Response) => Object.entries(ISOLATION_HEADERS).every(([k, v]) => r.headers.get(k) === v);

describe('cross-origin isolation', () => {
  const app = gateway();
  const get = (p: string) => app.request(`http://gw.test${p}`);

  it('isolates the v2 page, its files and the workers it starts', async () => {
    for (const p of ['/v2/', '/v2/app.js', '/v2/vendor/phonon-tts/worker.js', '/vendor/pdfjs/pdf.worker.min.mjs']) {
      const r = await get(p);
      expect(r.status, p).toBe(200);
      expect(isolatedRes(r), p).toBe(true);
    }
    expect(ISOLATION_HEADERS).toEqual({ 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
  });

  it('leaves v1 and the engine API as they were', async () => {
    for (const p of ['/', '/app.js', '/sw.js', '/v1/models']) {
      const r = await get(p);
      expect(r.headers.get('cross-origin-embedder-policy'), p).toBeNull();
      expect(r.headers.get('cross-origin-opener-policy'), p).toBeNull();
    }
  });

  it('lets the phone keep the pinned voice files, but always asks for their index', async () => {
    const file = await get('/v2/voice/phonon/31m-en-92741c5/config.json');
    expect(file.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    const index = await get('/v2/voice/phonon/index.json');
    expect(index.headers.get('cache-control')).toBe('no-cache');
    const missing = await get('/v2/voice/phonon/31m-en-92741c5/nope.gguf');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control') ?? '').not.toMatch(/immutable/);
  });
});
