import { randomUUID } from 'node:crypto';
import type { SupplierConfig } from '../config.ts';
import { errText, log } from '../log.ts';
import { type ChatCall, type Supplier, UpstreamError } from './types.ts';

export interface RetryOptions {
  retries: number;
  timeoutMs: number;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * Connection failures that provably happen before any request byte reaches the supplier: the connection was
 * refused, the name did not resolve, the connect timed out, or the TLS handshake rejected the certificate.
 */
const PRE_SEND_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'HOSTNAME_MISMATCH',
]);
const preSendCode = (code: unknown) => typeof code === 'string' && (PRE_SEND_CODES.has(code) || code.startsWith('CERT_') || code.startsWith('UNABLE_TO_'));

/** True only when a fetch error shows the request never left this process. Resets and unknown errors are false. */
export function failedBeforeSend(e: unknown): boolean {
  const cause = (e as { cause?: unknown } | undefined)?.cause;
  if (cause instanceof AggregateError) return cause.errors.length > 0 && cause.errors.every((x) => preSendCode((x as { code?: unknown })?.code));
  return preSendCode((cause as { code?: unknown } | undefined)?.code);
}

/**
 * fetch with retries, before any body byte is consumed. A request that may have reached the supplier is
 * resent only when `idempotent` (the caller sends a stable idempotency key the supplier honours), since a
 * resent body can run, and bill, a second time upstream. Without it, only failures that provably happened
 * before the request was sent are retried; a retryable status (408, 425, 429, 5xx) is returned as is and a
 * reset after sending is final. A header timeout is always final, since the supplier may still be working.
 * timeoutMs bounds the time to response headers; the body is bounded only by the caller's signal.
 */
export async function fetchWithRetry(url: string, init: RequestInit, signal: AbortSignal, o: RetryOptions, idempotent = false): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= o.retries; attempt++) {
    if (signal.aborted) throw new UpstreamError('client aborted', 499);
    const headerTimeout = new AbortController();
    const timer = setTimeout(() => headerTimeout.abort(new Error('upstream timeout')), o.timeoutMs);
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.any([signal, headerTimeout.signal]) });
      clearTimeout(timer);
      if (idempotent && RETRYABLE.has(res.status) && attempt < o.retries) {
        await res.body?.cancel().catch(() => {});
        lastErr = new UpstreamError(`upstream HTTP ${res.status}`, res.status);
      } else {
        return res;
      }
    } catch (e) {
      clearTimeout(timer);
      if (signal.aborted) throw new UpstreamError('client aborted', 499);
      // The request reached the supplier and may still be running (and billing) there: never resend it.
      if (headerTimeout.signal.aborted) throw new UpstreamError('upstream timeout', 504);
      if (!idempotent && !failedBeforeSend(e)) throw new UpstreamError(`upstream failed after the request was sent: ${errText(e)}`, 502);
      lastErr = e;
    }
    if (attempt === o.retries) break;
    log.warn('upstream_retry', { url: new URL(url).host, attempt, err: errText(lastErr) });
    await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
  }
  if (lastErr instanceof UpstreamError) throw lastErr;
  throw new UpstreamError(`upstream unreachable: ${errText(lastErr)}`, 502);
}

/** Any OpenAI-compatible endpoint (Token Factory's LiteLLM proxy, Tinfoil plaintext, ...). */
export class OpenAISupplier implements Supplier {
  readonly id: string;
  readonly config: SupplierConfig;
  protected readonly apiKey: string | undefined;
  protected readonly retry: RetryOptions;

  constructor(id: string, config: SupplierConfig, env: NodeJS.ProcessEnv, retry: RetryOptions) {
    this.id = id;
    this.config = config;
    this.apiKey = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
    this.retry = retry;
    if (!config.baseUrl) throw new Error(`supplier ${id}: baseUrl required`);
  }

  get configured(): boolean {
    return !!this.apiKey;
  }

  /** Supplier-specific request headers. */
  protected extraHeaders(): Record<string, string> {
    return {};
  }

  async chat(call: ChatCall): Promise<Response> {
    if (!this.apiKey) throw new UpstreamError(`supplier ${this.id} has no API key configured`, 503);
    const url = `${this.config.baseUrl!.replace(/\/$/, '')}/chat/completions`;
    // One key per logical request, the same on every attempt, so the supplier can drop a resent duplicate.
    const idem = this.config.idempotencyHeader;
    return fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: call.stream ? 'text/event-stream' : 'application/json',
          authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders(),
          ...(idem ? { [idem]: randomUUID() } : {}),
        },
        body: JSON.stringify(call.body),
      },
      call.signal,
      this.retry,
      !!idem,
    );
  }
}
