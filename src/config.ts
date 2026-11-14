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
  /** How long a challenge may be worked on. */
  FORGE_FAUCET_CHALLENGE_SECONDS: z.coerce.number().int().min(10).max(3600).default(300),
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
  /** tinfoil only: accept plaintext (non-EHBP) requests. The gateway can read those. */
  allowPlaintext: z.boolean().default(true),
  /** tinfoil only: hosts allowed in X-Tinfoil-Enclave-Url (exact or subdomain). */
  enclaveHosts: z.array(z.string()).default(['tinfoil.sh']),
  /** tinfoil only: where the gateway sends EHBP ciphertext by default. */
  enclaveUrl: z.string().url().optional(),
  attestationUrl: z.string().url().optional(),
  /** tinfoil only: permit http:// enclave URLs (tests only). */
  allowInsecureEnclave: z.boolean().default(false),
});
export type SupplierConfig = z.infer<typeof SupplierSchema>;

const ModelSchema = z.object({
  id: z.string().min(1),
  supplier: z.string(),
  upstream: z.string(),
  name: z.string().optional(),
  input_usd_per_mtok: z.number().nonnegative(),
  output_usd_per_mtok: z.number().nonnegative(),
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
  /** Rough speed hint for the chat page. */
  speed: z.enum(['fast', 'balanced', 'slow']).optional(),
});
export type ModelConfig = z.infer<typeof ModelSchema>;

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
