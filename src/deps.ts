import { resolve } from 'node:path';
import { GatewayWallet, type WalletFaults } from './cashu/wallet.ts';
import { type Config, normalizeMintUrl } from './config.ts';
import { openDb } from './db.ts';
import { Invites, Ledger } from './ledger.ts';
import { BUILTIN_SOURCES, RateOracle, type RateSource } from './rates.ts';
import { checkForeignMintUrl, type FundingFaults, FundingService } from './funding.ts';
import { log } from './log.ts';
import { createDiscovery, createRelayQuery, type MintProbe, type RelayQuery, sqliteStore } from './mint-discovery.ts';
import { setSupplierKeyEnv } from './admin-api.ts';
import { buildSuppliers } from './suppliers/index.ts';
import type { Deps } from './app.ts';

export function buildDeps(
  config: Config,
  opts: {
    rateSources?: RateSource[];
    env?: NodeJS.ProcessEnv;
    faults?: WalletFaults;
    fundingFaults?: FundingFaults;
    /** Tests: stand-ins for the Nostr relays and the mint probe used by other-mint discovery. */
    discovery?: { query?: RelayQuery; probe?: (url: string) => Promise<MintProbe>; now?: () => number };
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
  const fundMint = env.FORGE_FUND_MINT ?? config.trustedMints[0]!;
  const wallet = new GatewayWallet(db, {
    trustedMints: config.trustedMints,
    units: env.FORGE_UNITS,
    maxTokenBytes: env.FORGE_MAX_TOKEN_BYTES,
    seed: env.FORGE_WALLET_SEED ? Buffer.from(env.FORGE_WALLET_SEED, 'hex') : undefined,
    // Other-mint eCash: the mint actually contacted passes the same URL safety check as the quoted one.
    // The operator's funding mint is configuration, not customer input, like the trusted mints.
    vetMint: async (m) => (m === normalizeMintUrl(fundMint) ? undefined : checkForeignMintUrl(m, env.FORGE_FOREIGN_ALLOW_INSECURE)),
    faults: opts.faults,
  });
  const rates = new RateOracle(sources, {
    minSources: Math.min(env.FORGE_RATE_MIN_SOURCES, sources.length),
    ttlMs: env.FORGE_RATE_TTL_SECONDS * 1000,
    maxStaleMs: env.FORGE_RATE_MAX_STALE_SECONDS * 1000,
  });
  const discovery = createDiscovery({
    query: opts.discovery?.query ?? createRelayQuery(),
    relays: env.FORGE_FOREIGN_DISCOVERY_RELAYS,
    minReviewers: env.FORGE_FOREIGN_MIN_REVIEWERS,
    requireAnnouncement: env.FORGE_FOREIGN_REQUIRE_ANNOUNCEMENT,
    maxDiscovered: env.FORGE_FOREIGN_MAX_DISCOVERED,
    units: env.FORGE_UNITS,
    // Forge's own mints and denied mints are never discovered (read once: both come from the env).
    excluded: [...config.trustedMints, ...env.FORGE_FOREIGN_DENY],
    probe: opts.discovery?.probe,
    now: opts.discovery?.now,
    store: sqliteStore(db),
    ttlOkMs: env.FORGE_FOREIGN_DISCOVERY_TTL_MINUTES * 60_000,
    allowInsecure: env.FORGE_FOREIGN_ALLOW_INSECURE,
    log: (msg, fields) => (msg === 'mint_discovery_refreshed' ? log.info(msg, fields) : log.warn(msg, fields)),
  });
  const funding = new FundingService({
    db,
    ledger,
    wallet,
    env,
    rates,
    mint: fundMint,
    faults: opts.fundingFaults,
    discovery,
    probe: opts.discovery?.probe,
  });
  const deps: Deps = {
    config,
    db,
    ledger,
    invites: new Invites(db),
    wallet,
    rates,
    funding,
    discovery,
    suppliers: buildSuppliers(config, opts.env ?? process.env),
    publicDir: resolve(import.meta.dirname, '..', 'public'),
  };
  setSupplierKeyEnv(deps, opts.env ?? process.env);
  return deps;
}
