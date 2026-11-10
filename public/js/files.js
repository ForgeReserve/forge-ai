// File attachments: pure helpers shared by the chat page and the unit tests (no DOM here).
// Files are read in the browser. Only their text, or page images for vision models, goes into the
// message; the file itself is never uploaded. Extraction that needs the DOM or pdf.js is in extract.js.

export const MAX_CHARS = 200_000; // file text per message, all files together
export const MAX_FILES = 8; // documents per message
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_PAGE_IMAGES = 4; // scanned PDF pages sent as images, per message
export const PAGE_IMAGE_MAX_PX = 1280; // longest side of a rendered page
export const IMAGE_TOKENS = 800; // rough input tokens per attached image
export const BODY_LIMIT = 1_000_000; // the gateway's default FORGE_MAX_BODY_BYTES

const TEXT_EXT = new Set(
  (
    'txt text md markdown mdx rst adoc org tex csv tsv json jsonl ndjson geojson xml html htm xhtml svg log yaml yml toml ini cfg conf properties env ' +
    'srt vtt diff patch sql graphql gql proto css scss sass less js mjs cjs jsx ts mts cts tsx vue svelte astro py pyi ipynb rb php pl pm lua r ' +
    'java kt kts scala groovy gradle swift m mm c h cc cpp cxx hpp hh cs fs go rs zig nim dart ex exs erl hrl clj cljs edn hs elm ml mli ' +
    'sh bash zsh fish ps1 psm1 bat cmd sol move cairo tf hcl nix lock gitignore dockerignore editorconfig'
  ).split(' '),
);
const TEXT_NAMES = new Set(['dockerfile', 'makefile', 'license', 'readme', 'changelog', 'procfile', 'gemfile', 'rakefile', 'justfile', 'caddyfile']);
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-yaml|yaml|toml|javascript|x-sh|sql|ld\+json|x-ndjson))/;

export const ACCEPT = ['image/*', '.pdf', '.docx', ...[...TEXT_EXT].map((e) => '.' + e)].join(',');

const extOf = (name) => {
  const n = String(name ?? '').toLowerCase();
  const i = n.lastIndexOf('.');
  return i > 0 ? n.slice(i + 1) : n.startsWith('.') ? n.slice(1) : '';
};

/** 'image' | 'pdf' | 'docx' | 'text' | 'doc' (old Word, refused) | null (not supported). */
export function kindOf({ name, type }) {
  const ext = extOf(name);
  const t = String(type ?? '').toLowerCase();
  if (t.startsWith('image/') && ext !== 'svg') return 'image';
  if (ext === 'pdf' || t === 'application/pdf') return 'pdf';
  if (ext === 'docx' || t === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return 'docx';
  if (ext === 'doc' || t === 'application/msword') return 'doc';
  if (TEXT_EXT.has(ext) || TEXT_NAMES.has(String(name ?? '').toLowerCase()) || TEXT_TYPES.test(t)) return 'text';
  return null;
}

export class FileError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Decodes the bytes of a text file. UTF-8 first (with or without BOM), UTF-16 when a BOM or the
 * byte pattern says so, else Windows-1252. Binary content (NUL bytes, many control characters) is refused.
 */
export function decodeText(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dec = (enc, data, fatal = false) => new TextDecoder(enc, { fatal }).decode(data);
  const clean = (s) => s.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return { text: clean(dec('utf-8', b.subarray(3))), encoding: 'utf-8' };
  if (b[0] === 0xff && b[1] === 0xfe) return { text: clean(dec('utf-16le', b.subarray(2))), encoding: 'utf-16le' };
  if (b[0] === 0xfe && b[1] === 0xff) return { text: clean(dec('utf-16be', b.subarray(2))), encoding: 'utf-16be' };
  const sample = b.subarray(0, 65536);
  let nulEven = 0;
  let nulOdd = 0;
  let ctrl = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample[i];
    if (c === 0) i % 2 ? nulOdd++ : nulEven++;
    else if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  const half = sample.length / 2;
  if (nulEven + nulOdd) {
    // UTF-16 without a BOM: ASCII-range text puts a zero in every other byte.
    if (nulOdd > half * 0.3 && nulEven < half * 0.02) return { text: clean(dec('utf-16le', b)), encoding: 'utf-16le' };
    if (nulEven > half * 0.3 && nulOdd < half * 0.02) return { text: clean(dec('utf-16be', b)), encoding: 'utf-16be' };
    throw new FileError('binary', 'This file looks binary, not text.');
  }
  if (sample.length && ctrl / sample.length > 0.05) throw new FileError('binary', 'This file looks binary, not text.');
  try {
    return { text: clean(dec('utf-8', b, true)), encoding: 'utf-8' };
  } catch {
    return { text: clean(dec('windows-1252', b)), encoding: 'windows-1252' };
  }
}

// ------------------------------------------------------------------ DOCX (a zip with word/document.xml)

/**
 * Reads one entry of a zip archive with the browser's own DecompressionStream (deflate-raw), so no
 * zip library is needed. Returns null when the entry is missing.
 */
export async function readZipEntry(bytes, want, maxBytes = 50 * 1024 * 1024) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  // End of central directory: the last 0x06054b50 within the final 64 KB + 22 bytes.
  let eocd = -1;
  for (let i = b.length - 22; i >= Math.max(0, b.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new FileError('not_zip', 'This file is not a valid .docx document.');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const td = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (p + 46 > b.length || dv.getUint32(p, true) !== 0x02014b50) throw new FileError('not_zip', 'This file is not a valid .docx document.');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const xlen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = td.decode(b.subarray(p + 46, p + 46 + nlen));
    p += 46 + nlen + xlen + clen;
    if (name !== want) continue;
    if (usize > maxBytes) throw new FileError('too_large', 'This document is too large to read.');
    const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
    const data = b.subarray(start, start + csize);
    if (method === 0) return data;
    if (method !== 8) throw new FileError('unsupported', 'This document uses a compression the page cannot read.');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    const reader = stream.getReader();
    const parts = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new FileError('too_large', 'This document is too large to read.');
      }
      parts.push(value);
    }
    const out = new Uint8Array(total);
    let o = 0;
    for (const part of parts) (out.set(part, o), (o += part.length));
    return out;
  }
  return null;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unescapeXml = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });

/**
 * Plain text from WordprocessingML (word/document.xml): paragraphs become lines, tabs and breaks are
 * kept, table cells are separated by tabs and rows by new lines. Deleted text (tracked changes) is skipped.
 */
export function docxXmlToText(xml) {
  let out = '';
  let inText = false;
  let deleted = 0;
  const re = /<(\/?)([\w:]+)([^>]*?)(\/?)>|([^<]+)/g;
  for (let m; (m = re.exec(xml)); ) {
    if (m[5] !== undefined) {
      if (inText && !deleted) out += unescapeXml(m[5]);
      continue;
    }
    const close = m[1] === '/';
    const tag = m[2];
    const self = m[4] === '/';
    if (tag === 'w:t') inText = !close && !self;
    else if (tag === 'w:del') deleted += close ? -1 : self ? 0 : 1;
    else if (close && tag === 'w:p') out += '\n';
    else if (close && tag === 'w:tc') out = out.replace(/\n$/, '') + '\t';
    else if (close && tag === 'w:tr') out = out.replace(/\t$/, '') + '\n';
    else if (!close && (tag === 'w:tab' || tag === 'w:ptab')) out += '\t';
    else if (!close && (tag === 'w:br' || tag === 'w:cr')) out += '\n';
    else if (!close && tag === 'w:noBreakHyphen') out += '-';
  }
  return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ------------------------------------------------------------------ what goes into the message

const escAttr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const pageList = (ns) => (ns.length === 1 ? `Page ${ns[0]}` : `Pages ${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`);

/**
 * Cuts file texts to the per-message budget, in order: the first files keep all their text, a later
 * one is truncated, and any after it get none. Returns copies with `text`, `chars` (the full length)
 * and `truncated`.
 */
export function applyBudget(files, max = MAX_CHARS) {
  let left = max;
  return files.map((f) => {
    const full = f.chars ?? f.text.length;
    const text = f.text.length > left ? f.text.slice(0, left) : f.text;
    left -= text.length;
    return { ...f, text, chars: full, truncated: text.length < full };
  });
}

/** One clearly delimited block per file: <file name="report.pdf" pages="12">...</file>. */
export function fileBlock(f) {
  const attrs = [`name="${escAttr(f.name)}"`];
  if (f.pages) attrs.push(`pages="${f.pages}"`);
  const notes = [];
  if (f.truncated) notes.push(`[Truncated: the first ${f.text.length.toLocaleString('en-US')} of ${f.chars.toLocaleString('en-US')} characters are included.]`);
  if (f.emptyPages?.length) {
    const sent = f.pageImages?.length ? f.emptyPages.slice(0, f.pageImages.length) : [];
    notes.push(`[${pageList(f.emptyPages)} ${f.emptyPages.length === 1 ? 'has' : 'have'} no text layer.${sent.length ? ` ${pageList(sent)} ${sent.length === 1 ? 'is' : 'are'} attached as ${sent.length === 1 ? 'an image' : 'images'}.` : ''}]`);
  }
  // A file cannot close its own block early.
  const body = String(f.text).replace(/<\/file>/gi, '<\\/file>');
  return `<file ${attrs.join(' ')}>\n${body}${notes.length ? (body ? '\n' : '') + notes.join('\n') : ''}\n</file>`;
}

/** The text of a user message: file blocks first, then what the user typed. */
export function userText(text, files = []) {
  const blocks = files.map(fileBlock);
  return [...blocks, text ?? ''].filter((s) => s !== '').join('\n\n');
}

/** OpenAI chat messages for a stored conversation. Images and page images go only to vision models. */
export function toApiMessages(messages, { systemPrompt = '', vision = false } = {}) {
  const out = [];
  if (systemPrompt.trim()) out.push({ role: 'system', content: systemPrompt.trim() });
  for (const m of messages) {
    if (m.meta?.error) continue;
    if (m.role === 'assistant') {
      if (m.content) out.push({ role: 'assistant', content: m.content });
      continue;
    }
    const files = (m.files ?? []).map((f) => (vision ? f : { ...f, pageImages: undefined }));
    const text = userText(m.content, files);
    const images = vision ? [...(m.images ?? []), ...files.flatMap((f) => f.pageImages ?? [])] : [];
    if (images.length) out.push({ role: 'user', content: [{ type: 'text', text }, ...images.map((url) => ({ type: 'image_url', image_url: { url } }))] });
    else out.push({ role: 'user', content: text });
  }
  return out;
}

/** Rough size of a request: characters, images, input tokens (about 4 characters each) and body bytes. */
export function estimateRequest(apiMessages) {
  let chars = 0;
  let images = 0;
  for (const m of apiMessages) {
    if (typeof m.content === 'string') chars += m.content.length;
    else
      for (const p of m.content) {
        if (p.type === 'text') chars += p.text.length;
        else images++;
      }
  }
  const bytes = new TextEncoder().encode(JSON.stringify(apiMessages)).length;
  return { chars, images, tokens: Math.ceil(chars / 4) + images * IMAGE_TOKENS, bytes };
}

/** Input cost of `tokens` at a model's listed price, in msub (thousandths of the unit). */
export function inputCostMsub(tokens, model, unit) {
  const p = model?.pricing;
  if (!p) return null;
  if (unit === 'sat') return p.sat_per_mtok ? Math.ceil((tokens * p.sat_per_mtok.input) / 1000) : null; // sat/1M tok * 1000 msub/sat
  return Math.ceil((tokens * p.usd_per_mtok.input) / 10); // usd/1M tok * 100000 msub/usd
}
