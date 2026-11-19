import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve, type ServerType } from '@hono/node-server';
import { getEncodedToken, type Proof, Wallet } from '@cashu/cashu-ts';
import { createApp, type Deps, startupRecovery } from '../../src/app.ts';
import type { WalletFaults } from '../../src/cashu/wallet.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import type { FedimintFaults } from '../../src/fedimint.ts';
import type { FundingFaults } from '../../src/funding.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';

setLogSilent(process.env.FORGE_TEST_LOGS !== '1');

export const MINT_A = process.env.TEST_MINT_A ?? 'http://127.0.0.1:3338';
export const MINT_B = process.env.TEST_MINT_B ?? 'http://127.0.0.1:3339';
/** The "foreign" mint for other-mint funding tests (input fees 100 ppk). */
export const MINT_C = process.env.TEST_MINT_C ?? 'http://127.0.0.1:3340';
export const BTC_USD = 100_000;
/** The credit mint for the free tier tests (usd only, no input fees). */
export const MINT_CREDIT = process.env.TEST_MINT_CREDIT ?? 'http://127.0.0.1:3341';

export async function creditMintUp(): Promise<boolean> {
  try {
    return (await fetch(`${MINT_CREDIT}/v1/info`)).ok;
  } catch {
    return false;
  }
}

export async function mintsUp(): Promise<boolean> {
  try {
    const [a, b] = await Promise.all([fetch(`${MINT_A}/v1/info`), fetch(`${MINT_B}/v1/info`)]);
    return a.ok && b.ok;
  } catch {
    return false;
  }
}

const userWallets = new Map<string, Promise<Wallet>>();
export function userWallet(mint: string, unit: 'usd' | 'sat'): Promise<Wallet> {
  const k = `${mint}|${unit}`;
  if (!userWallets.has(k)) {
    userWallets.set(
      k,
      (async () => {
        const w = new Wallet(mint, { unit });
        await w.loadMint();
        return w;
      })(),
    );
  }
  return userWallets.get(k)!;
}

/** Mints fresh proofs from a FakeWallet mint (quotes are paid automatically). */
export async function mintProofs(mint: string, unit: 'usd' | 'sat', amount: number): Promise<Proof[]> {
  const w = await userWallet(mint, unit);
  const q = await w.createMintQuoteBolt11(amount);
  for (let i = 0; i < 50; i++) {
    const s = await w.checkMintQuoteBolt11(q.quote);
    if (s.state === 'PAID') break;
    await new Promise((r) => setTimeout(r, 100));
  }
  return w.mintProofsBolt11(amount, q.quote);
}

export async function mintToken(mint: string, unit: 'usd' | 'sat', amount: number): Promise<string> {
  return getEncodedToken({ mint, unit, proofs: await mintProofs(mint, unit, amount) });
}

/** Redeems a token at its mint and returns the amount received (proves the token is real and unspent). */
export async function redeem(token: string, mint = MINT_A, unit: 'usd' | 'sat' = 'usd'): Promise<number> {
  const w = await userWallet(mint, unit);
  const proofs = await w.receive(token);
  return proofs.reduce((s, p) => s + p.amount.toNumber(), 0);
}

export const PRICE_IN = 100; // USD per million input tokens
export const PRICE_OUT = 1000; // USD per million output tokens

/** Audio prices in the test catalog (USD, before markup). */
export const AUDIO_PRICES = { transcribeRequest: 0.01, perSecond: 0.001, speechRequest: 0.002, perKchar: 0.01 };

/** Audio models for the tests: private (enclave tier) mock models, a failing one each, and a standard one. */
export function testAudio() {
  const t = (id: string, upstream: string, supplier = 'mockenclave') => ({
    id,
    kind: 'transcription',
    supplier,
    upstream,
    request_usd: AUDIO_PRICES.transcribeRequest,
    usd_per_second: AUDIO_PRICES.perSecond,
    price_verified: true,
    max_seconds: 30,
    formats: ['wav'],
    languages: ['en'],
  });
  const s = (id: string, upstream: string) => ({
    id,
    kind: 'speech',
    supplier: 'mockenclave',
    upstream,
    request_usd: AUDIO_PRICES.speechRequest,
    usd_per_kchar: AUDIO_PRICES.perKchar,
    price_verified: true,
    max_chars: 200,
    voices: ['neutral_female', 'neutral_male'],
    languages: ['en'],
  });
  return [t('mock-transcribe', 'mock-transcribe'), t('mock-transcribe-fail', 'mock-fail'), t('mock-transcribe-standard', 'mock-transcribe', 'mock'), s('mock-speech', 'mock-speech'), s('mock-speech-fail', 'mock-fail')];
}

export function testCatalog(enclavePort = 1, { audio = false }: { audio?: boolean } = {}) {
  const mock = { type: 'mock', tier: 'standard' } as const;
  const m = (id: string, supplier = 'mock', extra: object = {}) => ({
    id,
    supplier,
    upstream: id,
    input_usd_per_mtok: PRICE_IN,
    output_usd_per_mtok: PRICE_OUT,
    max_output_tokens: 256,
    price_verified: true,
    ...extra,
  });
  const cat = {
    suppliers: {
      mock,
      mockflat: { ...mock, pricing: 'flat', flat: { buckets: [{ maxBytes: 1000, usd: 0.03 }, { maxBytes: 1_000_000, usd: 0.1 }], output_usd_per_mtok: 0 } },
      tinfoil: {
        type: 'tinfoil',
        tier: 'enclave',
        baseUrl: `http://127.0.0.1:${enclavePort}/v1`,
        enclaveUrl: `http://127.0.0.1:${enclavePort}`,
        apiKeyEnv: 'TEST_TINFOIL_KEY',
        enclaveHosts: ['127.0.0.1'],
        allowInsecureEnclave: true,
        allowPlaintext: true,
      },
    },
    models: [
      m('mock-echo'),
      m('mock-slow'),
      m('mock-nousage'),
      m('mock-fail'),
      m('mock-flaky'),
      m('mock-uncensored', 'mock', { upstream: 'mock-echo', uncensored: true }),
      { ...m('flat-echo', 'mockflat'), upstream: 'mock-echo' },
      { ...m('tinfoil/enc-model', 'tinfoil'), upstream: 'enc-model' },
    ],
    ...(audio ? { audio: testAudio() } : {}),
  };
  if (audio) (cat.suppliers as Record<string, object>).mockenclave = { ...mock, tier: 'enclave' };
  return cat;
}

export interface Gateway {
  url: string;
  deps: Deps;
  dbPath: string;
  close(): Promise<void>;
}

export async function startGateway(
  opts: {
    env?: Record<string, string>;
    enclavePort?: number;
    dbPath?: string;
    faults?: WalletFaults;
    fundingFaults?: FundingFaults;
    /** Fedimint top-ups: crash points, and how long a request waits for a pending receive. */
    fedimint?: { faults?: FedimintFaults; waitMs?: number; pollMs?: number };
    recover?: boolean;
    /** Adds the audio models (testAudio) and their private mock supplier. */
    audio?: boolean;
    /** Changes the test catalog before the gateway loads it. */
    editCatalog?: (catalog: any) => void;
    /** The faucet's clock (free tier tests). */
    faucetNow?: () => number;
    /** The clock free voice questions count days by. */
    freeVoiceNow?: () => number;
  } = {},
): Promise<Gateway> {
  const dbPath = opts.dbPath ?? join(mkdtempSync(join(tmpdir(), 'forge-e2e-')), 'forge.db');
  const env = {
    FORGE_DB_PATH: dbPath,
    FORGE_TRUSTED_MINTS: MINT_A,
    FORGE_MARKUP: '1',
    FORGE_RATE_LIMIT_RPM: '100000',
    FORGE_MINT_QUOTE_CHECKS_PER_MIN: '100000',
    FORGE_UPSTREAM_RETRIES: '2',
    TEST_TINFOIL_KEY: 'test-enclave-key',
    // Never reach the public Nostr relays from tests; the local mints are accepted under 'any'.
    FORGE_FOREIGN_DISCOVERY_RELAYS: '',
    FORGE_FOREIGN_POLICY: 'any',
    ...opts.env,
  };
  const catalog = testCatalog(opts.enclavePort, { audio: opts.audio });
  opts.editCatalog?.(catalog);
  const config = loadConfig(env as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, {
    rateSources: [fixedRateSource('fixed', BTC_USD)],
    env: env as NodeJS.ProcessEnv,
    faults: opts.faults,
    fundingFaults: opts.fundingFaults,
    fedimint: opts.fedimint,
    faucet: opts.faucetNow ? { now: opts.faucetNow } : undefined,
    freeVoice: opts.freeVoiceNow ? { now: opts.freeVoiceNow } : undefined,
  });
  if (opts.recover !== false) await startupRecovery(deps);
  const app = createApp(deps);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    deps,
    dbPath,
    close: () =>
      new Promise<void>((r) => {
        (server as any).closeAllConnections?.();
        server.close(() => {
          deps.db.close();
          r();
        });
      }),
  };
}

/** Gateway with an arbitrary catalog (used by live tests). */
export async function startGatewayWithCatalog(catalog: unknown, extraEnv: Record<string, string>): Promise<Gateway> {
  const dbPath = join(mkdtempSync(join(tmpdir(), 'forge-live-')), 'forge.db');
  const env = { FORGE_DB_PATH: dbPath, FORGE_TRUSTED_MINTS: MINT_A, FORGE_RATE_LIMIT_RPM: '100000', FORGE_MINT_QUOTE_CHECKS_PER_MIN: '100000', FORGE_FOREIGN_DISCOVERY_RELAYS: '', ...extraEnv };
  const config = loadConfig(env as NodeJS.ProcessEnv, catalog);
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', BTC_USD)], env: env as NodeJS.ProcessEnv });
  await startupRecovery(deps);
  const app = createApp(deps);
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    deps,
    dbPath,
    close: () => new Promise<void>((r) => server.close(() => (deps.db.close(), r()))),
  };
}

export function createInvite(g: Gateway): string {
  return g.deps.invites.create('test').code;
}

/** Cost in msub (usd milli-cents) for given usage at the test prices with markup 1. */
export function expectedMsub(input: number, output: number): number {
  const nano = input * PRICE_IN * 1000 + output * PRICE_OUT * 1000;
  return Math.ceil(nano / 10_000);
}

export const chatBody = (model: string, extra: object = {}) => ({
  model,
  messages: [{ role: 'user', content: 'Say hello' }],
  max_tokens: 64,
  ...extra,
});

/** Reads an SSE response fully; returns data payloads and the forge event. */
export async function readSse(res: Response): Promise<{ data: any[]; forge?: any; raw: string }> {
  const raw = await res.text();
  const data: any[] = [];
  let forge: any;
  for (const block of raw.split('\n\n')) {
    const lines = block.split('\n');
    const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
    const d = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
    if (!d) continue;
    if (ev === 'forge') forge = JSON.parse(d);
    else if (d !== '[DONE]') data.push(JSON.parse(d));
  }
  return { data, forge, raw };
}
