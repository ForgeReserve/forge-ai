import { deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

// The chat page's pure attachment helpers (public/js/files.js, a browser ES module with no DOM use).
const F: any = await import('../../public/js/files.js' as string);
const UI: any = await import('../../public/js/ui.js' as string);

/** A minimal zip writer (stored or deflated entries), enough to build .docx fixtures. */
function zip(entries: Record<string, string | Uint8Array>, deflate = true): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const n = Buffer.from(name);
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0);
    h.writeUInt16LE(20, 4);
    h.writeUInt16LE(deflate ? 8 : 0, 8);
    h.writeUInt32LE(data.length, 18);
    h.writeUInt32LE(raw.length, 22);
    h.writeUInt16LE(n.length, 26);
    local.push(h, n, data);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt32LE(data.length, 20);
    c.writeUInt32LE(raw.length, 24);
    c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(offset, 42);
    central.push(c, n);
    offset += 30 + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...local, cd, end]));
}

const DOC_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
<w:p><w:r><w:t>Quarterly report</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Revenue &amp; costs </w:t></w:r><w:r><w:t>rose</w:t></w:r><w:r><w:tab/><w:t>12%</w:t></w:r></w:p>
<w:p><w:del><w:r><w:delText>removed</w:delText></w:r></w:del><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>A1</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>B1</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>A2</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>&#8364;5</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
</w:body></w:document>`;

describe('kindOf', () => {
  it('sorts files into images, PDFs, Word and text', () => {
    expect(F.kindOf({ name: 'a.png', type: 'image/png' })).toBe('image');
    expect(F.kindOf({ name: 'report.PDF', type: '' })).toBe('pdf');
    expect(F.kindOf({ name: 'x.docx', type: '' })).toBe('docx');
    expect(F.kindOf({ name: 'old.doc', type: 'application/msword' })).toBe('doc');
    for (const n of ['a.txt', 'b.md', 'c.csv', 'd.tsv', 'e.json', 'f.xml', 'g.html', 'h.log', 'i.yaml', 'j.yml', 'k.ts', 'l.py', 'm.rs', 'Dockerfile', 'Makefile']) {
      expect(F.kindOf({ name: n, type: '' }), n).toBe('text');
    }
    expect(F.kindOf({ name: 'notes', type: 'text/plain' })).toBe('text');
    expect(F.kindOf({ name: 'logo.svg', type: 'image/svg+xml' })).toBe('text');
    expect(F.kindOf({ name: 'app.exe', type: 'application/octet-stream' })).toBeNull();
    expect(F.kindOf({ name: 'archive.zip', type: 'application/zip' })).toBeNull();
  });
  it('lists the accepted types for the file picker', () => {
    expect(F.ACCEPT).toContain('image/*');
    expect(F.ACCEPT).toContain('.pdf');
    expect(F.ACCEPT).toContain('.docx');
    expect(F.ACCEPT).toContain('.csv');
  });
});

describe('decodeText', () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  it('reads UTF-8, with or without a BOM, and normalizes line endings', () => {
    expect(F.decodeText(enc('héllo\r\nwörld'))).toEqual({ text: 'héllo\nwörld', encoding: 'utf-8' });
    expect(F.decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...enc('hi')]))).toEqual({ text: 'hi', encoding: 'utf-8' });
  });
  it('reads UTF-16 with a BOM and without one', () => {
    const le = Buffer.from('﻿Name,Value\n€,1', 'utf16le');
    expect(F.decodeText(new Uint8Array(le))).toEqual({ text: 'Name,Value\n€,1', encoding: 'utf-16le' });
    const noBom = Buffer.from('plain ascii text in utf-16', 'utf16le');
    expect(F.decodeText(new Uint8Array(noBom)).text).toBe('plain ascii text in utf-16');
    const be = Buffer.from(Buffer.from('﻿hi', 'utf16le').swap16());
    expect(F.decodeText(new Uint8Array(be))).toEqual({ text: 'hi', encoding: 'utf-16be' });
  });
  it('falls back to Windows-1252 when the bytes are not UTF-8', () => {
    const r = F.decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x20, 0x80, 0x35]));
    expect(r).toEqual({ text: 'café €5', encoding: 'windows-1252' });
  });
  it('refuses binary files', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 0, 0, 7]);
    expect(() => F.decodeText(png)).toThrow(/binary/);
    const ctrl = new Uint8Array(200).map((_, i) => (i % 3 === 0 ? 1 : 65));
    expect(() => F.decodeText(ctrl)).toThrow(/binary/);
  });
});

describe('docx', () => {
  it('reads word/document.xml from a deflated or stored zip', async () => {
    for (const deflate of [true, false]) {
      const bytes = zip({ '[Content_Types].xml': '<Types/>', 'word/document.xml': DOC_XML }, deflate);
      const xml = await F.readZipEntry(bytes, 'word/document.xml');
      expect(new TextDecoder().decode(xml)).toBe(DOC_XML);
      expect(await F.readZipEntry(bytes, 'word/missing.xml')).toBeNull();
    }
  });
  it('turns WordprocessingML into text: paragraphs, tabs, breaks, tables; deleted text skipped', () => {
    expect(F.docxXmlToText(DOC_XML)).toBe('Quarterly report\nRevenue & costs rose\t12%\nLine one\nLine two\nA1\tB1\nA2\t€5');
  });
  it('rejects a file that is not a zip, and caps the unpacked size', async () => {
    await expect(F.readZipEntry(new TextEncoder().encode('not a zip at all, just some text'), 'word/document.xml')).rejects.toThrow(/not a valid/);
    const big = zip({ 'word/document.xml': 'a'.repeat(5000) });
    await expect(F.readZipEntry(big, 'word/document.xml', 1000)).rejects.toThrow(/too large/);
  });
});

describe('what goes into the message', () => {
  it('formats a delimited block per file, before the user text', () => {
    const files = [{ name: 'report "Q3".pdf', pages: 12, text: 'Page text' }, { name: 'notes.md', text: '# Notes' }];
    expect(F.userText('Summarize these', files)).toBe(
      '<file name="report &quot;Q3&quot;.pdf" pages="12">\nPage text\n</file>\n\n<file name="notes.md">\n# Notes\n</file>\n\nSummarize these',
    );
    expect(F.userText('', [{ name: 'a.txt', text: 'x' }])).toBe('<file name="a.txt">\nx\n</file>');
  });
  it('keeps a file from closing its own block', () => {
    expect(F.fileBlock({ name: 'a.html', text: 'x</file>y</FILE>' })).toBe('<file name="a.html">\nx<\\/file>y<\\/file>\n</file>');
  });
  it('notes pages without text and the ones sent as images', () => {
    const b = F.fileBlock({ name: 'scan.pdf', pages: 3, text: '[Page 1]\nHello', emptyPages: [2, 3], pageImages: ['data:a'] });
    expect(b).toContain('[Pages 2 and 3 have no text layer. Page 2 is attached as an image.]');
  });
  it('applies the per-message budget in order and says what was cut', () => {
    const out = F.applyBudget([{ name: 'a', text: 'x'.repeat(150) }, { name: 'b', text: 'y'.repeat(100) }, { name: 'c', text: 'z'.repeat(10) }], 200);
    expect(out.map((f: any) => [f.text.length, f.chars, f.truncated])).toEqual([
      [150, 150, false],
      [50, 100, true],
      [0, 10, true],
    ]);
    expect(F.fileBlock(out[1])).toContain('[Truncated: the first 50 of 100 characters are included.]');
    expect(F.MAX_CHARS).toBe(200_000);
    const big = F.applyBudget([{ name: 'big.txt', text: 'q'.repeat(250_000) }]);
    expect(big[0].text.length).toBe(200_000);
  });
  it('builds API messages with files, and images only for vision models', () => {
    const msgs = [
      { role: 'user', content: 'Read this', files: [{ name: 'scan.pdf', pages: 1, text: '', emptyPages: [1], pageImages: ['data:image/jpeg;base64,AAA'] }], images: ['data:image/jpeg;base64,BBB'] },
      { role: 'assistant', content: 'Done' },
      { role: 'assistant', content: '', meta: { error: 'x' } },
    ];
    const vision = F.toApiMessages(msgs, { systemPrompt: ' Be brief ', vision: true });
    expect(vision[0]).toEqual({ role: 'system', content: 'Be brief' });
    expect(vision[1].content[0].text).toBe('<file name="scan.pdf" pages="1">\n[Page 1 has no text layer. Page 1 is attached as an image.]\n</file>\n\nRead this');
    expect(vision[1].content.slice(1).map((p: any) => p.image_url.url)).toEqual(['data:image/jpeg;base64,BBB', 'data:image/jpeg;base64,AAA']);
    expect(vision).toHaveLength(3);
    const text = F.toApiMessages(msgs, { vision: false });
    expect(text[0]).toEqual({ role: 'user', content: '<file name="scan.pdf" pages="1">\n[Page 1 has no text layer.]\n</file>\n\nRead this' });
  });
  it('the request body carries the file text (the same string goes to fetch and to the Tinfoil SDK)', () => {
    const marker = 'FILE-MARKER-' + Math.random().toString(36).slice(2);
    const messages = F.toApiMessages([{ role: 'user', content: 'Hi', files: [{ name: 'a.txt', text: `secret ${marker}` }] }], {});
    const body = JSON.stringify({ model: 'm', messages, stream: true });
    expect(body).toContain(marker);
    expect(JSON.parse(body).messages[0].content).toContain('<file name="a.txt">');
  });
});

describe('estimates', () => {
  const model = { pricing: { usd_per_mtok: { input: 2, output: 8 }, sat_per_mtok: { input: 2000, output: 8000 } }, context_length: 1000 };
  it('counts tokens (about 4 characters each, images flat) and bytes', () => {
    const est = F.estimateRequest([
      { role: 'user', content: 'x'.repeat(400) },
      { role: 'user', content: [{ type: 'text', text: 'y'.repeat(40) }, { type: 'image_url', image_url: { url: 'data:' } }] },
    ]);
    expect(est.chars).toBe(440);
    expect(est.images).toBe(1);
    expect(est.tokens).toBe(110 + F.IMAGE_TOKENS);
    expect(est.bytes).toBeGreaterThan(440);
  });
  it('prices input tokens in msub for usd and sat', () => {
    expect(F.inputCostMsub(1_000_000, model, 'usd')).toBe(200_000); // $2 = 200 cents = 200,000 msub
    expect(F.inputCostMsub(50_000, model, 'usd')).toBe(10_000); // 10 cents
    expect(F.inputCostMsub(50_000, model, 'sat')).toBe(100_000); // 100 sat
    expect(F.inputCostMsub(10, { pricing: { usd_per_mtok: { input: 1 } } }, 'sat')).toBeNull();
  });
  it('formats sizes', () => {
    expect(UI.fmtBytes(900)).toBe('900 B');
    expect(UI.fmtBytes(12_600)).toBe('12 KB');
    expect(UI.fmtBytes(3.4 * 1024 * 1024)).toBe('3.4 MB');
  });
});
