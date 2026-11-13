// QR codes in Node, from the same vendored qrcode-generator the web app uses (public/vendor/qrcode.js,
// MIT, licence in public/vendor/licenses). Used by scripts/print-notes.ts and by the tests' fake camera.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

type QR = { addData(text: string, mode?: string): void; make(): void; getModuleCount(): number; isDark(r: number, c: number): boolean; createASCII(cell?: number, margin?: number): string };
type Factory = (type: number, level: string) => QR;

let factory: Factory | null = null;
function qrcode(): Factory {
  // The file is a browser script with a CommonJS fallback. Run it in its own context and take the
  // `qrcode` function it defines; nothing else from it reaches this process.
  factory ??= runInNewContext(`${readFileSync(resolve(import.meta.dirname, '../../public/vendor/qrcode.js'), 'utf8')}\n;qrcode`, {}) as Factory;
  return factory;
}

function make(text: string, level: 'L' | 'M' | 'Q' | 'H'): QR {
  const qr = qrcode()(0, level);
  qr.addData(text, /^[0-9A-Z $%*+\-./:]*$/.test(text) ? 'Alphanumeric' : 'Byte');
  qr.make();
  return qr;
}

/** The modules of a QR code, row by row (true is dark). */
export function qrMatrix(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M'): boolean[][] {
  const qr = make(text, level);
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** A crisp SVG of a QR code with a quiet zone, as the web app draws it (public/js/qr.js). */
export function qrSvg(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'M', label = 'QR code'): string {
  const m = qrMatrix(text, level);
  const n = m.length;
  const q = 4;
  // One path segment per run of dark modules in a row, to keep a sheet of many codes small.
  let d = '';
  for (let r = 0; r < n; r++)
    for (let c = 0; c < n; c++) {
      if (!m[r]![c]) continue;
      let w = 1;
      while (c + w < n && m[r]![c + w]) w++;
      d += `M${c + q} ${r + q}h${w}v1h-${w}z`;
      c += w - 1;
    }
  const size = n + q * 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="${label.replace(/[&<>"]/g, '')}"><rect width="100%" height="100%" fill="#fff"/><path fill="#000" d="${d}"/></svg>`;
}

/** A QR code drawn with block characters, for a terminal. */
export function qrText(text: string, level: 'L' | 'M' | 'Q' | 'H' = 'L'): string {
  return make(text, level).createASCII(1, 2);
}
