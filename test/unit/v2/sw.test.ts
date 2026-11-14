import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { shellFiles } from '../../../src/sw.ts';

// v1 and v2 service workers stay out of each other's way.
const PUBLIC = resolve(import.meta.dirname, '../../../public');
const v1 = readFileSync(resolve(PUBLIC, 'sw.js'), 'utf8');
const v2 = readFileSync(resolve(PUBLIC, 'v2/sw.js'), 'utf8');
const regex = (src: string, name: string) => new Function(`return ${new RegExp(`const ${name} = (/.+/);`).exec(src)![1]}`)() as RegExp;

describe('service workers', () => {
  it('v1 leaves /v2/ alone', () => {
    const bypass = regex(v1, 'BYPASS');
    for (const p of ['/v2', '/v2/', '/v2/app.js', '/v2/sw.js', '/v2/modules/look/light/index.js']) expect(bypass.test(p), p).toBe(true);
    for (const p of ['/', '/app.js', '/js/files.js', '/vendor/marked.js']) expect(bypass.test(p), p).toBe(false);
  });

  it('v1 does not precache any v2 file', () => {
    expect(shellFiles(PUBLIC).some((p) => p.startsWith('/v2'))).toBe(false);
  });

  it('v2 never touches the engine API, and its cache survives v1 clearing its own', () => {
    const never = regex(v2, 'NEVER');
    for (const p of ['/v1/chat/completions', '/v1/wallet', '/attestation', '/.well-known/hpke-keys']) expect(never.test(p), p).toBe(true);
    expect(never.test('/v2/app.js')).toBe(false);
    const cache = /const CACHE = '([^']+)'/.exec(v2)![1]!;
    expect(cache.startsWith('forge-')).toBe(false);
    expect(v2).toMatch(/req\.headers\.has\('authorization'\) \|\| req\.headers\.has\('x-cashu'\)/);
    expect(v2).toMatch(/if \(req\.method !== 'GET'\) return;/);
  });

  it('v2 never re-creates its cache once Erase everything removed it: only install opens it unguarded', () => {
    expect(v2.match(/caches\.open\(CACHE\)/g)).toHaveLength(2);
    expect(v2).toMatch(/\(await caches\.has\(CACHE\)\)\) await \(await caches\.open\(CACHE\)\)\.put\(/);
    expect(v2).not.toMatch(/cache\.match\(/);
  });

  it('v2 leaves the natural voice files to the voice package, which keeps its own copy, but keeps their index', () => {
    const voice = regex(v2, 'VOICE_FILES');
    for (const p of ['/v2/voice/phonon/31m-en-92741c5/model.q8.gguf', '/v2/voice/phonon/voices-0ee1720/6PWnV0Nq4wu7RVBT.safetensors']) expect(voice.test(p), p).toBe(true);
    for (const p of ['/v2/voice/phonon/index.json', '/v2/voice/en/welcome.ogg', '/v2/vendor/phonon-tts/worker.js', '/v2/app.js']) expect(voice.test(p), p).toBe(false);
    expect(v2).toMatch(/NEVER\.test\(url\.pathname\) \|\| VOICE_FILES\.test\(url\.pathname\)\) return;/);
  });
});
