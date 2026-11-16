// History and auto-delete: which conversations are kept, what the History list shows, and when a
// conversation is due to be removed. Pure apart from createSweeper, which takes its clock and timers
// from the caller, so it is tested with a fake clock in Node.
//
// A conversation is removed by the time it was last used (a question asked or answered), never by the
// time it was opened. "On close" removes everything each time the app opens, and the app also starts
// removing it when the page is closed (app.js).

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** The auto-delete choices, in the order the History screen lists them. null: never; 0: on close. */
export const AUTO_DELETE = Object.freeze({ off: null, close: 0, hour: HOUR, day: DAY, week: 7 * DAY });
export const AUTO_DELETE_IDS = Object.freeze(Object.keys(AUTO_DELETE));

/** The window in ms for a setting, or null (never, or only on close). Unknown settings mean never. */
export function windowOf(setting) {
  const w = AUTO_DELETE[setting];
  return typeof w === 'number' && w > 0 ? w : null;
}

/** When a conversation was last used. */
export const lastUsed = (c) => c?.updatedAt ?? c?.createdAt ?? 0;

/**
 * The ids due for removal now. items: [{id, at}] where `at` is when each was last used.
 * opening: true when the app is being opened (the only time "on close" removes anything here).
 */
export function due(items, setting, now, { opening = false } = {}) {
  if (setting === 'close') return opening ? items.map((x) => x.id) : [];
  const w = windowOf(setting);
  if (w == null) return [];
  return items.filter((x) => (x.at ?? 0) + w <= now).map((x) => x.id);
}

/**
 * How long until the next check, in ms, or null when nothing is ever removed by time. With a timed
 * setting it is never longer than the window: anything used after now is due no sooner than now plus
 * the window, so one check at that time at the latest never misses it.
 */
export function nextCheck(items, setting, now) {
  const w = windowOf(setting);
  if (w == null) return null;
  let wait = w;
  for (const x of items) wait = Math.min(wait, (x.at ?? 0) + w - now);
  return Math.max(0, wait);
}

/** Time left before a conversation is removed: {ms, fraction, urgency}, or null when it is not timed. */
export function timeLeft(conv, setting, now) {
  const w = windowOf(setting);
  if (w == null) return null;
  const ms = Math.max(0, lastUsed(conv) + w - now);
  const fraction = Math.min(1, ms / w);
  return { ms, fraction, urgency: fraction > 0.5 ? 'plenty' : fraction > 0.15 ? 'half' : 'soon' };
}

/** "23h left" and friends: {key, n} for the string table. */
export function leftText(ms) {
  if (ms < MIN) return { key: 'left.soon', n: 0 };
  if (ms < HOUR) return { key: 'left.min', n: Math.floor(ms / MIN) };
  if (ms < 2 * DAY) return { key: 'left.hour', n: Math.floor(ms / HOUR) };
  return { key: 'left.day', n: Math.floor(ms / DAY) };
}

/** "5 min ago" and friends: {key, n} for the string table. */
export function agoText(ms) {
  if (ms < MIN) return { key: 'ago.now', n: 0 };
  if (ms < HOUR) return { key: 'ago.min', n: Math.floor(ms / MIN) };
  if (ms < DAY) return { key: 'ago.hour', n: Math.floor(ms / HOUR) };
  const n = Math.floor(ms / DAY);
  return { key: n === 1 ? 'ago.dayOne' : 'ago.day', n };
}

/** The first words of a text, cut at a word near `max` characters. */
/**
 * Markdown as plain words, for a preview (History): no stars, hashes, backticks, list marks, link
 * targets or table bars, so "**Here is**" reads "Here is".
 */
export function plainText(md) {
  return String(md ?? '')
    .replace(/```[^\n]*\n?/g, ' ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>+|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*([-*_]\s*){3,}$/gm, ' ')
    .replace(/^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-*:?\s*$/gm, ' ')
    .replace(/(\*\*|__|~~)(?=\S)([\s\S]*?\S)\1/g, '$2')
    .replace(/(^|[^\w*])[*_](?=\S)([^*_\n]*?\S)[*_](?!\w)/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/[*_`]{2,}/g, '');
}

export function firstWords(text, max = 80) {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max / 2 ? cut.slice(0, sp) : cut).replace(/[\s.,;:]+$/, '') + '...';
}

/**
 * One History card: the first question's first words (or what was added, when it had no words), the
 * first answer's first words, what kind of question started it, and its times.
 */
export function summarize(conv, setting, now) {
  const msgs = conv?.messages ?? [];
  const q = msgs.find((m) => m.role === 'user');
  const a = msgs.find((m) => m.role === 'assistant' && m.content);
  const kind = q?.images?.length ? 'image' : q?.files?.length ? 'file' : q?.meta?.voice ? 'voice' : 'text';
  return {
    id: conv.id,
    words: firstWords(q?.content ?? ''),
    // With no words, the card names the first file (a photo has no name worth showing).
    fileName: !q?.content?.trim() && q?.files?.length ? String(q.files[0].name ?? '') : '',
    answer: firstWords(plainText(a?.content ?? ''), 90),
    kind,
    at: lastUsed(conv),
    left: timeLeft(conv, setting, now),
  };
}

/** The History list: conversations with at least one question, newest first. */
export function listHistory(convs, setting, now) {
  return (convs ?? [])
    .filter((c) => c?.id && c.messages?.some((m) => m.role === 'user'))
    .sort((x, y) => lastUsed(y) - lastUsed(x))
    .map((c) => summarize(c, setting, now));
}

/**
 * Removes what is due, then waits for the next check. list() gives [{id, at}]; burn(ids) removes them.
 * timers: {setTimeout, clearTimeout}; now: the clock. Both come from the caller (a fake one in tests).
 */
export function createSweeper({ setting, list, burn, now = () => Date.now(), timers = globalThis }) {
  let handle = null;
  let stopped = false;
  const clear = () => {
    if (handle != null) timers.clearTimeout(handle);
    handle = null;
  };
  async function sweep({ opening = false } = {}) {
    clear();
    if (stopped) return [];
    const items = await list();
    const ids = due(items, setting(), now(), { opening });
    if (ids.length) await burn(ids);
    if (stopped) return ids;
    const gone = new Set(ids);
    const wait = nextCheck(
      items.filter((x) => !gone.has(x.id)),
      setting(),
      now(),
    );
    clear();
    if (wait != null) handle = timers.setTimeout(() => sweep(), Math.min(wait, 2 ** 31 - 1));
    return ids;
  }
  return {
    sweep,
    /** True while a check is waiting (for tests). */
    waiting: () => handle != null,
    stop() {
      stopped = true;
      clear();
    },
  };
}
