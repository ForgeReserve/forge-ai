// An audio request owns its balance reservation only while it is being served (src/ledger.ts): an
// error that escapes before settlement gives the reservation up, so the abandoned-request sweep can
// release it, as the chat route does. Without that, the hold would stay on the balance until a restart.
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { loadConfig } from '../../src/config.ts';
import { buildDeps } from '../../src/deps.ts';
import { newApiKey } from '../../src/ledger.ts';
import { setLogSilent } from '../../src/log.ts';
import { fixedRateSource } from '../../src/rates.ts';
import { testCatalog } from '../e2e/helpers.ts';

setLogSilent(true);

function gateway() {
  const e = { FORGE_DB_PATH: ':memory:', FORGE_TRUSTED_MINTS: 'http://127.0.0.1:1', FORGE_FOREIGN_DISCOVERY_RELAYS: '' };
  const config = loadConfig(e as NodeJS.ProcessEnv, testCatalog(1, { audio: true }));
  const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: e as NodeJS.ProcessEnv });
  const app = createApp({ ...deps, publicDir: undefined });
  const key = newApiKey();
  const account = deps.ledger.createAccountRaw(key, 'usd', null);
  deps.ledger.creditRaw(account.id, 1_000_000, 'topup', null);
  const speech = () =>
    app.request('http://gw.test/v1/audio/speech', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: 'mock-speech', input: 'hello there' }),
    });
  return { deps, account, speech };
}

describe('audio reservations', () => {
  it('a request that fails before it settles gives its reservation up to the stale sweep', async () => {
    const { deps, account, speech } = gateway();
    // The metering row cannot be written: the request fails after its reservation was made.
    deps.db.exec("CREATE TRIGGER no_audio_rows BEFORE INSERT ON requests WHEN NEW.model = 'mock-speech' BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect((await speech()).status).toBe(500);
    expect(deps.ledger.reservedMsub(account.id)).toBeGreaterThan(0);
    expect(deps.ledger.releaseStale(0)).toBe(1);
    expect(deps.ledger.reservedMsub(account.id)).toBe(0);
    expect(deps.ledger.get(account.id)!.balance_msub).toBe(1_000_000);
  });

  it('a request that settles leaves nothing for the sweep, and one in flight is never swept', async () => {
    const { deps, account, speech } = gateway();
    const r = await speech();
    expect(r.status).toBe(200);
    const charged = Number(r.headers.get('x-forge-charged-msub'));
    expect(charged).toBeGreaterThan(0);
    expect(deps.ledger.releaseStale(0)).toBe(0);
    expect(deps.ledger.get(account.id)!.balance_msub).toBe(1_000_000 - charged);
    // A reservation held by a live request (as audio holds one across the supplier call) is never released.
    const live = deps.ledger.reserve(account.id, 1000);
    expect(deps.ledger.releaseStale(0)).toBe(0);
    deps.ledger.settle(live, 0, 'req_test');
  });
});
