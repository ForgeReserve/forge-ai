#!/usr/bin/env bash
# Rebuilds public/vendor from pinned npm versions in a throwaway folder. The chat page loads
# nothing from third-party CDNs: every library it uses is served from the gateway's own origin.
# Versions, including every transitive one, are pinned in scripts/vendor/package-lock.json; each was
# published more than 3 days before it was pinned (the repo's minimumReleaseAge rule).
#   scripts/vendor.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/vendor"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
cp "$ROOT/scripts/vendor/package.json" "$ROOT/scripts/vendor/package-lock.json" .
npm ci --ignore-scripts --no-audit --no-fund >/dev/null
# esbuild's postinstall is skipped; its CLI finds the platform binary package directly.
ESB=./node_modules/.bin/esbuild
mkdir -p "$OUT/licenses"

# Markdown, sanitizer, syntax highlighting (ES modules).
{ echo '/* marked 18.1.3, MIT, https://github.com/markedjs/marked */'; cat node_modules/marked/lib/marked.esm.js; } > "$OUT/marked.js"
"$ESB" node_modules/dompurify/dist/purify.es.mjs --minify --format=esm --legal-comments=inline --outfile=purify.js --log-level=error
{ echo '/* DOMPurify 3.4.17, Apache-2.0 OR MPL-2.0, https://github.com/cure53/DOMPurify */'; cat purify.js; } > "$OUT/purify.js"
{ echo '/* highlight.js 11.12.0 (common languages), BSD-3-Clause, https://highlightjs.org */'; cat node_modules/@highlightjs/cdn-assets/es/highlight.min.js; } > "$OUT/highlight.js"

# QR codes: qrcode-generator 1.4.4 with the renderTo2dContext row/column fix from the donations kit.
{ echo '/* qrcode-generator 1.4.4, MIT, Kazuhiko Arase. renderTo2dContext row/col fix applied. */'; \
  sed 's/context.fillRect(row \* cellSize, col \* cellSize, cellSize, cellSize);/context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);/' node_modules/qrcode-generator/qrcode.js; } > "$OUT/qrcode.js"
{ echo '/* jsQR 1.4.0, Apache-2.0, https://github.com/cozmo/jsQR (npm jsqr@1.4.0 dist/jsQR.js, unmodified) */'; cat node_modules/jsqr/dist/jsQR.js; } > "$OUT/jsqr.js"

# NUT-16 animated QR (bc-ur fountain codes): decoder for the scanner, encoder for refunds.
cat > bcur-entry.js <<'EOF'
import { Buffer } from "buffer";
globalThis.Buffer = globalThis.Buffer || Buffer;
import { URDecoder, UREncoder, UR } from "@gandlaf21/bc-ur";
window.BCUR = {
  decoder() {
    const d = new URDecoder();
    return {
      add(part) { d.receivePart(part.toLowerCase()); },
      progress() { return d.estimatedPercentComplete(); },
      done() { return d.isComplete(); },
      result() {
        if (!d.isSuccess()) throw new Error(d.resultError() || "UR decode failed");
        return d.resultUR().decodeCBOR().toString();
      },
    };
  },
  encoder(text, maxFragment) {
    const ur = UR.fromBuffer(Buffer.from(text, "utf8"));
    const e = new UREncoder(ur, maxFragment || 200, 0);
    return { next() { return e.nextPart().toUpperCase(); }, count() { return e.fragmentsLength; } };
  },
};
EOF
"$ESB" bcur-entry.js --bundle --minify --format=iife --platform=browser --target=es2018 --legal-comments=eof --outfile=bcur.js --log-level=error
{ echo '/* @gandlaf21/bc-ur 1.1.12 (MIT) with buffer 6.0.3 (MIT), bundled by scripts/vendor.sh; exposes window.BCUR */'; cat bcur.js; } > "$OUT/bcur.js"

# Tinfoil browser SDK (EHBP + attestation), bundled with its dependencies into one ES module.
echo "export { SecureClient } from 'tinfoil';" > tf-entry.js
"$ESB" tf-entry.js --bundle --format=esm --platform=browser --target=es2020 --minify --legal-comments=eof \
  --external:zlib --external:'node:*' --external:ws --metafile=tf-meta.json --outfile=tinfoil.js --log-level=error
{ echo '/* tinfoil 1.4.0 browser SDK, Apache-2.0, https://github.com/tinfoilsh/tinfoil-js. Bundled with its dependencies; see licenses/tinfoil-bundle.txt */'; cat tinfoil.js; } > "$OUT/tinfoil.js"

# PDF text extraction (pdf.js legacy build, which also runs on older Safari), loaded only when a PDF is
# attached. The worker, CMaps (CJK text), standard fonts (page rendering) and image decoders (JPEG 2000,
# JBIG2, colour profiles) are served from our origin too. The scripting sandbox (quickjs) is left out:
# the page never runs PDF JavaScript.
PJ=node_modules/pdfjs-dist
rm -rf "$OUT/pdfjs"; mkdir -p "$OUT/pdfjs/wasm"
{ echo '/* pdfjs-dist 6.5.438 legacy build, Apache-2.0, https://github.com/mozilla/pdf.js */'; cat "$PJ/legacy/build/pdf.min.mjs"; } > "$OUT/pdfjs/pdf.min.mjs"
{ echo '/* pdfjs-dist 6.5.438 legacy build worker, Apache-2.0, https://github.com/mozilla/pdf.js */'; cat "$PJ/legacy/build/pdf.worker.min.mjs"; } > "$OUT/pdfjs/pdf.worker.min.mjs"
cp -R "$PJ/cmaps" "$PJ/standard_fonts" "$PJ/iccs" "$OUT/pdfjs/"
rm -f "$OUT"/pdfjs/standard_fonts/LICENSE_* "$OUT"/pdfjs/iccs/LICENSE
cp "$PJ"/wasm/openjpeg.wasm "$PJ"/wasm/openjpeg_nowasm_fallback.js "$PJ"/wasm/jbig2.wasm "$PJ"/wasm/jbig2_nowasm_fallback.js "$PJ"/wasm/qcms_bg.wasm "$OUT/pdfjs/wasm/"
{ for f in "$PJ"/standard_fonts/LICENSE_* "$PJ"/iccs/LICENSE "$PJ"/wasm/LICENSE_OPENJPEG "$PJ"/wasm/LICENSE_PDFJS_OPENJPEG "$PJ"/wasm/LICENSE_JBIG2 "$PJ"/wasm/LICENSE_PDFJS_JBIG2 "$PJ"/wasm/LICENSE_QCMS "$PJ"/wasm/LICENSE_PDFJS_QCMS; do
    echo "==== pdfjs-dist 6.5.438: $(basename "$(dirname "$f")")/$(basename "$f")"; echo; cat "$f"; echo; done
  echo "==== core-js 3.51.0 (MIT), polyfills compiled into the pdf.js legacy build"; echo
  echo "Copyright (c) 2013-2025 Denis Pushkarev (zloirock.ru), 2025-2026 CoreJS Company (core-js.io)"
  echo
  echo 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:'
  echo
  echo 'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.'
  echo
  echo 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.'; } > "$OUT/licenses/pdfjs-dist-assets.txt"

# Face finding for Share unseen (the v2 cover-faces filter): face-api with TensorFlow.js bundled in. The
# filter uses only its TensorFlow.js, to run YuNet (public/vendor/yunet/, made by scripts/yunet-model.ts,
# which this script leaves alone). Loaded when a photo is checked, from our origin.
FA=node_modules/@vladmandic/face-api
rm -rf "$OUT/face-api"; mkdir -p "$OUT/face-api"
{ echo '/* @vladmandic/face-api 1.7.15 (MIT) with TensorFlow.js 4.22.0 (Apache-2.0) bundled, https://github.com/vladmandic/face-api (dist/face-api.esm.js, unmodified). See licenses/face-api.txt */'; cat "$FA/dist/face-api.esm.js"; } > "$OUT/face-api/face-api.js"
{ echo "==== @vladmandic/face-api 1.7.15 (MIT): public/vendor/face-api/face-api.js"; echo; cat "$FA/LICENSE"; echo
  echo "==== face-api.js 0.22.2 (MIT), the project @vladmandic/face-api continues."; echo
  echo "MIT License"; echo; echo "Copyright (c) 2018 Vincent Mühler"; echo
  echo 'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:'
  echo; echo 'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.'; echo
  echo 'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.'; echo
  echo "==== TensorFlow.js 4.22.0 (tfjs-core, tfjs-converter, tfjs-backend-cpu, tfjs-backend-webgl, tfjs-backend-wasm), bundled into face-api.js. Copyright 2018 Google LLC. Apache License 2.0:"; echo
  cat node_modules/jsqr/LICENSE; } > "$OUT/licenses/face-api.txt"

# Licenses: one file per library, plus every package inside the Tinfoil bundle.
node - "$OUT/licenses" <<'EOF'
const fs = require('fs'), path = require('path');
const out = process.argv[2];
const lic = (dir) => { for (const n of fs.readdirSync(dir)) if (/^(licen[cs]e|copying)/i.test(n)) return fs.readFileSync(path.join(dir, n), 'utf8'); return null; };
const pkgDir = (p) => { const m = p.match(/^(.*node_modules\/(@[^/]+\/[^/]+|[^/]+))\//); return m && m[1]; };
const MIT = (who) => `MIT License\n\nCopyright (c) ${who}\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:\n\nThe above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.\n\nTHE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.\n`;
const one = { 'marked.txt': 'node_modules/marked', 'dompurify.txt': 'node_modules/dompurify', 'highlight.js.txt': 'node_modules/@highlightjs/cdn-assets', 'jsqr.txt': 'node_modules/jsqr', 'bc-ur.txt': 'node_modules/@gandlaf21/bc-ur', 'buffer.txt': 'node_modules/buffer', 'tinfoil.txt': 'node_modules/tinfoil', 'pdfjs-dist.txt': 'node_modules/pdfjs-dist' };
for (const [f, d] of Object.entries(one)) fs.writeFileSync(path.join(out, f), lic(d) ?? MIT(JSON.parse(fs.readFileSync(d + '/package.json')).author?.name ?? d));
fs.writeFileSync(path.join(out, 'qrcode-generator.txt'), MIT('2009 Kazuhiko Arase'));
const meta = JSON.parse(fs.readFileSync('tf-meta.json'));
const dirs = [...new Set(Object.keys(meta.inputs).map(pkgDir).filter(Boolean))].sort();
let txt = 'Packages bundled into tinfoil.js, with their licenses.\n';
for (const d of dirs) {
  const p = JSON.parse(fs.readFileSync(d + '/package.json'));
  txt += `\n==== ${p.name}@${p.version} (${p.license ?? 'see below'})\n\n${lic(d) ?? '(no license file in the package; license field: ' + p.license + ')'}\n`;
}
fs.writeFileSync(path.join(out, 'tinfoil-bundle.txt'), txt);
EOF
echo "vendored into $OUT"
ls -la "$OUT"
