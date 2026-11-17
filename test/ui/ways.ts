import type { Page } from 'playwright-core';

/**
 * Opens one way to add money from the wallet cards on Add money (public/v2/screens/wallet.js): its icon
 * tab, then the one big button; a way on the More card through its tile. The page must be on Add money.
 */
export async function openWay(page: Page, id: string): Promise<void> {
  await page.waitForSelector('[data-screen=addFunds]');
  // The engine's methods arrive after the first paint: wait for the way's tab or its More tile.
  await page.waitForSelector(`#tab-${id}, #more-${id}, #pair-${id}`, { state: 'attached' });
  await settled(page);
  if (await page.locator(`#pair-${id}`).count()) {
    // The Cashu card and the Fedimint card share one card when both are there: tap the printed card.
    await page.click('#tab-cards');
    await page.waitForSelector('#wayGo[data-way="cards"]', { state: 'attached' });
    await page.click(`#pair-${id}`);
  } else if (await page.locator(`#tab-${id}`).count()) {
    await page.click(`#tab-${id}`);
    // The big button names the way it opens: press it only while it is this way's, never another's.
    await page.click(`#wayGo[data-way="${id}"]`);
  } else {
    await page.click('#tab-more');
    await page.click(`#more-${id}`);
  }
}

/**
 * Waits until the ways on Add money have stopped changing. The screen is drawn once before the engine's
 * methods arrive and again after: a way can move from a card of its own to a shared card (the two card
 * ways), and a tap made between the two draws lands on a button that is about to be replaced.
 */
async function settled(page: Page): Promise<void> {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  const ways = () => page.$$eval('[id^="tab-"], [id^="more-"], [id^="pair-"]', (xs) => xs.map((x) => x.id).join(','));
  let last = await ways();
  for (let same = 0; same < 3; ) {
    await page.waitForTimeout(120);
    const now = await ways();
    same = now === last ? same + 1 : 0;
    last = now;
  }
}

/** The ids of the wallet cards, in order. */
export const wayOrder = (page: Page): Promise<string[]> => page.locator('#wayTrack .way-card').evaluateAll((cs) => cs.map((c) => c.getAttribute('data-way') ?? ''));
