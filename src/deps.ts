import { resolve } from 'node:path';
import { GatewayWallet, type WalletFaults } from './cashu/wallet.ts';
import { type Config, normalizeMintUrl } from './config.ts';
import { CreditKeysets, freeRules, mintCredits } from './credits.ts';
import { openDb } from './db.ts';
import { Faucet } from './faucet.ts';
import { type FedimintFaults, FedimintService, ReceiverClient } from './fedimint.ts';
import { FreeVoice } from './free-voice.ts';
import { Invites, Ledger, Passes } from './ledger.ts';
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
    /** Tests: crash points in a Fedimint top-up, and how long a top-up waits for a pending receive. */
    fedimint?: { faults?: FedimintFaults; waitMs?: number; pollMs?: number };
    /** Tests: stand-ins for the Nostr relays and the mint probe used by other-mint discovery. */
    discovery?: { query?: RelayQuery; probe?: (url: string) => Promise<MintProbe>; now?: () => number };
    /** Tests: the faucet's clock and voucher maker. */
    faucet?: { now?: () => number; issue?: (questions: number) => Promise<string> };
    /** Tests: the clock free voice questions count days by. */
    freeVoice?: { now?: () => number };
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
  const free = freeRules(config);
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
    creditMint: free?.mint,
    creditUnit: free?.unit,
    creditKeysets: free ? new CreditKeysets(db, free.keysetDays) : undefined,
  });
  // The faucet mints vouchers where minting is open (the credit mint's own host), written with its public address.
  const faucet =
    free && env.FORGE_FAUCET_ENABLED
      ? new Faucet({
          db,
          daily: env.FORGE_FAUCET_DAILY_VOUCHERS,
          questions: env.FORGE_FAUCET_QUESTIONS,
          drips: env.FORGE_FAUCET_DRIPS_PER_DAY,
          powBits: env.FORGE_FAUCET_POW_BITS,
          powMaxBits: env.FORGE_FAUCET_POW_MAX_BITS,
          perAddress: env.FORGE_FAUCET_PER_ADDRESS,
          challengeMs: env.FORGE_FAUCET_CHALLENGE_SECONDS * 1000,
          now: opts.faucet?.now,
          issue:
            opts.faucet?.issue ??
            (async (questions) => (await mintCredits({ issueUrl: env.FORGE_CREDIT_MINT_ISSUE_URL ?? free.mint, publicUrl: free.mint, unit: free.unit, amounts: [questions] }))[0]!),
        })
      : undefined;
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
    passes: new Passes(db),
    wallet,
    rates,
    funding,
    discovery,
    // Fedimint notes in POST /v1/wallet/topup (src/fedimint.ts): off while FORGE_FEDIMINT_URL is unset.
    fedimint: env.FORGE_FEDIMINT_URL
      ? new FedimintService({
          db,
          ledger,
          client: new ReceiverClient(env.FORGE_FEDIMINT_URL, env.FORGE_FEDIMINT_TOKEN!),
          maxSat: env.FORGE_FEDIMINT_MAX_SAT,
          capSat: env.FORGE_FEDIMINT_FEDERATION_CAP_SAT,
          maxNotesBytes: env.FORGE_MAX_TOKEN_BYTES,
          ...opts.fedimint,
        })
      : undefined,
    free,
    faucet,
    // Free voice questions (src/free-voice.ts): off when either limit is 0.
    freeVoice:
      env.FORGE_FREE_VOICE_PER_DAY > 0 && env.FORGE_FREE_VOICE_BUDGET_USD > 0
        ? new FreeVoice({ db, perDay: env.FORGE_FREE_VOICE_PER_DAY, budgetUsd: env.FORGE_FREE_VOICE_BUDGET_USD, now: opts.freeVoice?.now })
        : undefined,
    suppliers: buildSuppliers(config, opts.env ?? process.env),
    publicDir: resolve(import.meta.dirname, '..', 'public'),
  };
  setSupplierKeyEnv(deps, opts.env ?? process.env);
  return deps;
}
