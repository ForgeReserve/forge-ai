import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { silentWav } from '../../src/audio.ts';
import { setLogSilent } from '../../src/log.ts';
import { MOCK_TRANSCRIPT } from '../../src/suppliers/mock.ts';
import { AUDIO_PRICES, BTC_USD, chatBody, type Gateway, startGateway, testAudio } from './helpers.ts';

// The audio routes: priced per request from the catalog, paid from a balance, never charged on failure,
// with size and length limits, and no audio or text in the log or the database.

let g: Gateway;
const AUDIO_MAX = 400_000;

beforeAll(async () => {
  g = await startGateway({ audio: true, env: { FORGE_AUDIO_MAX_BYTES: String(AUDIO_MAX), FORGE_MAX_BODY_BYTES: '100000' } });
});
afterAll(() => g?.close());

/** A balance made directly in the ledger (no mint needed): returns its key. */
function balance(msub: number, unit: 'usd' | 'sat' = 'usd'): string {
  const key = 'sk-forge-' + crypto.randomUUID().replaceAll('-', '');
  const a = g.deps.ledger.createAccountRaw(key, unit, null);
  if (msub) g.deps.ledger.creditRaw(a.id, msub, 'test', null);
  return key;
}
const balanceOf = (key: string) => g.deps.ledger.findByKey(key)!.balance_msub;

function transcribe(key: string | null, audio: Uint8Array, fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append('file', new Blob([audio as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', fields.model ?? 'mock-transcribe');
  for (const [k, v] of Object.entries(fields)) if (k !== 'model') form.append(k, v);
  return fetch(`${g.url}/v1/audio/transcriptions`, { method: 'POST', headers: key ? { authorization: `Bearer ${key}` } : {}, body: form });
}

const speak = (key: string | null, body: object) =>
  fetch(`${g.url}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });

/** msub (milli-cents) of a USD price at markup 1, rounded up as the gateway does. */
const usdMsub = (usd: number) => Math.ceil(Math.ceil(usd * 1e9 - 1e-6) / 10_000);

describe('GET /v1/models lists audio apart from chat', () => {
  it('lists each audio model with its kind, tier, limits and prices', async () => {
    const body: any = await (await fetch(`${g.url}/v1/models`)).json();
    expect(body.data.map((m: any) => m.id)).not.toContain('mock-transcribe');
    const t = body.audio.find((m: any) => m.id === 'mock-transcribe');
    expect(t).toMatchObject({ kind: 'transcription', tier: 'enclave', max_seconds: 30, formats: ['wav'], encrypted_passthrough: false });
    expect(t.pricing.usd).toEqual({ request: AUDIO_PRICES.transcribeRequest, second: AUDIO_PRICES.perSecond, kchar: 0 });
    expect(t.pricing.sat.request).toBeCloseTo((AUDIO_PRICES.transcribeRequest / BTC_USD) * 1e8, 6);
    const s = body.audio.find((m: any) => m.id === 'mock-speech');
    expect(s).toMatchObject({ kind: 'speech', max_chars: 200, voices: ['neutral_female', 'neutral_male'], formats: ['wav'] });
    expect(body.audio.find((m: any) => m.id === 'mock-transcribe-standard').tier).toBe('standard');
  });
});

describe('POST /v1/audio/transcriptions', () => {
  it('turns a recording into text and charges per request plus per second', async () => {
    const key = balance(100_000);
    const r = await transcribe(key, silentWav(2, 16000), { duration: '0.1' });
    expect(r.status).toBe(200);
    const body: any = await r.json();
    expect(body.text).toBe(MOCK_TRANSCRIPT);
    expect(body.usage).toEqual({ type: 'duration', seconds: 2 });
    // A WAV file says its own length: the declared 0.1 s does not lower the price.
    const price = usdMsub(AUDIO_PRICES.transcribeRequest + 2 * AUDIO_PRICES.perSecond);
    expect(Number(r.headers.get('x-forge-charged-msub'))).toBe(price);
    expect(Number(r.headers.get('x-forge-balance-msub'))).toBe(100_000 - price);
    expect(r.headers.get('x-forge-privacy')).toBe('enclave-plaintext');
    expect(balanceOf(key)).toBe(100_000 - price);
    const row: any = g.deps.db.prepare('SELECT * FROM requests WHERE id = ?').get(r.headers.get('x-forge-request-id'));
    expect(row).toMatchObject({ status: 'settled', model: 'mock-transcribe', usage_source: 'audio', charged_msub: price, input_tokens: null, output_tokens: null });
    expect(JSON.stringify(row)).not.toContain(MOCK_TRANSCRIPT);
  });

  it('is not charged when the model fails', async () => {
    const key = balance(100_000);
    const r = await transcribe(key, silentWav(2, 16000), { model: 'mock-transcribe-fail' });
    expect(r.status).toBe(502);
    const body: any = await r.json();
    expect(body.error.code).toBe('upstream_error');
    expect(body.error.message).toContain('You were not charged.');
    expect(r.headers.get('x-forge-charged-msub')).toBe('0');
    expect(balanceOf(key)).toBe(100_000);
    expect(g.deps.ledger.reservedMsub(g.deps.ledger.findByKey(key)!.id)).toBe(0);
    const row: any = g.deps.db.prepare('SELECT status, charged_msub FROM requests WHERE id = ?').get(r.headers.get('x-forge-request-id'));
    expect(row).toEqual({ status: 'failed', charged_msub: 0 });
  });

  it('refuses recordings that are too long, too short, too big or not audio, without charging', async () => {
    const key = balance(100_000);
    let r = await transcribe(key, silentWav(31, 4000));
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error.code).toBe('audio_too_long');
    r = await transcribe(key, silentWav(0.1, 16000));
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error.code).toBe('audio_too_short');
    r = await transcribe(key, new TextEncoder().encode('not audio at all, just text'));
    expect(r.status).toBe(415);
    expect(((await r.json()) as any).error.code).toBe('unsupported_audio');
    expect(balanceOf(key)).toBe(100_000);
  });

  it('keeps the larger body limit to this route', async () => {
    // A 413 is sent before the body is read and the server then drops the connection, which would break
    // the next request on a kept-alive socket: each oversized request goes to a gateway of its own.
    const alone = async (path: string, init: (key: string) => RequestInit) => {
      const own = await startGateway({ audio: true, env: { FORGE_AUDIO_MAX_BYTES: String(AUDIO_MAX), FORGE_MAX_BODY_BYTES: '100000' } });
      try {
        const key = 'sk-forge-' + crypto.randomUUID().replaceAll('-', '');
        const a = own.deps.ledger.createAccountRaw(key, 'usd', null);
        own.deps.ledger.creditRaw(a.id, 100_000, 'test', null);
        const r = await fetch(`${own.url}${path}`, init(key));
        const body: any = await r.json();
        expect(own.deps.ledger.findByKey(key)!.balance_msub).toBe(100_000);
        return { status: r.status, code: body?.error?.code };
      } finally {
        await own.close();
      }
    };
    // Over FORGE_AUDIO_MAX_BYTES, though a length the model takes.
    const over = await alone('/v1/audio/transcriptions', (key) => {
      const form = new FormData();
      form.append('file', new Blob([silentWav(13, 16000) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'a.wav');
      form.append('model', 'mock-transcribe');
      return { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form };
    });
    expect(over).toEqual({ status: 413, code: 'request_too_large' });
    // Chat keeps FORGE_MAX_BODY_BYTES (100 kB here), well under the audio limit.
    const chat = JSON.stringify(chatBody('mock-echo', { messages: [{ role: 'user', content: 'x'.repeat(150_000) }] }));
    const big = await alone('/v1/chat/completions', (key) => ({ method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: chat }));
    expect(big).toEqual({ status: 413, code: 'request_too_large' });
  });

  it('refuses an MP3, whose real length its size does not give, without charging', async () => {
    // 200 kB is about 200 s at 8 kbit/s, far over max_seconds, though a declared 1 s and its size at
    // the highest MP3 byte rate (5 s) would both pass. Only WAV, which states its length, is taken.
    const key = balance(100_000);
    for (const head of [[0x49, 0x44, 0x33], [0xff, 0xfb, 0x90]]) {
      const mp3 = new Uint8Array(200_000);
      mp3.set(head);
      const form = new FormData();
      form.append('file', new Blob([mp3], { type: 'audio/mpeg' }), 'a.mp3');
      form.append('model', 'mock-transcribe');
      form.append('duration', '1');
      const r = await fetch(`${g.url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form });
      expect(r.status).toBe(415);
      expect(((await r.json()) as any).error.code).toBe('unsupported_audio');
    }
    expect(balanceOf(key)).toBe(100_000);
  });

  it('needs a balance key and enough funds, and a transcription model', async () => {
    let r = await transcribe(null, silentWav(1, 16000));
    expect(r.status).toBe(401);
    expect(((await r.json()) as any).error.code).toBe('invalid_key');
    const poor = balance(10);
    r = await transcribe(poor, silentWav(1, 16000));
    expect(r.status).toBe(402);
    expect(((await r.json()) as any).error.code).toBe('insufficient_balance');
    expect(balanceOf(poor)).toBe(10);
    r = await transcribe(balance(100_000), silentWav(1, 16000), { model: 'mock-speech' });
    expect(r.status).toBe(404);
    r = await transcribe(balance(100_000), silentWav(1, 16000), { model: 'mock-echo' });
    expect(r.status).toBe(404);
    r = await transcribe(balance(100_000), silentWav(1, 16000), { language: 'english!' });
    expect(r.status).toBe(400);
  });

  it('prices a sat balance at the current rate', async () => {
    const key = balance(1_000_000, 'sat');
    const r = await transcribe(key, silentWav(1, 16000));
    expect(r.status).toBe(200);
    const nano = Math.ceil((AUDIO_PRICES.transcribeRequest + AUDIO_PRICES.perSecond) * 1e9 - 1e-6);
    expect(Number(r.headers.get('x-forge-charged-msub'))).toBe(Math.ceil((nano * 100) / BTC_USD));
    expect(r.headers.get('x-forge-unit')).toBe('sat');
  });
});

describe('POST /v1/audio/speech', () => {
  it('returns WAV audio and charges per request plus per character', async () => {
    const key = balance(100_000);
    const input = 'Bring water.';
    const r = await speak(key, { model: 'mock-speech', input, voice: 'neutral_male' });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('audio/wav');
    expect(r.headers.get('cache-control')).toBe('no-store');
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('RIFF');
    const price = usdMsub(AUDIO_PRICES.speechRequest + (input.length / 1000) * AUDIO_PRICES.perKchar);
    expect(Number(r.headers.get('x-forge-charged-msub'))).toBe(price);
    expect(balanceOf(key)).toBe(100_000 - price);
  });

  it('uses the first voice by default and refuses an unknown voice, other formats and long text', async () => {
    const key = balance(100_000);
    expect((await speak(key, { model: 'mock-speech', input: 'Hi.' })).status).toBe(200);
    const after = balanceOf(key);
    let r = await speak(key, { model: 'mock-speech', input: 'Hi.', voice: 'alloy' });
    expect(r.status).toBe(400);
    r = await speak(key, { model: 'mock-speech', input: 'Hi.', response_format: 'mp3' });
    expect(r.status).toBe(400);
    r = await speak(key, { model: 'mock-speech', input: 'a'.repeat(201) });
    expect(r.status).toBe(413);
    expect(((await r.json()) as any).error.code).toBe('text_too_long');
    // Characters are counted as a person counts them: 200 emoji are 200 characters.
    r = await speak(key, { model: 'mock-speech', input: '🙂'.repeat(200) });
    expect(r.status).toBe(200);
    r = await speak(key, { model: 'mock-speech', input: '   ' });
    expect(r.status).toBe(400);
    r = await speak(key, { model: 'mock-transcribe', input: 'Hi.' });
    expect(r.status).toBe(404);
    expect(balanceOf(key)).toBeLessThan(after);
  });

  it('is not charged when the model fails', async () => {
    const key = balance(100_000);
    const r = await speak(key, { model: 'mock-speech-fail', input: 'Hello.' });
    expect(r.status).toBe(502);
    expect(((await r.json()) as any).error.message).toContain('You were not charged.');
    expect(balanceOf(key)).toBe(100_000);
  });
});

describe('audio guards', () => {
  /** A gateway of its own with a changed catalog, and a funded key on it. */
  async function own(editCatalog: (cat: any) => void) {
    const gw = await startGateway({ audio: true, editCatalog });
    const key = 'sk-forge-' + crypto.randomUUID().replaceAll('-', '');
    const a = gw.deps.ledger.createAccountRaw(key, 'usd', null);
    gw.deps.ledger.creditRaw(a.id, 100_000, 'test', null);
    const form = (model: string) => {
      const f = new FormData();
      f.append('file', new Blob([silentWav(2, 16000) as Uint8Array<ArrayBuffer>], { type: 'audio/wav' }), 'a.wav');
      f.append('model', model);
      return f;
    };
    const rows = () => gw.deps.db.prepare('SELECT status, charged_msub FROM requests WHERE account_id = ?').all(a.id);
    return { gw, key, accountId: a.id, form, rows, balance: () => gw.deps.ledger.findByKey(key)!.balance_msub };
  }

  it('keeps audio from a Tinfoil supplier set to take only encrypted requests, without charging', async () => {
    // The audio routes pass sound and text through the gateway in plain form.
    const o = await own((cat) => {
      cat.suppliers.tinfoil.allowPlaintext = false;
      cat.audio.push(
        { id: 'tinfoil-transcribe', kind: 'transcription', supplier: 'tinfoil', upstream: 'whisper', request_usd: 0.01, price_verified: true, max_seconds: 30 },
        { id: 'tinfoil-speech', kind: 'speech', supplier: 'tinfoil', upstream: 'tts', request_usd: 0.002, price_verified: true, max_chars: 200, voices: ['v'] },
      );
    });
    try {
      const auth = { authorization: `Bearer ${o.key}` };
      let r = await fetch(`${o.gw.url}/v1/audio/transcriptions`, { method: 'POST', headers: auth, body: o.form('tinfoil-transcribe') });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe('encryption_required');
      r = await fetch(`${o.gw.url}/v1/audio/speech`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ model: 'tinfoil-speech', input: 'Hello.' }) });
      expect(r.status).toBe(400);
      expect(((await r.json()) as any).error.code).toBe('encryption_required');
      expect(o.balance()).toBe(100_000);
      expect(o.gw.deps.ledger.reservedMsub(o.accountId)).toBe(0);
      expect(o.rows()).toEqual([]);
    } finally {
      await o.gw.close();
    }
  });

  it('releases the held price when the client goes away mid-request', async () => {
    const o = await own((cat) => cat.audio.push({ ...testAudio()[0], id: 'mock-transcribe-slow', upstream: 'mock-slow' }));
    try {
      const ctrl = new AbortController();
      const sent = fetch(`${o.gw.url}/v1/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${o.key}` }, body: o.form('mock-transcribe-slow'), signal: ctrl.signal }).catch((e) => e);
      // The price is held while the slow model works (5 s).
      await expect.poll(() => o.gw.deps.ledger.reservedMsub(o.accountId), { timeout: 3000 }).toBeGreaterThan(0);
      ctrl.abort();
      expect(((await sent) as Error).name).toBe('AbortError');
      // Released well before the model would have answered: the abort reached the supplier call.
      await expect.poll(() => o.rows(), { timeout: 3000 }).toEqual([{ status: 'failed', charged_msub: 0 }]);
      expect(o.gw.deps.ledger.reservedMsub(o.accountId)).toBe(0);
      expect(o.balance()).toBe(100_000);
    } finally {
      await o.gw.close();
    }
  }, 15_000);
});

describe('audio privacy', () => {
  it('never writes the audio, the text or the transcript to the log or the database', async () => {
    const key = balance(100_000);
    const lines: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const ewrite = process.stderr.write.bind(process.stderr);
    setLogSilent(false);
    (process.stdout as any).write = (s: any) => (lines.push(String(s)), true);
    (process.stderr as any).write = (s: any) => (lines.push(String(s)), true);
    try {
      const secret = 'Meet at the blue door at nine';
      expect((await speak(key, { model: 'mock-speech', input: secret })).status).toBe(200);
      expect((await speak(key, { model: 'mock-speech-fail', input: secret })).status).toBe(502);
      expect((await transcribe(key, silentWav(1, 16000))).status).toBe(200);
      const log = lines.join('');
      expect(log).toContain('"msg":"audio"');
      expect(log).not.toContain(secret);
      expect(log).not.toContain(MOCK_TRANSCRIPT);
      const dump = JSON.stringify(g.deps.db.prepare('SELECT * FROM requests').all());
      expect(dump).not.toContain(secret);
      expect(dump).not.toContain(MOCK_TRANSCRIPT);
    } finally {
      (process.stdout as any).write = write;
      (process.stderr as any).write = ewrite;
      setLogSilent(process.env.FORGE_TEST_LOGS !== '1');
    }
  });
});
