import { resolve } from 'node:path';
import { GatewayWallet } from './cashu/wallet.ts';
import type { Config } from './config.ts';
import { openDb } from './db.ts';
import { Invites, Ledger } from './ledger.ts';
import { BUILTIN_SOURCES, RateOracle, type RateSource } from './rates.ts';
import { type FundingFaults, FundingService } from './funding.ts';
import { buildSuppliers } from './suppliers/index.ts';
import type { Deps } from './app.ts';

export function buildDeps(
  config: Config,
  opts: {
    rateSources?: RateSource[];
    env?: NodeJS.ProcessEnv;
    faults?: { afterReceiveSwap?: boolean; afterSendSwap?: boolean; noReplayOnRecovery?: boolean };
    fundingFaults?: FundingFaults;
  } = {},
): Deps {
  const env = config.env;
  const db = openDb(env.FORGE_DB_PATH);
  const sources =
    opts.rateSources ??
    env.FORGE_RATE_SOURCES.map((n) => {
      const s = BUILTIN_SOURCES[n];
      if (!s) throw new Error(`unknown rate source ${n}; known: ${Object.keys(BUILTIN_SOURCES).join(', ')}`);
      return s;
    });
  const ledger = new Ledger(db);
  const wallet = new GatewayWallet(db, {
    trustedMints: config.trustedMints,
    units: env.FORGE_UNITS,
    maxTokenBytes: env.FORGE_MAX_TOKEN_BYTES,
    seed: env.FORGE_WALLET_SEED ? Buffer.from(env.FORGE_WALLET_SEED, 'hex') : undefined,
    faults: opts.faults,
  });
  const rates = new RateOracle(sources, {
    minSources: Math.min(env.FORGE_RATE_MIN_SOURCES, sources.length),
    ttlMs: env.FORGE_RATE_TTL_SECONDS * 1000,
    maxStaleMs: env.FORGE_RATE_MAX_STALE_SECONDS * 1000,
  });
  const funding = new FundingService({ db, ledger, wallet, env, rates, mint: env.FORGE_FUND_MINT ?? config.trustedMints[0]!, faults: opts.fundingFaults });
  return {
    config,
    db,
    ledger,
    invites: new Invites(db),
    wallet,
    rates,
    funding,
    suppliers: buildSuppliers(config, opts.env ?? process.env),
    publicDir: resolve(import.meta.dirname, '..', 'public'),
  };
}
