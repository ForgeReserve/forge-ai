import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

export const UNITS = ['usd', 'sat'] as const;
export type Unit = (typeof UNITS)[number];

const bool = z
  .enum(['true', 'false', '1', '0', 'yes', 'no'])
  .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = z.string().transform((s) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean),
);

/** A SHA-256 certificate fingerprint as assetlinks.json wants it: upper-case hex pairs joined by colons. */
export function certFingerprint(s: string): string {
  const hex = s.replace(/[:\s]/g, '').toUpperCase();
  return /^[0-9A-F]{64}$/.test(hex) ? hex.match(/../g)!.join(':') : s;
}

export const EnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  HOST: z.string().default('0.0.0.0'),
  FORGE_DB_PATH: z.string().default('data/forge.db'),
  FORGE_MODELS_FILE: z.string().default('config/models.json'),
  FORGE_TRUSTED_MINTS: csv.default(['https://forge.flashapp.me']),
  /**
   * Other addresses of the same mint, as alias=main pairs. Tokens under an alias are handled under the main
   * address: one wallet pile and one counter per keyset. Two piles would restart the deterministic counter
   * and re-derive outputs the mint has already signed.
   */
  FORGE_MINT_ALIASES: csv.default(['https://mint.forge-reserve.com=https://forge.flashapp.me']),
  FORGE_UNITS: csv.pipe(z.array(z.enum(UNITS)).min(1)).default(['usd', 'sat']),
  FORGE_DEFAULT_UNIT: z.enum(UNITS).default('usd'),
  FORGE_INVITE_ONLY: bool.default(true),
  FORGE_MARKUP: z.coerce.number().min(1).max(10).default(1.25),
  FORGE_BYTES_PER_TOKEN: z.coerce.number().min(0.5).max(8).default(2),
  FORGE_RATE_SOURCES: csv.default(['coinbase', 'kraken', 'bitstamp']),
  FORGE_RATE_MIN_SOURCES: z.coerce.number().int().min(1).default(2),
  FORGE_RATE_TTL_SECONDS: z.coerce.number().int().min(5).default(60),
  FORGE_RATE_MAX_STALE_SECONDS: z.coerce.number().int().min(30).default(900),
  FORGE_SAT_PRICE_BUFFER: z.coerce.number().min(1).max(2).default(1.02),
  FORGE_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(60),
  FORGE_MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(1_000_000),
  FORGE_MAX_TOKEN_BYTES: z.coerce.number().int().min(256).default(64_000),
  FORGE_TRUST_PROXY: bool.default(false),
  FORGE_WALLET_SEED: z
    .string()
    .regex(/^[0-9a-f]{128}$/i, 'FORGE_WALLET_SEED must be 64 bytes of hex')
    .optional(),
  FORGE_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(180_000),
  FORGE_UPSTREAM_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  FORGE_STALE_RESERVATION_SECONDS: z.coerce.number().int().min(60).default(900),
  /** Mint used for Lightning / on-chain / other-mint funding. Default: the first trusted mint. */
  FORGE_FUND_MINT: z.string().optional(),
  FORGE_LIGHTNING_ENABLED: bool.default(true),
  /** Per-funding limits for Lightning, in whole units. */
  // Mint quote checks per minute across all fundings: the gateway's one IP shares Nutshell's 20/min limit.
  FORGE_MINT_QUOTE_CHECKS_PER_MIN: z.coerce.number().int().min(1).default(12),
  // Tinfoil admin key (read-only billing calls from the admin page) and the credit Tinfoil granted at sign-up,
  // which its transaction history does not list.
  TINFOIL_ADMIN_KEY: z.string().optional(),
  FORGE_TINFOIL_ADMIN_URL: z.string().url().default('https://api.tinfoil.sh'),
  FORGE_TINFOIL_OPENING_CREDIT_USD: z.coerce.number().min(0).default(5),
  FORGE_TINFOIL_LOW_USD: z.coerce.number().min(0).default(1),
  FORGE_FUND_MAX_SAT: z.coerce.number().int().min(1).default(1_000_000),
  FORGE_FUND_MAX_USD: z.coerce.number().int().min(1).default(50_000),
  /** On-chain (NUT-30) funding. Off by default: shapes come from the Forge Nutshell branch, not a live test. */
  FORGE_ONCHAIN_ENABLED: bool.default(false),
  /** Confirmations shown to users; the mint decides when a deposit is paid. */
  FORGE_ONCHAIN_CONFIRMATIONS: z.coerce.number().int().min(1).default(3),
  FORGE_ONCHAIN_WATCH_DAYS: z.coerce.number().int().min(1).default(30),
  /** Optional Esplora API (e.g. a self-hosted mempool) for showing unconfirmed deposits. Unset: not used. */
  FORGE_ESPLORA_URL: z.string().url().optional(),
  /** eCash from other mints, melted into a Forge Lightning quote. */
  FORGE_FOREIGN_ENABLED: bool.default(true),
  FORGE_FOREIGN_ALLOW: csv.default([]),
  FORGE_FOREIGN_DENY: csv.default([]),
  FORGE_FOREIGN_MAX_SAT: z.coerce.number().int().min(1).default(100_000),
  FORGE_FOREIGN_MAX_USD: z.coerce.number().int().min(1).default(5_000),
  /** Tests only: allow http:// and private-address foreign mints. */
  FORGE_FOREIGN_ALLOW_INSECURE: bool.default(false),
  /**
   * Which other mints' eCash is accepted for funding. FORGE_FOREIGN_DENY always wins, and Forge's own
   * mints always answer 'use_topup'.
   * Mints the operator adds on the admin page (the operator_mints table) count as FORGE_FOREIGN_ALLOW.
   *  - discovered (default): FORGE_FOREIGN_ALLOW and admin-added mints plus the mints found through NIP-87 discovery.
   *  - allowlist: FORGE_FOREIGN_ALLOW and admin-added mints only (empty: no other mint is accepted).
   *  - any: every mint, unless FORGE_FOREIGN_ALLOW is set, which then limits it (the behaviour before discovery).
   *    Admin-added mints are also accepted then; they never limit it on their own.
   */
  FORGE_FOREIGN_POLICY: z.enum(['discovered', 'allowlist', 'any']).default('discovered'),
  /**
   * Under the discovered and allowlist policies, a customer may still fund with eCash from a mint that
   * is not accepted (not denied and not one of Forge's own): the server answers 'mint_unlisted' first,
   * and a request resent with accept_unlisted: true goes ahead after the same live probe discovery uses,
   * capped at the amounts below. false: such a mint is refused with 'mint_not_allowed'.
   */
  FORGE_FOREIGN_UNLISTED: bool.default(true),
  /** Largest token from an unlisted mint, in sat. FORGE_FOREIGN_MAX_SAT still applies when lower. */
  FORGE_FOREIGN_UNLISTED_MAX_SAT: z.coerce.number().int().min(1).default(5_000),
  /** Largest token from an unlisted mint, in cents (500 = $5). FORGE_FOREIGN_MAX_USD still applies when lower. */
  FORGE_FOREIGN_UNLISTED_MAX_USD: z.coerce.number().int().min(1).default(500),
  /** Distinct verified NIP-87 reviewers a discovered mint needs. */
  FORGE_FOREIGN_MIN_REVIEWERS: z.coerce.number().int().min(1).max(100).default(2),
  /** Also require the mint's own NIP-87 announcement (the card provisioner's rule). Few mints publish one today. */
  FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT: bool.default(false),
  /** Nostr relays read for NIP-87 mint announcements and reviews. Empty: no discovery (tests). */
  FORGE_FOREIGN_DISCOVERY_RELAYS: csv
    .pipe(z.array(z.string().regex(/^wss?:\/\/[^\s]+$/, 'relays must be ws:// or wss:// URLs')).max(10))
    .default(['wss://relay.damus.io', 'wss://nos.lol', 'wss://relay.primal.net']),
  /** How long a successful discovery is served before the next background refresh. */
  FORGE_FOREIGN_DISCOVERY_TTL_MINUTES: z.coerce.number().int().min(5).max(7 * 24 * 60).default(60),
  /** Most discovered mints accepted at once (the best reviewed first). */
  FORGE_FOREIGN_MAX_DISCOVERED: z.coerce.number().int().min(1).max(100).default(25),
  /** Unfinished fundings (quotes not yet paid) per balance. */
  FORGE_FUND_MAX_PENDING: z.coerce.number().int().min(1).default(5),
  FORGE_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** Admin page and /admin/api: SHA-256 (hex) of the admin token. Unset: the admin API answers 404. */
  FORGE_ADMIN_TOKEN_HASH: z
    .string()
    .trim()
    .regex(/^[0-9a-f]{64}$/i, 'FORGE_ADMIN_TOKEN_HASH must be the sha256 hex of the admin token')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  /** Origin admin POSTs must come from (e.g. https://ai.forge-reserve.com). Unset: the request's own Host. */
  FORGE_ADMIN_ORIGIN: z.string().url().optional(),
  FORGE_ADMIN_RATE_LIMIT_RPM: z.coerce.number().int().min(1).default(120),
  /** Largest audio upload for POST /v1/audio/transcriptions, in bytes. Other routes keep FORGE_MAX_BODY_BYTES. */
  FORGE_AUDIO_MAX_BYTES: z.coerce.number().int().min(1024).max(50_000_000).default(4_000_000),
  /**
   * Free voice questions (docs/PAYMENTS.md): speech to text for a balance that cannot pay for it, at no
   * charge, this many times per balance per UTC day. 0 turns free voice questions off.
   */
  FORGE_FREE_VOICE_PER_DAY: z.coerce.number().int().min(0).max(10_000).default(20),
  /** The most the operator pays for free voice questions per UTC day, in USD at the supplier's cost. 0 turns them off. */
  FORGE_FREE_VOICE_BUDGET_USD: z.coerce.number().min(0).max(10_000).default(5),

  // ---------------------------------------------------------------- free tier (docs/FREE-TIER.md)
  // Everything here is off until FORGE_CREDIT_MINT is set, and the faucet until FORGE_FAUCET_ENABLED.
  /**
   * The credit mint: eCash from it is a credit, one free question each, never money. Its public address,
   * as written in the vouchers. Unset: no credits are taken anywhere.
   */
  FORGE_CREDIT_MINT: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** Where the gateway mints faucet vouchers (minting is open only on the credit mint's own host). Default: FORGE_CREDIT_MINT. */
  FORGE_CREDIT_MINT_ISSUE_URL: z.string().url().optional().or(z.literal('').transform(() => undefined)),
  /** The credit mint's unit. Nutshell has no custom unit, so a credit is one cent of usd there. */
  FORGE_CREDIT_UNIT: z.enum(UNITS).default('usd'),
  /** The models a free balance may use. Ids not in the catalog are ignored. */
  FORGE_FREE_MODELS: csv.default(['tinfoil/gpt-oss-120b', 'tinfoil/gemma4-31b']),
  /** Caps on one free question, in tokens. Input is estimated from the body size like any request. */
  FORGE_FREE_MAX_INPUT_TOKENS: z.coerce.number().int().min(1).default(4000),
  FORGE_FREE_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).default(1500),
  /** A credit keyset is taken for this many days after the gateway first saw it (or until the mint's own final_expiry). */
  FORGE_CREDIT_KEYSET_DAYS: z.coerce.number().int().min(1).max(3650).default(90),
  /** The daily faucet at /free. Needs FORGE_CREDIT_MINT. */
  FORGE_FAUCET_ENABLED: bool.default(false),
  /** Vouchers the faucet gives out per day (UTC), released in drips. */
  FORGE_FAUCET_DAILY_VOUCHERS: z.coerce.number().int().min(1).max(1_000_000).default(1000),
  FORGE_FAUCET_QUESTIONS: z.coerce.number().int().min(1).max(100).default(3),
  /** Drips per day: 24 releases 1/24 of the day's budget each hour. */
  FORGE_FAUCET_DRIPS_PER_DAY: z.coerce.number().int().min(1).max(1440).default(24),
  /** Proof of work: leading zero bits of SHA-256 at the base difficulty, and the most it rises to. */
  FORGE_FAUCET_POW_BITS: z.coerce.number().int().min(0).max(32).default(22),
  FORGE_FAUCET_POW_MAX_BITS: z.coerce.number().int().min(0).max(32).default(28),
  /** Claims per address per day, counted in memory only. 0 turns the limit off. */
  FORGE_FAUCET_PER_ADDRESS: z.coerce.number().int().min(0).default(3),
  /** How long a challenge may be worked on at the base difficulty. Doubled for each bit over the base, up to an hour. */
  FORGE_FAUCET_CHALLENGE_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),

  // ---------------------------------------------------------------- the Android app (docs/ANDROID.md)
  /**
   * The release APK that /download offers, with its SHA-256 shown on the page. Unset (or no file there):
   * the page says the app is coming.
   */
  FORGE_APK_PATH: z.string().optional().or(z.literal('').transform(() => undefined)),
  /**
   * The release APK of Forge Private Voice (the privatevoice flavour, for GrapheneOS: it hears Hold to
   * talk with its own speech to text). Set, /download offers a choice between it and FORGE_APK_PATH's;
   * unset (or no file there), that choice is hidden.
   */
  FORGE_APK_PRIVATE_VOICE_PATH: z.string().optional().or(z.literal('').transform(() => undefined)),
  /**
   * The SHA-256 fingerprints of the certificates the Android APKs are signed with, comma separated
   * (`keytool -list -v` prints them as 32 colon-separated hex pairs; plain hex works too). They go into
   * /.well-known/assetlinks.json for both apps, so Android opens an event link (`/j#<pass>`) straight in
   * the app (App Links). Unset: that file answers 404 and such links open in the browser.
   */
  FORGE_ANDROID_CERT_SHA256: csv.pipe(z.array(z.string().transform(certFingerprint).pipe(z.string().regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'FORGE_ANDROID_CERT_SHA256: each entry must be a SHA-256 certificate fingerprint')))).default([]),
});
export type Env = z.infer<typeof EnvSchema>;

const FlatSchema = z.object({
  /** Request body size buckets, ascending. The first bucket whose maxBytes >= body size applies. */
  buckets: z.array(z.object({ maxBytes: z.number().int().positive(), usd: z.number().nonnegative() })).min(1),
  /** Price per million declared max output tokens, in USD. */
  output_usd_per_mtok: z.number().nonnegative().default(0),
});
export type FlatPricing = z.infer<typeof FlatSchema>;

const SupplierSchema = z.object({
  type: z.enum(['openai', 'tinfoil', 'mock']),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().optional(),
  tier: z.enum(['enclave', 'standard']),
  /** metered: settle on upstream usage. flat: settle on the flat schedule below. */
  pricing: z.enum(['metered', 'flat']).default('metered'),
  flat: FlatSchema.optional(),
  /**
   * openai and tinfoil plaintext: the header the supplier honours as an idempotency key (e.g. Idempotency-Key).
   * Set it only when the supplier documents that it runs one request per key. With it, every attempt of a
   * request carries the same fresh key and retryable statuses and resets are retried; without it, only
   * failures before the request was sent (refused, DNS, connect timeout, certificate) are retried.
   */
  idempotencyHeader: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
  /** tinfoil only: accept plaintext (non-EHBP) requests. The gateway can read those. */
  allowPlaintext: z.boolean().default(true),
  /** tinfoil only: hosts allowed in X-Tinfoil-Enclave-Url (exact or subdomain). */
  enclaveHosts: z.array(z.string()).default(['tinfoil.sh']),
  /** tinfoil only: where the gateway sends EHBP ciphertext by default. */
  enclaveUrl: z.string().url().optional(),
  attestationUrl: z.string().url().optional(),
  /** tinfoil only: permit http:// enclave URLs (tests only). */
  allowInsecureEnclave: z.boolean().default(false),
  /**
   * tinfoil only: web search on chat completions (docs/PAYMENTS.md, Web search). request_usd is the
   * supplier's fee, charged once per request that searched. A search request runs several model calls
   * and adds what it found to the input, so its hold also takes extra_input_tokens more input and
   * output_factor times the output limit, an allowance; the charge is the reported usage, never more
   * than the hold.
   */
  web_search: z
    .object({
      request_usd: z.number().nonnegative(),
      extra_input_tokens: z.number().int().nonnegative().default(0),
      output_factor: z.number().int().min(1).max(8).default(1),
    })
    .optional(),
});
export type SupplierConfig = z.infer<typeof SupplierSchema>;

const ModelSchema = z.object({
  id: z.string().min(1),
  supplier: z.string(),
  upstream: z.string(),
  name: z.string().optional(),
  /**
   * paid (default): charged at the token prices below, with FORGE_MARKUP. free: costs the user nothing
   * (docs/PAYMENTS.md, Free models). A free request needs a balance key, is never held or charged, and
   * carries no token price: the prices are 0 and must not be set to anything else. Not the free tier's
   * free questions (credits, docs/FREE-TIER.md), which are a kind of balance, not a kind of model.
   */
  pricing: z.enum(['paid', 'free']).default('paid'),
  /** Why a free model is free, and on whose decision (required with pricing "free"; shown in /v1/models). */
  free_reason: z.string().trim().min(1).optional(),
  /** Supplier cost per million tokens in USD. Required on a paid model; 0 (or left out) on a free one. */
  input_usd_per_mtok: z.number().nonnegative().optional(),
  output_usd_per_mtok: z.number().nonnegative().optional(),
  /** true once the cost above has been checked against the supplier's rate card. */
  price_verified: z.boolean().default(false),
  max_output_tokens: z.number().int().positive().default(4096),
  context_length: z.number().int().positive().optional(),
  uncensored: z.boolean().default(false),
  /** Accepts image parts in messages (OpenAI image_url content). */
  vision: z.boolean().default(false),
  /** Streams reasoning (reasoning_content / reasoning deltas). */
  reasoning: z.boolean().default(false),
  /** Values the chat page may send as reasoning_effort; empty means the control is hidden. */
  reasoning_efforts: z.array(z.string()).default([]),
  /**
   * Speed mark, from a timing battery (config/models.json _comment): 'fast' shows a rabbit and 'slow' puts
   * the model under the v2 picker's Slow heading (a turtle). Left out on a model not measured.
   */
  speed: z.enum(['fast', 'balanced', 'slow']).optional(),
  /** Can search the web (its supplier sets web_search). Off on every request unless the client asks. */
  web_search: z.boolean().default(false),
})
  .superRefine((m, ctx) => {
    if (m.pricing === 'free') {
      if (!m.free_reason) ctx.addIssue({ code: 'custom', message: `free model ${m.id}: free_reason is required` });
      if ((m.input_usd_per_mtok ?? 0) !== 0 || (m.output_usd_per_mtok ?? 0) !== 0)
        ctx.addIssue({ code: 'custom', message: `free model ${m.id}: a free model carries no token price (leave input_usd_per_mtok and output_usd_per_mtok out, or 0)` });
      // A search has a fee of its own; a free request takes no hold to cover it.
      if (m.web_search) ctx.addIssue({ code: 'custom', message: `free model ${m.id}: web_search is not offered on a free model` });
    } else {
      if (m.input_usd_per_mtok === undefined || m.output_usd_per_mtok === undefined)
        ctx.addIssue({ code: 'custom', message: `model ${m.id}: input_usd_per_mtok and output_usd_per_mtok (price per million tokens) are required on a paid model` });
      if (m.free_reason) ctx.addIssue({ code: 'custom', message: `model ${m.id}: free_reason is only for pricing "free"` });
    }
  })
  // A free model's prices are 0 everywhere they are read, so no path can charge for one.
  .transform((m) => ({ ...m, input_usd_per_mtok: m.input_usd_per_mtok ?? 0, output_usd_per_mtok: m.output_usd_per_mtok ?? 0 }));
export type ModelConfig = z.infer<typeof ModelSchema>;

/** True for a model that costs the user nothing (pricing "free"; docs/PAYMENTS.md, Free models). */
export const isFreeModel = (m: Pick<ModelConfig, 'pricing'>): boolean => m.pricing === 'free';

/**
 * An audio model: speech to text (POST /v1/audio/transcriptions) or text to speech (POST /v1/audio/speech).
 * Priced per request: the supplier's cost per request, plus per second of audio in or per character out,
 * all in USD before FORGE_MARKUP.
 */
const AudioModelSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['transcription', 'speech']),
  supplier: z.string(),
  upstream: z.string(),
  name: z.string().optional(),
  request_usd: z.number().nonnegative().default(0),
  /** transcription: per second of audio sent. */
  usd_per_second: z.number().nonnegative().default(0),
  /** speech: per 1,000 characters of text sent. */
  usd_per_kchar: z.number().nonnegative().default(0),
  /** true once the cost above has been checked against the supplier's price list. */
  price_verified: z.boolean().default(false),
  /** transcription: the longest recording taken, in seconds. */
  max_seconds: z.number().int().positive().max(3600).default(60),
  /** speech: the most characters in one request. */
  max_chars: z.number().int().positive().max(20_000).default(1000),
  /**
   * transcription: audio containers taken. WAV only: it states its own length, so max_seconds and the
   * per-second price apply to the real length. An MP3's length cannot be read from its size.
   */
  formats: z.array(z.enum(['wav'])).default(['wav']),
  /** speech: the voices the upstream offers; the first is the default. */
  voices: z.array(z.string().min(1)).default([]),
  /** Language codes the model handles well (shown to the app; not enforced). */
  languages: z.array(z.string()).default([]),
});
export type AudioModelConfig = z.infer<typeof AudioModelSchema>;

export const CatalogSchema = z
  .object({
    suppliers: z.record(z.string(), SupplierSchema),
    models: z.array(ModelSchema).min(1),
    audio: z.array(AudioModelSchema).default([]),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const m of c.models) {
      if (ids.has(m.id)) ctx.addIssue({ code: 'custom', message: `duplicate model id ${m.id}` });
      ids.add(m.id);
      if (!c.suppliers[m.supplier]) ctx.addIssue({ code: 'custom', message: `model ${m.id}: unknown supplier ${m.supplier}` });
      else if (m.web_search && (!c.suppliers[m.supplier]!.web_search || c.suppliers[m.supplier]!.type !== 'tinfoil' || c.suppliers[m.supplier]!.pricing !== 'metered'))
        ctx.addIssue({ code: 'custom', message: `model ${m.id}: web_search needs a metered tinfoil supplier with a web_search fee` });
    }
    for (const m of c.audio) {
      if (ids.has(m.id)) ctx.addIssue({ code: 'custom', message: `duplicate model id ${m.id}` });
      ids.add(m.id);
      if (!c.suppliers[m.supplier]) ctx.addIssue({ code: 'custom', message: `audio model ${m.id}: unknown supplier ${m.supplier}` });
      if (m.kind === 'speech' && m.voices.length === 0) ctx.addIssue({ code: 'custom', message: `audio model ${m.id}: speech needs at least one voice` });
    }
    for (const [id, s] of Object.entries(c.suppliers)) {
      if (s.pricing === 'flat' && !s.flat) ctx.addIssue({ code: 'custom', message: `supplier ${id}: flat pricing needs a flat schedule` });
    }
  });
export type Catalog = z.infer<typeof CatalogSchema>;

export interface Config {
  env: Env;
  catalog: Catalog;
  trustedMints: string[];
  /** The credit mint (normalized), when the free tier is on. */
  creditMint?: string;
}

let mintAliases = new Map<string, string>();

/** Sets the alias=main mint address pairs that normalizeMintUrl folds together. */
export function setMintAliases(pairs: string[]): void {
  const clean = (u: string) => u.trim().replace(/\/+$/, '');
  mintAliases = new Map(
    pairs.map((p) => {
      const [alias, main] = p.split('=');
      if (!alias || !main) throw new Error(`FORGE_MINT_ALIASES entry must be alias=main: ${p}`);
      return [clean(alias), clean(main)];
    }),
  );
}

/**
 * The alias addresses whose main address is one of these mints (all of them when no list is given).
 * /v1/models lists them so a phone can tell that a note made under an alias is one the engine takes.
 */
export function mintAliasList(mainMints?: string[]): string[] {
  const mains = mainMints && new Set(mainMints.map((m) => m.trim().replace(/\/+$/, '')));
  return [...mintAliases].filter(([, main]) => !mains || mains.has(main)).map(([alias]) => alias);
}

export function normalizeMintUrl(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  return mintAliases.get(u) ?? u;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, catalogOverride?: unknown): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
  setMintAliases(env.FORGE_MINT_ALIASES);
  if (!env.FORGE_UNITS.includes(env.FORGE_DEFAULT_UNIT)) {
    throw new Error('FORGE_DEFAULT_UNIT must be one of FORGE_UNITS');
  }
  const raw = catalogOverride ?? JSON.parse(readFileSync(resolve(env.FORGE_MODELS_FILE), 'utf8'));
  const cat = CatalogSchema.safeParse(raw);
  if (!cat.success) throw new Error(`invalid model catalog: ${z.prettifyError(cat.error)}`);
  // A supplier whose API key env var is unset is left out, so its models are neither listed nor routable.
  const keyless = new Set(
    Object.entries(cat.data.suppliers)
      .filter(([, s]) => s.apiKeyEnv && !source[s.apiKeyEnv])
      .map(([id]) => id),
  );
  const models = cat.data.models.filter((m) => !keyless.has(m.supplier));
  if (models.length === 0) throw new Error('no models left: set the API key of at least one supplier');
  const audio = cat.data.audio.filter((m) => !keyless.has(m.supplier));
  const trustedMints = env.FORGE_TRUSTED_MINTS.map(normalizeMintUrl);
  const creditMint = env.FORGE_CREDIT_MINT ? normalizeMintUrl(env.FORGE_CREDIT_MINT) : undefined;
  if (creditMint && trustedMints.includes(creditMint)) throw new Error('FORGE_CREDIT_MINT must not be one of FORGE_TRUSTED_MINTS: credits are never money');
  if (env.FORGE_FAUCET_ENABLED && !creditMint) throw new Error('FORGE_FAUCET_ENABLED needs FORGE_CREDIT_MINT');
  if (env.FORGE_FAUCET_POW_MAX_BITS < env.FORGE_FAUCET_POW_BITS) throw new Error('FORGE_FAUCET_POW_MAX_BITS must be at least FORGE_FAUCET_POW_BITS');
  return { env, catalog: { ...cat.data, models, audio }, trustedMints, creditMint };
}
