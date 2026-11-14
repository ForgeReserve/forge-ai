import type { BrowserContext } from 'playwright-core';

/**
 * Opens the app as on a phone that has already seen the first run (slice A6): the address a test opens
 * shows that screen, as it did before the first run existed. The first run itself is tested in
 * firstrun.ui.test.ts, on a clean profile. The mark is set before the app's own scripts run on each new
 * page, the way the app sets it when the first run is finished or skipped.
 */
export async function pastFirstRun(ctx: BrowserContext): Promise<void> {
  await ctx.addInitScript(() => {
    try {
      localStorage.setItem('forge2.firstRun', 'done');
    } catch {
      /* no storage: the app shows the first run */
    }
  });
}
