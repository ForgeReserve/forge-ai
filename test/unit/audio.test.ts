import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { billedSeconds, charCount, MP3_MAX_BYTES_PER_SECOND, silentWav, sniffFormat, wavInfo } from '../../src/audio.ts';
import { type AudioModelConfig, CatalogSchema, loadConfig } from '../../src/config.ts';
import { audioCostNanoUsd } from '../../src/pricing.ts';
import { OpenAISupplier } from '../../src/suppliers/openai.ts';
import { TinfoilSupplier, USAGE_REQUEST_HEADER } from '../../src/suppliers/tinfoil.ts';

// Audio: reading a recording's length, pricing per request, the catalog's audio list, and the request
// the OpenAI-compatible supplier sends upstream (checked against a local stub).

describe('recording length', () => {
  it('reads a WAV header', () => {
    const w = wavInfo(silentWav(2.5, 16000))!;
    expect(w).toMatchObject({ sampleRate: 16000, channels: 1, bitsPerSample: 16 });
    expect(w.seconds).toBeCloseTo(2.5, 5);
  });

  it('counts the data actually present when the header claims more', () => {
    const full = silentWav(4, 8000);
    const cut = full.slice(0, 44 + 8000 * 2); // one second of the four
    expect(wavInfo(cut)!.seconds).toBeCloseTo(1, 5);
  });

  it('skips other chunks before the data', () => {
    const base = silentWav(1, 8000);
    const extra = new Uint8Array(12);
    extra.set([0x4c, 0x49, 0x53, 0x54]); // LIST
    new DataView(extra.buffer).setUint32(4, 4, true);
    const withList = new Uint8Array([...base.slice(0, 36), ...extra, ...base.slice(36)]);
    expect(wavInfo(withList)!.seconds).toBeCloseTo(1, 5);
  });

  it('tells WAV, MP3 and anything else apart', () => {
    expect(sniffFormat(silentWav(1))).toBe('wav');
    expect(sniffFormat(new Uint8Array([0x49, 0x44, 0x33, 4, 0]))).toBe('mp3');
    expect(sniffFormat(new Uint8Array([0xff, 0xfb, 0x90, 0]))).toBe('mp3');
    expect(sniffFormat(new TextEncoder().encode('RIFF....WAVEnope'))).toBeUndefined();
    expect(sniffFormat(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });

  it('bills a WAV by its header and an MP3 by the longer of declared and least possible', () => {
    expect(billedSeconds(silentWav(3, 16000), 'wav', 0.5)).toBeCloseTo(3, 5);
    const mp3 = new Uint8Array(MP3_MAX_BYTES_PER_SECOND * 4);
    expect(billedSeconds(mp3, 'mp3', 1)).toBe(4);
    expect(billedSeconds(mp3, 'mp3', 9)).toBe(9);
    expect(billedSeconds(mp3, 'mp3', Number.NaN)).toBe(4);
    expect(billedSeconds(mp3, 'mp3', -5)).toBe(4);
  });

  it('counts characters as a person does', () => {
    expect(charCount('héllo')).toBe(5);
    expect(charCount('🙂🙂')).toBe(2);
  });
});

describe('audio pricing', () => {
  const m = { request_usd: 0.01, usd_per_second: 0.001, usd_per_kchar: 0.5 };
  it('adds the request price, seconds and characters, then the markup, rounded up', () => {
    expect(audioCostNanoUsd(m, { seconds: 2 }, 1)).toBe(12_000_000);
    expect(audioCostNanoUsd(m, { chars: 100 }, 1)).toBe(60_000_000);
    expect(audioCostNanoUsd(m, { seconds: 2 }, 1.25)).toBe(15_000_000);
    expect(audioCostNanoUsd({ request_usd: 0, usd_per_second: 0.000_000_001_5, usd_per_kchar: 0 }, { seconds: 1 }, 1)).toBe(2);
    expect(audioCostNanoUsd({ request_usd: 0.002, usd_per_second: 0, usd_per_kchar: 0 }, {}, 1)).toBe(2_000_000);
  });
});

describe('the catalog audio list', () => {
  const base = {
    suppliers: { s: { type: 'mock', tier: 'enclave' }, k: { type: 'openai', tier: 'standard', baseUrl: 'https://x.test/v1', apiKeyEnv: 'K_KEY' } },
    models: [{ id: 'chat', supplier: 's', upstream: 'c', input_usd_per_mtok: 1, output_usd_per_mtok: 1 }],
  };
  it('is optional and defaults to empty', () => {
    expect(CatalogSchema.parse(base).audio).toEqual([]);
  });
  it('refuses a speech model without voices, an unknown supplier and a duplicate id', () => {
    const bad = (audio: object[]) => CatalogSchema.safeParse({ ...base, audio }).success;
    expect(bad([{ id: 'tts', kind: 'speech', supplier: 's', upstream: 'x' }])).toBe(false);
    expect(bad([{ id: 'stt', kind: 'transcription', supplier: 'nope', upstream: 'x' }])).toBe(false);
    expect(bad([{ id: 'chat', kind: 'transcription', supplier: 's', upstream: 'x' }])).toBe(false);
    expect(bad([{ id: 'stt', kind: 'transcription', supplier: 's', upstream: 'x', formats: ['ogg'] }])).toBe(false);
    expect(bad([{ id: 'stt', kind: 'transcription', supplier: 's', upstream: 'x' }])).toBe(true);
  });
  it('leaves out audio models whose supplier has no key, like chat models', () => {
    const cat = { ...base, audio: [{ id: 'a', kind: 'transcription', supplier: 's', upstream: 'x' }, { id: 'b', kind: 'transcription', supplier: 'k', upstream: 'x' }] };
    const env = { FORGE_DB_PATH: ':memory:' } as NodeJS.ProcessEnv;
    expect(loadConfig(env, cat).catalog.audio.map((m) => m.id)).toEqual(['a']);
    expect(loadConfig({ ...env, K_KEY: 'k' }, cat).catalog.audio.map((m) => m.id)).toEqual(['a', 'b']);
  });
  it('ships Tinfoil audio models in the production catalog with the prices Tinfoil lists', async () => {
    const { readFileSync } = await import('node:fs');
    const cat = CatalogSchema.parse(JSON.parse(readFileSync(new URL('../../config/models.json', import.meta.url), 'utf8')));
    const stt = cat.audio.find((m) => m.kind === 'transcription')!;
    const tts = cat.audio.find((m) => m.kind === 'speech')!;
    expect(stt).toMatchObject({ supplier: 'tinfoil', upstream: 'whisper-large-v3-turbo', request_usd: 0.01, price_verified: true });
    expect(tts).toMatchObject({ supplier: 'tinfoil', upstream: 'voxtral-tts', request_usd: 0.002, price_verified: true });
    expect(tts.voices).toContain('neutral_female');
  });
});

describe('OpenAI-compatible audio requests', () => {
  let server: http.Server;
  let url: string;
  const seen: Array<{ path: string; headers: http.IncomingHttpHeaders; body: Buffer }> = [];
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        seen.push({ path: req.url!, headers: req.headers, body: Buffer.concat(chunks) });
        if (req.url!.endsWith('/audio/transcriptions')) return res.writeHead(200, { 'content-type': 'application/json' }).end('{"text":"hi"}');
        res.writeHead(200, { 'content-type': 'audio/wav' }).end(Buffer.from(silentWav(0.1)));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  });
  afterAll(() => server.close());

  const model = (kind: 'transcription' | 'speech'): AudioModelConfig => ({
    id: 'm',
    kind,
    supplier: 'x',
    upstream: kind === 'speech' ? 'voxtral-tts' : 'whisper-large-v3-turbo',
    request_usd: 0,
    usd_per_second: 0,
    usd_per_kchar: 0,
    price_verified: true,
    max_seconds: 60,
    max_chars: 1000,
    formats: ['wav'],
    voices: ['neutral_female'],
    languages: [],
  });
  const retry = { retries: 0, timeoutMs: 5000 };

  it('sends a transcription as multipart with the model, the file and json', async () => {
    const s = new OpenAISupplier('x', { type: 'openai', tier: 'standard', baseUrl: url, apiKeyEnv: 'KEY' } as any, { KEY: 'secret' }, retry);
    const res = await s.transcribe({ model: model('transcription'), audio: silentWav(1, 16000), format: 'wav', language: 'en', signal: new AbortController().signal });
    expect(await res.json()).toEqual({ text: 'hi' });
    const r = seen.at(-1)!;
    expect(r.path).toBe('/v1/audio/transcriptions');
    expect(r.headers.authorization).toBe('Bearer secret');
    expect(r.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/);
    const text = r.body.toString('latin1');
    expect(text).toMatch(/name="model"\r\n\r\nwhisper-large-v3-turbo\r\n/);
    expect(text).toMatch(/name="response_format"\r\n\r\njson\r\n/);
    expect(text).toMatch(/name="language"\r\n\r\nen\r\n/);
    expect(text).toMatch(/name="file"; filename="audio\.wav"\r\nContent-Type: audio\/wav/);
    expect(text).toContain('RIFF');
  });

  it('sends speech as JSON asking for WAV, and Tinfoil adds its usage header', async () => {
    const s = new TinfoilSupplier('t', { type: 'tinfoil', tier: 'enclave', baseUrl: url, apiKeyEnv: 'KEY', enclaveHosts: ['127.0.0.1'], allowPlaintext: true, allowInsecureEnclave: true } as any, { KEY: 'secret' }, retry);
    const res = await s.speech({ model: model('speech'), input: 'Hello.', voice: 'neutral_female', signal: new AbortController().signal });
    expect(res.headers.get('content-type')).toBe('audio/wav');
    const r = seen.at(-1)!;
    expect(r.path).toBe('/v1/audio/speech');
    expect(JSON.parse(r.body.toString())).toEqual({ model: 'voxtral-tts', input: 'Hello.', voice: 'neutral_female', response_format: 'wav' });
    expect(r.headers[USAGE_REQUEST_HEADER]).toBe('true');
  });

  it('refuses to call without an API key', async () => {
    const s = new OpenAISupplier('x', { type: 'openai', tier: 'standard', baseUrl: url, apiKeyEnv: 'KEY' } as any, {}, retry);
    await expect(s.speech({ model: model('speech'), input: 'x', voice: 'neutral_female', signal: new AbortController().signal })).rejects.toThrow(/no API key/);
  });
});
