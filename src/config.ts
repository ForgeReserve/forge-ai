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
  FORGE_UPSTREAM_TIMEOUT_MS: z.coerce.number().int().min(1000).default(60_000),
  FORGE_UPSTREAM_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  FORGE_STALE_RESERVATION_SECONDS: z.coerce.number().int().min(60).default(900),
  FORGE_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
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
});
export type ModelConfig = z.infer<typeof ModelSchema>;

export const CatalogSchema = z
  .object({
    suppliers: z.record(z.string(), SupplierSchema),
    models: z.array(ModelSchema).min(1),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    for (const m of c.models) {
      if (ids.has(m.id)) ctx.addIssue({ code: 'custom', message: `duplicate model id ${m.id}` });
      ids.add(m.id);
      if (!c.suppliers[m.supplier]) ctx.addIssue({ code: 'custom', message: `model ${m.id}: unknown supplier ${m.supplier}` });
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
}

export function normalizeMintUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env, catalogOverride?: unknown): Config {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`invalid environment: ${z.prettifyError(parsed.error)}`);
  }
  const env = parsed.data;
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
  return { env, catalog: { ...cat.data, models }, trustedMints: env.FORGE_TRUSTED_MINTS.map(normalizeMintUrl) };
}
