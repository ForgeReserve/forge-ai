import { serve } from '@hono/node-server';
import { createApp, startupRecovery } from './app.ts';
import { loadConfig } from './config.ts';
import { buildDeps } from './deps.ts';
import { errText, log, setLogLevel } from './log.ts';

const config = loadConfig();
setLogLevel(config.env.FORGE_LOG_LEVEL);
const deps = buildDeps(config);
await startupRecovery(deps).catch((e) => log.error('startup_recovery_failed', { err: errText(e) }));
if (config.env.FORGE_UNITS.includes('sat')) {
  deps.rates.get().catch(() => {});
}
// Periodic sweep for reservations orphaned by bugs (never for in-flight ones: those are younger).
setInterval(() => deps.ledger.releaseStale(config.env.FORGE_STALE_RESERVATION_SECONDS * 1000), 60_000).unref();

const app = createApp(deps);
const server = serve({ fetch: app.fetch, port: config.env.PORT, hostname: config.env.HOST }, (info) => {
  log.info('listening', { host: info.address, port: info.port, invite_only: config.env.FORGE_INVITE_ONLY, mints: config.trustedMints.join(',') });
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    log.info('shutdown', { signal: sig });
    server.close(() => {
      deps.db.close();
      process.exit(0);
    });
    setTimeout(() => process.exit(0), 10_000).unref();
  });
}
