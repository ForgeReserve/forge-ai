import type { Page } from 'playwright-core';

/**
 * Opens one way to add money from the wallet cards on Add money (public/v2/screens/wallet.js): its icon
 * tab, then the one big button; a way on the More card through its tile. The page must be on Add money.
 */
export async function openWay(page: Page, id: string): Promise<void> {
  await page.waitForSelector('[data-screen=addFunds]');
  // The engine's methods arrive after the first paint: wait for the way's tab or its More tile.
  await page.waitForSelector(`#tab-${id}, #more-${id}, #pair-${id}`, { state: 'attached' });
  if (await page.locator(`#pair-${id}`).count()) {
    // The Cashu card and the Fedimint card share one card when both are there: tap the printed card.
    await page.click('#tab-cards');
    await page.waitForSelector('#wayGo[data-way="cards"]', { state: 'attached' });
    await page.click(`#pair-${id}`);
  } else if (await page.locator(`#tab-${id}`).count()) {
    await page.click(`#tab-${id}`);
    await page.waitForSelector(`#wayGo[data-way="${id}"]`);
    await page.click('#wayGo');
  } else {
    await page.click('#tab-more');
    await page.click(`#more-${id}`);
  }
}

/** The ids of the wallet cards, in order. */
export const wayOrder = (page: Page): Promise<string[]> => page.locator('#wayTrack .way-card').evaluateAll((cs) => cs.map((c) => c.getAttribute('data-way') ?? ''));
