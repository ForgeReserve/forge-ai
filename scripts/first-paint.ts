/**
 * Measures the v2 app's first paint on a throttled phone profile: CPU 4x slower, the DevTools "Slow 4G"
 * network (562.5 ms round trip, 1.6 Mbps down, 750 kbps up), a fresh profile with nothing cached and no
 * service worker, opening /v2/ on the first run. Reports first contentful paint, the time the first run
 * screen is drawn, and the requests made before it.
 *
 *   node scripts/first-paint.ts [runs=3] [--h2] [--gzip] [--list]
 *
 * Serves the repo's public/ from a local gateway with the test catalog (no keys, no mints needed for the
 * page itself). --h2 serves it over TLS with HTTP/2, as Caddy does in production, with a throwaway
 * self-signed certificate made by openssl in a temp folder. --gzip compresses responses, as Caddy does. Uses the installed Chrome (channel 'chrome').
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import http2 from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { chromium } from 'playwright-core';
import { createApp } from '../src/app.ts';
import { loadConfig } from '../src/config.ts';
import { buildDeps } from '../src/deps.ts';
import { setLogSilent } from '../src/log.ts';
import { fixedRateSource } from '../src/rates.ts';
import { testCatalog } from '../test/e2e/helpers.ts';

setLogSilent(true);
const runs = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3);
const h2 = process.argv.includes('--h2');
const gzip = process.argv.includes('--gzip');

const dir = mkdtempSync(join(tmpdir(), 'forge-paint-'));
const env = { FORGE_DB_PATH: join(dir, 'forge.db'), FORGE_TRUSTED_MINTS: 'http://127.0.0.1:3338', FORGE_FOREIGN_DISCOVERY_RELAYS: '', FORGE_RATE_LIMIT_RPM: '100000' };
const config = loadConfig(env as NodeJS.ProcessEnv, testCatalog());
const deps = buildDeps(config, { rateSources: [fixedRateSource('fixed', 100_000)], env: env as NodeJS.ProcessEnv });
const gateway = createApp(deps);
// --gzip: compress responses as Caddy does in production (encode zstd gzip); the gateway itself does not.
const app = gzip ? new Hono().use(compress({ encoding: 'gzip' })).route('/', gateway) : gateway;

let serverOpts: Parameters<typeof serve>[0] = { fetch: app.fetch, port: 0, hostname: '127.0.0.1' };
if (h2) {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1'], { stdio: 'ignore' });
  serverOpts = { ...serverOpts, createServer: http2.createSecureServer, serverOptions: { key: readFileSync(key), cert: readFileSync(cert), allowHTTP1: true } } as typeof serverOpts;
}
const server = await new Promise<ReturnType<typeof serve>>((resolve) => {
  const s = serve(serverOpts, () => resolve(s));
});
const port = (server.address() as AddressInfo).port;
const base = `${h2 ? 'https' : 'http'}://127.0.0.1:${port}`;

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const results: Array<{ fcp: number; intro: number; requests: number; kb: number }> = [];
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, ignoreHTTPSErrors: true, serviceWorkers: 'block' });
  await ctx.addInitScript(() => {
    const w = window as any;
    w.__paint = {};
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__paint[e.name] = e.startTime;
    }).observe({ type: 'paint', buffered: true });
    // The first run screen is drawn: the frame after it is in the page.
    const seen = () => {
      if (w.__paint.intro || !document.querySelector('[data-screen=intro]')) return false;
      requestAnimationFrame(() => requestAnimationFrame(() => (w.__paint.intro ??= performance.now())));
      return true;
    };
    new MutationObserver((_, obs) => seen() && obs.disconnect()).observe(document, { childList: true, subtree: true });
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 * 0.9) / 8, uploadThroughput: (750 * 1024 * 0.9) / 8 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`${base}/v2/`, { waitUntil: 'commit' });
  await page.waitForFunction(() => (window as any).__paint.intro, null, { timeout: 120_000, polling: 100 });
  const paint = await page.evaluate(() => (window as any).__paint);
  const introAt = paint.intro as number;
  // Requests finished before the first run was drawn (the page itself included), and their bytes.
  const before = await page.evaluate((at) => {
    const all = [...performance.getEntriesByType('navigation'), ...performance.getEntriesByType('resource')] as PerformanceResourceTiming[];
    const done = all.filter((e) => e.responseEnd <= at);
    return { n: done.length, bytes: done.reduce((s, e) => s + (e.transferSize || e.encodedBodySize || 0), 0), names: done.map((e) => e.name.replace(/^https?:\/\/[^/]+/, '')) };
  }, introAt);
  if (process.argv.includes('--list') && i === 0) console.log(before.names.join('\n'));
  results.push({ fcp: Math.round(paint['first-contentful-paint'] ?? NaN), intro: Math.round(introAt), requests: before.n, kb: Math.round(before.bytes / 1024) });
  await ctx.close();
}
await browser.close();
(server as any).closeAllConnections?.();
server.close();
deps.db.close();

const med = (k: keyof (typeof results)[0]) => results.map((r) => r[k]).sort((a, b) => a - b)[Math.floor(results.length / 2)];
console.log(JSON.stringify({ protocol: h2 ? 'h2' : 'http/1.1', gzip, runs: results, median: { fcp_ms: med('fcp'), first_run_ms: med('intro'), requests: med('requests'), kb: med('kb') } }, null, 1));
