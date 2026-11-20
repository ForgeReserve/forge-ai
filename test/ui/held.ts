import type { Page } from 'playwright-core';

// eCash is spent by whoever reads it, so the eCash box never writes a code it was not typed or pasted
// (scanned, or handed over by another way) into the page: it holds it and shows dots
// (public/v2/modules/fund/kit.js tokenBox). These read the page as someone looking at it could.

/** What the box shows for a code it holds. */
export const DOTS = '•'.repeat(24);

/** The box's text and whether it is marked as holding a code. */
export const boxState = (page: Page, selector = '#ecashToken') => page.$eval(selector, (e) => ({ value: (e as HTMLTextAreaElement).value, held: e.hasAttribute('data-held') }));

/**
 * Where on the page a secret can be read: in its markup (every attribute, dataset and aria text) or in a
 * field's value, which the markup does not carry. Looks for the whole secret and for 20-letter pieces of
 * it (its start after any prefix, its middle, its end), so a code cut or wrapped is found too.
 * Empty when it is nowhere.
 */
export const seenAt = (page: Page, secret: string) =>
  page.evaluate((s) => {
    const mid = Math.floor(s.length / 2) - 10;
    const pieces = s.length < 40 ? [s] : [s, s.slice(10, 30), s.slice(mid, mid + 20), s.slice(-25, -5)];
    const has = (text: string) => pieces.some((p) => text.toLowerCase().includes(p.toLowerCase()));
    const out: string[] = [];
    if (has(document.documentElement.outerHTML)) out.push('markup');
    for (const e of document.querySelectorAll('input, textarea')) if (has((e as HTMLInputElement).value)) out.push(`#${e.id || e.tagName.toLowerCase()}`);
    return out;
  }, secret);
