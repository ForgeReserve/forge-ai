// Reads an attached document in the browser. Loaded on the first attachment; pdf.js loads only for a
// PDF. Nothing here talks to the network except fetching our own vendored files.
import { decodeText, docxXmlToText, FileError, kindOf, MAX_FILE_BYTES, MAX_PAGE_IMAGES, PAGE_IMAGE_MAX_PX, readZipEntry } from './files.js';

const PDFJS = new URL('../vendor/pdfjs/', import.meta.url).href;
let pdfjsP = null;
function pdfjs() {
  pdfjsP ??= import('../vendor/pdfjs/pdf.min.mjs').then((m) => {
    m.GlobalWorkerOptions.workerSrc = PDFJS + 'pdf.worker.min.mjs';
    return m;
  });
  pdfjsP.catch(() => (pdfjsP = null));
  return pdfjsP;
}

/**
 * Extracts a document's text. Returns {kind, text, pages?, emptyPages?, doc?}; `doc` is the open
 * pdf.js document, kept so scanned pages can be rendered later, and must be released with release().
 */
export async function extract(file, { onProgress = () => {} } = {}) {
  const kind = kindOf(file);
  if (kind === 'doc') throw new FileError('unsupported', 'Old Word (.doc) files cannot be read. Save it as .docx or PDF.');
  if (!kind || kind === 'image') throw new FileError('unsupported', 'This file type is not supported.');
  if (file.size > MAX_FILE_BYTES) throw new FileError('too_large', 'Files up to 25 MB can be attached.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (kind === 'text') return { kind, ...decodeText(bytes) };
  if (kind === 'docx') {
    const xml = await readZipEntry(bytes, 'word/document.xml');
    if (!xml) throw new FileError('not_docx', 'This file is not a Word document.');
    return { kind, text: docxXmlToText(new TextDecoder().decode(xml)) };
  }
  return extractPdf(bytes, onProgress);
}

async function extractPdf(bytes, onProgress) {
  const lib = await pdfjs();
  let doc;
  try {
    doc = await lib.getDocument({
      data: bytes,
      cMapUrl: PDFJS + 'cmaps/',
      cMapPacked: true,
      standardFontDataUrl: PDFJS + 'standard_fonts/',
      wasmUrl: PDFJS + 'wasm/',
      iccUrl: PDFJS + 'iccs/',
      enableXfa: false,
    }).promise;
  } catch (e) {
    if (e?.name === 'PasswordException') throw new FileError('password', 'This PDF is password protected.');
    throw new FileError('bad_pdf', 'This PDF could not be read.');
  }
  const parts = [];
  const emptyPages = [];
  for (let n = 1; n <= doc.numPages; n++) {
    onProgress(n, doc.numPages);
    const page = await doc.getPage(n);
    const tc = await page.getTextContent();
    let t = '';
    for (const it of tc.items) {
      if (typeof it.str !== 'string') continue;
      t += it.str;
      if (it.hasEOL) t += '\n';
    }
    page.cleanup();
    t = t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    if (t.replace(/\s/g, '').length < 8) emptyPages.push(n);
    parts.push(`[Page ${n}]\n${t}`);
  }
  return { kind: 'pdf', text: parts.join('\n\n'), pages: doc.numPages, emptyPages, doc };
}

/** Renders PDF pages to JPEG data URLs, at most MAX_PAGE_IMAGES and PAGE_IMAGE_MAX_PX on the long side. */
export async function renderPages(doc, pageNumbers) {
  const out = [];
  for (const n of pageNumbers.slice(0, MAX_PAGE_IMAGES)) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(2, PAGE_IMAGE_MAX_PX / Math.max(base.width, base.height));
    const vp = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(vp.width);
    canvas.height = Math.round(vp.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;
    out.push(canvas.toDataURL('image/jpeg', 0.8));
    page.cleanup();
    canvas.width = canvas.height = 0;
  }
  return out;
}

export function release(doc) {
  try {
    doc?.destroy();
  } catch {
    /* already gone */
  }
}
