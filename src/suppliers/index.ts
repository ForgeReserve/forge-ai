import type { Config } from '../config.ts';
import { MockSupplier } from './mock.ts';
import { OpenAISupplier } from './openai.ts';
import { TinfoilSupplier } from './tinfoil.ts';
import type { Supplier } from './types.ts';

export function buildSuppliers(config: Config, env: NodeJS.ProcessEnv = process.env): Map<string, Supplier> {
  const retry = { retries: config.env.FORGE_UPSTREAM_RETRIES, timeoutMs: config.env.FORGE_UPSTREAM_TIMEOUT_MS };
  const out = new Map<string, Supplier>();
  for (const [id, s] of Object.entries(config.catalog.suppliers)) {
    if (s.type === 'mock') out.set(id, new MockSupplier(id, s));
    else if (s.type === 'tinfoil') out.set(id, new TinfoilSupplier(id, s, env, retry));
    else out.set(id, new OpenAISupplier(id, s, env, retry));
  }
  return out;
}

export type { Supplier } from './types.ts';
