// What is read aloud: the answer's Markdown turned into plain sentences, split into pieces no longer
// than a speech request takes. Pure, tested in Node.

/** The most of an answer that is read aloud. The rest is on the screen. */
export const SPEAK_MAX_CHARS = 1500;

/** Markdown to plain text that sounds right: code and tables are not read symbol by symbol. */
export function speakable(md) {
  let s = String(md ?? '');
  s = s.replace(/```[\s\S]*?(```|$)/g, ' '); // code blocks are not read aloud
  s = s.replace(/<[^>]+>/g, ' ');
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  const lines = s.split('\n').map((line) => {
    let l = line.trim();
    if (/^[\s|:-]+$/.test(l) && l.includes('-')) return ''; // table rule, or a horizontal rule
    if (l.startsWith('|')) l = l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()).filter(Boolean).join(', ') + '.';
    l = l.replace(/^#{1,6}\s+/, '').replace(/^>\s?/, '').replace(/^([-*+]|\d+[.)])\s+/, '');
    l = l.replace(/`([^`]*)`/g, '$1').replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]*?\S)\1/g, '$2');
    return l;
  });
  // A line that ends without a stop gets one, so a list is read as separate sentences.
  return lines
    .filter(Boolean)
    .map((l) => (/[.!?:;,…。！？]$/.test(l) ? l : l + '.'))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits text into sentences, keeping their stops. */
export function sentences(text) {
  return String(text ?? '')
    .split(/(?<=[.!?…。！？])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * Groups sentences into pieces of at most `max` characters. A sentence longer than that is split at a
 * comma or a space, or cut at `max` when it has neither.
 */
export function chunk(text, max) {
  if (!(max > 0)) throw new Error('max must be positive');
  const len = (s) => [...s].length;
  const parts = [];
  for (const sentence of sentences(text)) {
    let rest = sentence;
    while (len(rest) > max) {
      const head = [...rest].slice(0, max).join('');
      let cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf(' '));
      if (cut < max / 3) cut = head.length;
      else if (head[cut] === ',') cut += 1;
      parts.push(head.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
  }
  const out = [];
  for (const p of parts) {
    const last = out.at(-1);
    if (last !== undefined && len(last) + 1 + len(p) <= max) out[out.length - 1] = `${last} ${p}`;
    else out.push(p);
  }
  return out;
}

/** The pieces read aloud for an answer: plain text, at most SPEAK_MAX_CHARS, in pieces of `max`. */
export function speechPieces(markdown, max, limit = SPEAK_MAX_CHARS) {
  const text = speakable(markdown);
  const pieces = [];
  let used = 0;
  for (const p of chunk(text, max)) {
    const n = [...p].length;
    if (used + n > limit) break;
    pieces.push(p);
    used += n;
  }
  // An answer whose first piece is already over the limit still has its start read.
  if (!pieces.length && text) pieces.push(chunk(text, Math.min(max, limit))[0]);
  return pieces;
}
