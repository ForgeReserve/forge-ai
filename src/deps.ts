import { resolve } from 'node:path';
import { GatewayWallet } from './cashu/wallet.ts';
import type { Config } from './config.ts';
import { openDb } from './db.ts';
import { Invites, Ledger } from './ledger.ts';
import { BUILTIN_SOURCES, RateOracle, type RateSource } from './rates.ts';
import { buildSuppliers } from './suppliers/index.ts';
import type { Deps } from './app.ts';

export function buildDeps(config: Config, opts: { rateSources?: RateSource[]; env?: NodeJS.ProcessEnv; faults?: { afterReceiveSwap?: boolean; afterSendSwap?: boolean; noReplayOnRecovery?: boolean } } = {}): Deps {
  const env = config.env;
  const db = openDb(env.FORGE_DB_PATH);
  const sources =
    opts.rateSources ??
    env.FORGE_RATE_SOURCES.map((n) => {
      const s = BUILTIN_SOURCES[n];
      if (!s) throw new Error(`unknown rate source ${n}; known: ${Object.keys(BUILTIN_SOURCES).join(', ')}`);
      return s;
    });
  return {
    config,
    db,
    ledger: new Ledger(db),
    invites: new Invites(db),
    wallet: new GatewayWallet(db, {
      trustedMints: config.trustedMints,
      units: env.FORGE_UNITS,
      maxTokenBytes: env.FORGE_MAX_TOKEN_BYTES,
      seed: env.FORGE_WALLET_SEED ? Buffer.from(env.FORGE_WALLET_SEED, 'hex') : undefined,
      faults: opts.faults,
    }),
    rates: new RateOracle(sources, {
      minSources: Math.min(env.FORGE_RATE_MIN_SOURCES, sources.length),
      ttlMs: env.FORGE_RATE_TTL_SECONDS * 1000,
      maxStaleMs: env.FORGE_RATE_MAX_STALE_SECONDS * 1000,
    }),
    suppliers: buildSuppliers(config, opts.env ?? process.env),
    publicDir: resolve(import.meta.dirname, '..', 'public'),
  };
}
