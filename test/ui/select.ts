import type { Page } from 'playwright-core';

/**
 * Selecting text (style.css, "What a person can select"). The app is driven by long presses, so the
 * interface's own words are never selectable: a long press on a control must not select a word and
 * bring up the phone's Copy menu. The content stays selectable: an answer and its code, the question
 * asked, an address or code the screen shows, and what is typed in a field.
 */
export const CHROME =
  'button, [role=button], [role=tab], [role=radio], [role=switch], [role=checkbox], a.btn, label, h1, h2, h3, .chip, .pill-balance, .pill-private, .caps, .lead, .note, .hint, [class*="card"], [class*="tile"], .row';
export const CONTENT = 'input, textarea, [contenteditable], .answer-body, .answer-body *, .asked, .pf-text, .pf-text *, .pf-asked, .mono, .hash';
/** Controls inside content: a code block's head (its language and Copy) in an answer. */
const CONTROL_IN_CONTENT = 'button, [role=button], .code-head';

/**
 * The visible interface parts on the page that can still be selected, and the visible content that
 * cannot, each with its computed user-select; and how many of each were looked at.
 */
export const selection = (page: Page) =>
  page.evaluate(
    ([chrome, content, control]) => {
      const name = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}${typeof e.className === 'string' && e.className.trim() ? `.${e.className.trim().split(/\s+/).join('.')}` : ''}`;
      const value = (e: Element) => {
        const s = getComputedStyle(e) as CSSStyleDeclaration & { webkitUserSelect?: string };
        return s.userSelect || s.webkitUserSelect || '';
      };
      const shown = (e: Element) => e.getClientRects().length > 0 && !e.closest('.sr-only, [hidden], [aria-hidden="true"]');
      const out = { chrome: 0, content: 0, selectable: [] as string[], unselectable: [] as string[] };
      for (const e of document.querySelectorAll(chrome!)) {
        if (!shown(e) || (e.closest(content!) && !e.closest(control!))) continue;
        out.chrome++;
        if (value(e) !== 'none') out.selectable.push(`${name(e)}: ${value(e)}`);
      }
      for (const e of document.querySelectorAll(content!)) {
        if (!shown(e) || e.closest(control!)) continue;
        out.content++;
        if (value(e) !== 'text') out.unselectable.push(`${name(e)}: ${value(e)}`);
      }
      return out;
    },
    [CHROME, CONTENT, CONTROL_IN_CONTENT],
  );

/** The text a double click on `selector` selects (a desktop's way to select a word). */
export const wordAt = async (page: Page, selector: string) => {
  await page.evaluate(() => getSelection()?.removeAllRanges());
  await page.dblclick(selector);
  return page.evaluate(() => getSelection()?.toString() ?? '');
};
