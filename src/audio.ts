/**
 * Audio routes: POST /v1/audio/transcriptions (speech to text) and POST /v1/audio/speech (text to speech),
 * OpenAI-compatible, behind the Supplier interface.
 *
 * Paid from a balance like chat: the price of the request is held first and charged only when the
 * supplier answers with a result; a failure is not charged. Priced per request from the catalog's
 * `audio` list: the supplier's cost per request plus per second of audio in, or per 1,000 characters out.
 *
 * Audio and text are held in memory only, for the length of the request. Nothing here logs or stores
 * them: the log line and the `requests` row carry the model, seconds or characters, price and status.
 */
import { randomUUID } from 'node:crypto';
import type { Context, Hono } from 'hono';
import type { AudioModelConfig, Config, Unit } from './config.ts';
import { now, type DB } from './db.ts';
import { type Account, type Ledger, LedgerError } from './ledger.ts';
import { errText, log } from './log.ts';
import { type AudioUsage, audioCostNanoUsd, nanoUsdToMsub } from './pricing.ts';
import type { RateOracle } from './rates.ts';
import { type Supplier, UpstreamError } from './suppliers/types.ts';

export const TRANSCRIPTIONS_PATH = '/v1/audio/transcriptions';
export const SPEECH_PATH = '/v1/audio/speech';

/** The fewest seconds a recording may have: shorter is a tap, not a question. */
export const MIN_SECONDS = 0.3;
/** The most audio bytes accepted back from a speech supplier. */
export const MAX_SPEECH_BYTES = 50_000_000;

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataBytes: number;
  seconds: number;
}

/** Reads a RIFF/WAVE header (PCM or float). Returns undefined when the bytes are not a WAV file. */
export function wavInfo(b: Uint8Array): WavInfo | undefined {
  if (b.length < 12) return undefined;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return undefined;
  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    const body = o + 8;
    if (id === 'fmt ' && size >= 16 && body + 16 <= b.length) {
      fmt = { channels: dv.getUint16(body + 2, true), sampleRate: dv.getUint32(body + 4, true), bits: dv.getUint16(body + 14, true) };
    } else if (id === 'data') {
      if (!fmt || !fmt.channels || !fmt.sampleRate || !fmt.bits) return undefined;
      // A streamed WAV may carry a placeholder size; count what is actually there.
      const dataBytes = Math.min(size, b.length - body);
      const frame = fmt.channels * (fmt.bits / 8);
      return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, dataBytes, seconds: dataBytes / frame / fmt.sampleRate };
    }
    o = body + size + (size % 2);
  }
  return undefined;
}

/**
 * wav, mp3 or undefined, from the first bytes. Only WAV is taken: it states its own length, so the
 * length billed and checked against max_seconds is the real one. MP3 is told apart only to refuse it.
 */
export function sniffFormat(b: Uint8Array): 'wav' | 'mp3' | undefined {
  if (wavInfo(b)) return 'wav';
  if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) return 'mp3'; // ID3 tag
  if (b.length >= 2 && b[0] === 0xff && (b[1]! & 0xe0) === 0xe0) return 'mp3'; // frame sync
  return undefined;
}

/** The seconds a WAV recording is billed for: the length its header gives, whatever the client declares. */
export function billedSeconds(b: Uint8Array): number {
  return wavInfo(b)?.seconds ?? 0;
}

/** A WAV file of silence (16-bit mono PCM), for the mock supplier. */
export function silentWav(seconds: number, sampleRate = 8000): Uint8Array {
  const samples = Math.max(1, Math.round(seconds * sampleRate));
  const out = new Uint8Array(44 + samples * 2);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => [...s].forEach((ch, i) => (out[o + i] = ch.charCodeAt(0)));
  put(0, 'RIFF');
  dv.setUint32(4, 36 + samples * 2, true);
  put(8, 'WAVE');
  put(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true);
  dv.setUint16(34, 16, true);
  put(36, 'data');
  dv.setUint32(40, samples * 2, true);
  return out;
}

/** Characters as a person counts them (code points, not UTF-16 units). */
export const charCount = (s: string): number => [...s].length;

export interface AudioDeps {
  config: Config;
  db: DB;
  ledger: Ledger;
  rates: RateOracle;
  suppliers: Map<string, Supplier>;
}

type ApiError = (c: Context, status: number, code: string, message: string, headers?: Record<string, string>) => Response;

const LANGUAGE = /^[a-z]{2,3}$/;

export function registerAudioRoutes(app: Hono, d: AudioDeps, apiError: ApiError, bearer: (c: Context) => string | undefined): void {
  const { config, db, ledger, rates, suppliers } = d;
  const env = config.env;
  const byId = new Map(config.catalog.audio.map((m) => [m.id, m]));

  const account = (c: Context): Account => {
    const key = bearer(c);
    const a = key ? ledger.findByKey(key) : undefined;
    if (!a) throw new LedgerError('invalid_key', 'audio is paid from a balance: send Authorization: Bearer sk-forge-...', 401);
    // Free questions (credits) pay for typed questions on the free model list only (docs/FREE-TIER.md).
    if (a.free) throw new LedgerError('not_free_model', 'free questions do not cover speech; use a paid balance', 403);
    return a;
  };

  const modelFor = (c: Context, id: unknown, kind: AudioModelConfig['kind']) => {
    const m = typeof id === 'string' ? byId.get(id) : undefined;
    if (!m || m.kind !== kind) return { error: apiError(c, 404, 'model_not_found', `unknown ${kind} model ${String(id)}; see audio in GET /v1/models`) };
    const s = config.catalog.suppliers[m.supplier]!;
    const supplier = suppliers.get(m.supplier);
    if (!supplier || !(kind === 'transcription' ? supplier.transcribe : supplier.speech)) return { error: apiError(c, 400, 'invalid_request', `supplier ${m.supplier} has no ${kind} route`) };
    // The audio passes through the gateway in plain form: a supplier set to take only encrypted bodies refuses it.
    if (s.type === 'tinfoil' && !s.allowPlaintext) return { error: apiError(c, 400, 'encryption_required', 'this supplier only accepts encrypted requests') };
    return { model: m, supplier, privacy: s.tier === 'enclave' ? 'enclave-plaintext' : 'standard' };
  };

  /**
   * Holds the price, calls the supplier, charges on success and releases on failure. `call` returns the
   * body to send back, or throws; a failure is never charged.
   */
  async function paid<T>(
    c: Context,
    o: { requestId: string; a: Account; model: AudioModelConfig; usage: AudioUsage; privacy: string },
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<{ result?: T; error?: unknown; headers: Record<string, string> }> {
    const t0 = Date.now();
    const unit: Unit = o.a.unit;
    let rate: number | undefined;
    if (unit === 'sat') {
      rate = await rates.get();
      if (!rate) throw new UpstreamError('BTC/USD rate unavailable; sat pricing is paused. Retry later.', 503);
    }
    const nano = audioCostNanoUsd(o.model, o.usage, env.FORGE_MARKUP);
    const msub = Math.max(1, nanoUsdToMsub(nano, unit, rate));
    const reservationId = ledger.reserve(o.a.id, msub);
    // The request owns its reservation until it settles (src/ledger.ts). However it ends, it then gives
    // the reservation up: after a settle this changes nothing, and after an error that escaped before
    // settling (the metering row could not be written, say) the abandoned-request sweep can release it.
    try {
      db.prepare(
        "INSERT INTO requests (id, account_id, payment, unit, model, supplier, encrypted, status, reserved_msub, created_at) VALUES (?, ?, 'balance', ?, ?, ?, 0, 'running', ?, ?)",
      ).run(o.requestId, o.a.id, unit, o.model.id, o.model.supplier, msub, now());
      const settle = (ok: boolean) => {
        const s = ledger.settle(reservationId, ok ? msub : 0, o.requestId);
        db.prepare('UPDATE requests SET status = ?, usage_source = ?, charged_msub = ?, latency_ms = ?, price_nusd = ?, supplier_cost_nusd = ?, cost_source = ? WHERE id = ?').run(
          ok ? 'settled' : 'failed',
          'audio',
          s.charged,
          Date.now() - t0,
          ok ? nano : 0,
          ok ? audioCostNanoUsd(o.model, o.usage, 1) : null,
          ok ? 'catalog' : null,
          o.requestId,
        );
        log.info('audio', {
          request_id: o.requestId,
          model: o.model.id,
          supplier: o.model.supplier,
          kind: o.model.kind,
          unit,
          status: ok ? 'ok' : 'upstream_error',
          seconds: o.usage.seconds !== undefined ? Math.round(o.usage.seconds * 10) / 10 : undefined,
          chars: o.usage.chars,
          reserved_msub: msub,
          charged_msub: s.charged,
          latency_ms: Date.now() - t0,
        });
        return { 'X-Forge-Request-Id': o.requestId, 'X-Forge-Unit': unit, 'X-Forge-Privacy': o.privacy, 'X-Forge-Charged-Msub': String(s.charged), 'X-Forge-Balance-Msub': String(s.balance) };
      };
      const signal = c.req.raw.signal;
      try {
        const result = await call(signal);
        return { result, headers: settle(true) };
      } catch (e) {
        return { error: e, headers: settle(false) };
      }
    } finally {
      ledger.disown(reservationId);
    }
  }

  const failure = (c: Context, e: unknown, headers: Record<string, string>) => {
    const status = e instanceof UpstreamError && e.status >= 400 && e.status < 500 && e.status !== 429 && e.status !== 499 ? e.status : 502;
    return apiError(c, status, 'upstream_error', `${errText(e)}. You were not charged.`, headers);
  };

  /** Reads an upstream error into a short message, without echoing a body that could hold content. */
  const upstreamFailed = async (res: Response): Promise<UpstreamError> => {
    let msg = `upstream returned HTTP ${res.status}`;
    try {
      const j: any = JSON.parse((await res.text()).slice(0, 4000));
      if (typeof j?.error?.message === 'string') msg += `: ${j.error.message.slice(0, 200)}`;
    } catch {
      /* not JSON */
    }
    return new UpstreamError(msg, res.status >= 400 && res.status < 500 && res.status !== 429 ? res.status : 502);
  };

  app.post(TRANSCRIPTIONS_PATH, async (c) => {
    const requestId = 'req_' + randomUUID().replaceAll('-', '');
    c.header('X-Forge-Request-Id', requestId);
    const a = account(c);
    let form: Record<string, unknown>;
    try {
      form = (await c.req.parseBody()) as Record<string, unknown>;
    } catch {
      return apiError(c, 400, 'invalid_request', 'expected multipart/form-data with file and model');
    }
    const picked = modelFor(c, form.model, 'transcription');
    if (picked.error) return picked.error;
    const { model, supplier, privacy } = picked;
    const file = form.file;
    if (!(file instanceof Blob) || file.size === 0) return apiError(c, 400, 'invalid_request', 'file is required');
    if (form.response_format !== undefined && form.response_format !== 'json') return apiError(c, 400, 'invalid_request', 'response_format must be json');
    const language = typeof form.language === 'string' && form.language ? form.language.toLowerCase() : undefined;
    if (language && !LANGUAGE.test(language)) return apiError(c, 400, 'invalid_request', 'language must be an ISO 639-1 code such as en');
    const audio = new Uint8Array(await file.arrayBuffer());
    const format = sniffFormat(audio);
    if (format !== 'wav' || !model.formats.includes(format)) return apiError(c, 415, 'unsupported_audio', `audio must be ${model.formats.join(' or ')}`);
    const seconds = billedSeconds(audio);
    if (seconds > model.max_seconds) return apiError(c, 413, 'audio_too_long', `audio is longer than ${model.max_seconds} seconds`);
    if (seconds < MIN_SECONDS) return apiError(c, 400, 'audio_too_short', 'audio is too short');

    const r = await paid(c, { requestId, a, model, usage: { seconds }, privacy }, async (signal) => {
      const res = await supplier.transcribe!({ model, audio, format, language, signal });
      if (!res.ok) throw await upstreamFailed(res);
      let body: any;
      try {
        body = await res.json();
      } catch {
        throw new UpstreamError('upstream sent no JSON');
      }
      if (typeof body?.text !== 'string') throw new UpstreamError('upstream sent no text');
      return body.text as string;
    });
    if (r.error !== undefined) return failure(c, r.error, r.headers);
    for (const [k, v] of Object.entries(r.headers)) c.header(k, v);
    return c.json({ text: r.result, usage: { type: 'duration', seconds: Math.round(seconds * 100) / 100 } });
  });

  app.post(SPEECH_PATH, async (c) => {
    const requestId = 'req_' + randomUUID().replaceAll('-', '');
    c.header('X-Forge-Request-Id', requestId);
    const a = account(c);
    let body: any;
    try {
      body = await c.req.json();
    } catch {
      return apiError(c, 400, 'invalid_request', 'expected JSON {"model", "input", "voice"}');
    }
    const picked = modelFor(c, body?.model, 'speech');
    if (picked.error) return picked.error;
    const { model, supplier, privacy } = picked;
    const input = body?.input;
    if (typeof input !== 'string' || !input.trim()) return apiError(c, 400, 'invalid_request', 'input is required');
    const chars = charCount(input);
    if (chars > model.max_chars) return apiError(c, 413, 'text_too_long', `input is longer than ${model.max_chars} characters`);
    const voice = body?.voice ?? model.voices[0];
    if (typeof voice !== 'string' || !model.voices.includes(voice)) return apiError(c, 400, 'invalid_request', `voice must be one of ${model.voices.join(', ')}`);
    if (body?.response_format !== undefined && body.response_format !== 'wav') return apiError(c, 400, 'invalid_request', 'response_format must be wav');

    const r = await paid(c, { requestId, a, model, usage: { chars }, privacy }, async (signal) => {
      const res = await supplier.speech!({ model, input, voice, signal });
      if (!res.ok) throw await upstreamFailed(res);
      const len = Number(res.headers.get('content-length') ?? 0);
      if (len > MAX_SPEECH_BYTES) throw new UpstreamError('upstream audio too large');
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length) throw new UpstreamError('upstream sent no audio');
      if (bytes.length > MAX_SPEECH_BYTES) throw new UpstreamError('upstream audio too large');
      return { bytes, type: res.headers.get('content-type') ?? 'audio/wav' };
    });
    if (r.error !== undefined) return failure(c, r.error, r.headers);
    const out = r.result!;
    return new Response(out.bytes, { status: 200, headers: { 'content-type': out.type, 'cache-control': 'no-store', ...r.headers } });
  });
}

/** The audio models as GET /v1/models lists them, with prices after markup in each unit. */
export function audioModelList(config: Config, rate: number | undefined) {
  const markup = config.env.FORGE_MARKUP;
  return config.catalog.audio.map((m) => {
    const s = config.catalog.suppliers[m.supplier]!;
    const usd = { request: m.request_usd * markup, second: m.usd_per_second * markup, kchar: m.usd_per_kchar * markup };
    const toSat = (v: number) => (rate ? (v / rate) * 1e8 : null);
    return {
      id: m.id,
      object: 'model',
      kind: m.kind,
      name: m.name ?? m.id,
      owned_by: m.supplier,
      tier: s.tier,
      privacy: s.tier,
      encrypted_passthrough: false,
      max_seconds: m.kind === 'transcription' ? m.max_seconds : undefined,
      max_chars: m.kind === 'speech' ? m.max_chars : undefined,
      formats: m.kind === 'transcription' ? m.formats : ['wav'],
      voices: m.kind === 'speech' ? m.voices : undefined,
      languages: m.languages,
      pricing: {
        usd,
        sat: rate ? { request: toSat(usd.request), second: toSat(usd.second), kchar: toSat(usd.kchar) } : null,
        verified: m.price_verified,
      },
    };
  });
}
