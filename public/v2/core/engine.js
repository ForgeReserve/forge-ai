// The engine client. One base URL (the same origin by default) and the engine's OpenAI-compatible API:
// /v1/models, /v1/wallet*, /v1/chat/completions (streamed). It answers a 428 proof-of-work challenge the
// way a Bellows asks for it, once per request. Pure apart from fetch, which is passed in, so it is
// tested in Node against stubs.
import { POW_CHALLENGE_HEADER, POW_HEADER, solvePow } from './pow.js';
import { readStream } from './sse.js';

export class EngineError extends Error {
  /** code: the engine's error code, or one of offline, http_<status>, bad_answer. */
  constructor(code, message, { status = 0, retryable = false, body = null } = {}) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
    this.body = body;
  }
}

/** Codes after which the same request may succeed later: a token sent with one of these is kept as pending. */
const RETRYABLE = new Set(['topup_pending', 'mint_unavailable', 'token_in_flight', 'rate_limited', 'in_flight', 'wallet_insufficient', 'payout_unknown']);

export function errorFrom(status, body) {
  const e = body?.error ?? {};
  const code = typeof e.code === 'string' && e.code ? e.code : status === 402 ? 'payment_required' : `http_${status}`;
  const message = typeof e.message === 'string' && e.message ? e.message : `The engine answered HTTP ${status}.`;
  return new EngineError(code, message, { status, retryable: status >= 500 || status === 429 || RETRYABLE.has(code), body });
}

const trimBase = (b) => String(b ?? '').replace(/\/+$/, '');

/** What a paid answer cost and the balance after it, from the engine's X-Forge headers (null when absent). */
function charges(res) {
  const n = (h) => {
    const v = res.headers.get(h);
    return v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v);
  };
  return { chargedMsub: n('x-forge-charged-msub'), balanceMsub: n('x-forge-balance-msub') };
}

/**
 * base: '' for the page's own origin, or an engine origin such as https://ai.forge-reserve.com.
 * fetch: the fetch to use. solve: the proof-of-work solver (tests pass a fast one).
 * encryptedFetch: for private models, a fetch that encrypts the body to the verified enclave
 * (the Tinfoil SDK); see tinfoilFetch below.
 */
/**
 * The exact JSON a chat request sends (streamed, usage asked for; the upstream model name when it is
 * encrypted to the enclave). The funds hold is priced on these bytes, so the app's price line uses the
 * same function (app.js questionHold).
 */
export function chatPayload(body, encrypted = null) {
  const payload = { ...body, stream: true, stream_options: { include_usage: true } };
  if (encrypted) payload.model = encrypted.upstream;
  return JSON.stringify(payload);
}

export function createEngine({ base = '', fetch: f = (...a) => globalThis.fetch(...a), solve = solvePow, encryptedFetch = null } = {}) {
  const root = trimBase(base);
  const url = (path) => root + path;

  /** Sends once, answering a 428 proof-of-work challenge one time if the engine asks. */
  async function send(doFetch, path, init) {
    let res;
    try {
      res = await doFetch(path, init);
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new EngineError('offline', 'The engine could not be reached.', { retryable: true });
    }
    if (res.status !== 428) return res;
    let body = null;
    try {
      body = await res.clone().json();
    } catch {
      /* not JSON */
    }
    if (body?.error?.code !== 'pow_required') return res;
    const challenge = res.headers.get(POW_CHALLENGE_HEADER) ?? body?.pow?.challenge ?? '';
    const bits = Number(body?.pow?.bits);
    if (!challenge || !Number.isInteger(bits)) throw new EngineError('pow_required', 'The engine asked for proof of work without a challenge.', { status: 428, body });
    const solution = await solve(challenge, bits, { signal: init.signal });
    const headers = { ...init.headers, [POW_HEADER]: solution };
    try {
      return await doFetch(path, { ...init, headers });
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      throw new EngineError('offline', 'The engine could not be reached.', { retryable: true });
    }
  }

  const plain = (path, init) => f(url(path), init);

  /** JSON call. Returns {status, ok, body}; never throws for an HTTP error, only when offline. */
  async function call(path, { key, json, method, signal } = {}) {
    const headers = {};
    if (key) headers.authorization = `Bearer ${key}`;
    if (json !== undefined) headers['content-type'] = 'application/json';
    const res = await send(plain, path, { method: method ?? (json !== undefined ? 'POST' : 'GET'), headers, body: json !== undefined ? JSON.stringify(json) : undefined, signal, cache: 'no-store' });
    let body = null;
    try {
      body = await res.json();
    } catch {
      /* not JSON */
    }
    return { status: res.status, ok: res.ok, body };
  }

  /** Same, but throws EngineError for any answer that is not 2xx. */
  async function must(path, opts) {
    const r = await call(path, opts);
    if (!r.ok) throw errorFrom(r.status, r.body);
    return r.body;
  }

  return {
    base: root,
    call,
    models: () => must('/v1/models'),
    wallet: (key) => must('/v1/wallet', { key }),
    refunds: (key) => must('/v1/wallet/refunds', { key }),
    refund: (key, { amount, pubkey } = {}) => call('/v1/wallet/refund', { key, json: { amount, pubkey: pubkey || undefined } }),
    topup: (key, token, invite) => call('/v1/wallet/topup', { key, json: { token, invite: invite || undefined } }),
    /** Opens a balance with an invite code and nothing on it (free models need one). Resolves {key, ...}. */
    openBalance: (invite, unit) => must('/v1/wallet/open', { json: { invite, unit: unit || undefined } }),
    fundMethods: () => must('/v1/wallet/fund/methods'),
    fundLightning: (key, body) => call('/v1/wallet/fund/lightning', { key, json: body }),
    fundOnchain: (key, body) => call('/v1/wallet/fund/onchain', { key, json: body }),
    foreignQuote: (key, body) => call('/v1/wallet/fund/foreign/quote', { key, json: body }),
    foreignConfirm: (key, body) => call('/v1/wallet/fund/foreign/confirm', { key, json: body }),
    foreignMints: (path = '/v1/wallet/fund/mints') => must(path),
    // A Cashu card's mint, reached through the engine (src/cardrelay.ts). No balance key goes with these.
    cardMint: (body) => call('/v1/wallet/fund/card/mint', { json: body }),
    cardSwap: (body) => call('/v1/wallet/fund/card/swap', { json: body }),
    cardRestore: (body) => call('/v1/wallet/fund/card/restore', { json: body }),
    funding: (key, id) => call(`/v1/wallet/fund/${encodeURIComponent(id)}`, { key }),

    /**
     * Speech to text: sends a WAV recording to the engine's audio model. Returns {text, chargedMsub,
     * balanceMsub}. Throws EngineError for a refused or failed request (the engine does not charge those).
     */
    async transcribe(key, { model, audio, seconds, language, signal }) {
      const form = new FormData();
      form.append('file', new Blob([audio], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', model);
      form.append('response_format', 'json');
      if (seconds != null) form.append('duration', String(seconds));
      if (language) form.append('language', language);
      const res = await send(plain, '/v1/audio/transcriptions', { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal, cache: 'no-store' });
      let body = null;
      try {
        body = await res.json();
      } catch {
        /* not JSON */
      }
      if (!res.ok) throw errorFrom(res.status, body);
      if (typeof body?.text !== 'string') throw new EngineError('bad_answer', 'The engine sent no text.');
      return { text: body.text, ...charges(res) };
    },

    /** Text to speech: returns {blob (WAV), chargedMsub, balanceMsub}. Throws EngineError on failure. */
    async speech(key, { model, input, voice, signal }) {
      const res = await send(plain, '/v1/audio/speech', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, input, voice, response_format: 'wav' }),
        signal,
        cache: 'no-store',
      });
      if (!res.ok) {
        let b = null;
        try {
          b = await res.json();
        } catch {
          /* not JSON */
        }
        throw errorFrom(res.status, b);
      }
      return { blob: await res.blob(), ...charges(res) };
    },

    /**
     * Streams a chat completion. body is the OpenAI request (stream is forced on). Handlers receive the
     * answer as it arrives. Throws EngineError for a refused request; an AbortError when stopped.
     */
    async chat({ key, body, encrypted = null, search = false, signal, onText, onReasoning, onUsage, onForge }) {
      const text = chatPayload(body, encrypted);
      const payload = JSON.parse(text);
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${key}` };
      // Search the web: the engine cannot read an encrypted body, so the hold for the search fee is asked
      // for in a header (docs/PAYMENTS.md, Web search). The search options themselves are in the body.
      if (search) headers['X-Forge-Web-Search'] = '1';
      let doFetch = plain;
      let path = '/v1/chat/completions';
      if (encrypted) {
        if (!encryptedFetch) throw new EngineError('encryption_unavailable', 'Encrypted sending is not available here.');
        const ef = await encryptedFetch().catch((e) => {
          throw new EngineError('encryption_unavailable', `The enclave could not be verified: ${e?.message ?? e}`, { retryable: true });
        });
        doFetch = (p, init) => ef(p.replace(/^\/v1\//, ''), init);
        headers['X-Tinfoil-Model'] = encrypted.upstream;
        headers['X-Tinfoil-Max-Output-Tokens'] = String(payload.max_tokens);
      }
      const res = await send(doFetch, path, { method: 'POST', headers, body: text, signal });
      if (!res.ok) {
        let b = null;
        try {
          b = await res.json();
        } catch {
          /* not JSON */
        }
        throw errorFrom(res.status, b);
      }
      if (!res.body) throw new EngineError('bad_answer', 'The engine sent an empty answer.');
      await readStream(res.body, { onText, onReasoning, onUsage, onForge });
    },
  };
}

/**
 * A fetch that encrypts each request to a verified Tinfoil enclave (EHBP), using the SDK vendored for v1.
 * The engine forwards the ciphertext and cannot read it. Loaded only when a private model is used.
 */
export function tinfoilFetch(base = '') {
  let p = null;
  return () => {
    p ??= (async () => {
      const mod = await import(new URL('../../vendor/tinfoil.js', import.meta.url).href);
      const origin = trimBase(base) || location.origin;
      const opts = { baseURL: `${origin}/v1/` };
      if (origin.startsWith('https:')) opts.attestationBundleURL = origin;
      const client = new mod.SecureClient(opts);
      await client.ready();
      return client.fetch;
    })();
    p.catch(() => (p = null));
    return p;
  };
}
