import { appendFileSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startGateway, type Gateway } from '../e2e/helpers.ts';

// A new build reaches an open tab without anyone reloading it (public/v2/core/updates.js), and so does
// the next one a few seconds later. The engine serves a copy of the pages; changing a file in the copy
// is a deploy: the worker's build id is a hash of the app's files (src/sw.ts).
const PUBLIC = resolve(import.meta.dirname, '../../public');
const PHONE = { viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };

let g: Gateway;
let browser: Browser;
let site: string;

beforeAll(async () => {
  site = mkdtempSync(join(tmpdir(), 'forge-site-'));
  // The natural voice's model is large and is not part of the build id.
  cpSync(PUBLIC, site, { recursive: true, filter: (from) => !from.includes(`${sep}v2${sep}voice${sep}phonon`) });
  g = await startGateway({ publicDir: site });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  await g?.close();
  if (site) rmSync(site, { recursive: true, force: true });
});

const served = async () => (await fetch(`${g.url}/v2/sw.js`)).headers.get('x-forge-sw-version')!;
const shown = (page: Page) => page.getAttribute('html', 'data-build');

/** Changes one of the app's files, as a deploy does, and has the tab look for a newer worker. */
async function deploy(page: Page, n: number): Promise<string> {
  appendFileSync(join(site, 'v2', 'strings', 'en.js'), `\n// deploy ${n}\n`);
  const build = await served();
  await page.evaluate(() => ((window as any).__before = true));
  await page.evaluate(() => navigator.serviceWorker.getRegistration('/v2/').then((r) => r!.update()));
  return build;
}

describe('a new build in an open tab', () => {
  it('reloads the tab once for each of two deploys a few seconds apart, and not again for the same build', async () => {
    const ctx = await browser.newContext(PHONE);
    const page = await ctx.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    let loads = 0;
    page.on('load', () => loads++);
    await page.goto(`${g.url}/v2/`);
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    const first = await served();
    await expect.poll(() => shown(page)).toBe(first);
    // The first worker taking a page that had none is not an update: no reload.
    expect(loads).toBe(1);

    const second = await deploy(page, 1);
    expect(second).not.toBe(first);
    await page.waitForFunction(() => !(window as any).__before);
    await expect.poll(() => shown(page)).toBe(second);
    expect(loads).toBe(2);

    // The next deploy, seconds later: the tab reloads for it too.
    const third = await deploy(page, 2);
    expect(third).not.toBe(second);
    await page.waitForFunction(() => !(window as any).__before);
    await expect.poll(() => shown(page)).toBe(third);
    expect(loads).toBe(3);

    // The tab remembers each build it reloaded for, and nothing reloads it again.
    const made = JSON.parse((await page.evaluate(() => sessionStorage.getItem('forge2.updateReload')))!);
    expect(Object.keys(made).sort()).toEqual([second, third].sort());
    await page.evaluate(() => navigator.serviceWorker.getRegistration('/v2/').then((r) => r!.update()));
    await page.waitForTimeout(1500);
    expect(loads).toBe(3);
    expect(errors).toEqual([]);
    await ctx.close();
  }, 60_000);
});
