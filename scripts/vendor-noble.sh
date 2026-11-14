#!/usr/bin/env bash
# Builds public/vendor/noble.js: the parts of @noble/curves and @noble/hashes the v2 app needs for the
# Cashu card (public/v2/core/cashu.js): the secp256k1 curve, BIP-340 Schnorr signatures and SHA-256.
# One ES module, minified, licence comments kept. It comes from the copies already installed at the
# repository root (package.json pins @noble/curves 2.4.0 and @noble/hashes 2.4.0, installed by pnpm
# under its release-age rule), bundled with the esbuild that is installed there too, so this script
# fetches nothing.
#   pnpm install --frozen-lockfile && scripts/vendor-noble.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/vendor"
ESB="$(ls -d "$ROOT"/node_modules/.pnpm/esbuild@*/node_modules/esbuild/bin/esbuild | head -n 1)"
CURVES="$(node -p "require('$ROOT/node_modules/@noble/curves/package.json').version")"
HASHES="$(node -p "require('$ROOT/node_modules/@noble/hashes/package.json').version")"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/entry.js" <<'EOF'
export { secp256k1, schnorr } from '@noble/curves/secp256k1.js';
export { sha256 } from '@noble/hashes/sha2.js';
EOF
NODE_PATH="$ROOT/node_modules" "$ESB" "$TMP/entry.js" --bundle --format=esm --platform=browser --target=es2020 --minify \
  --legal-comments=eof --outfile="$TMP/noble.js" --log-level=warning
{ echo "/* @noble/curves $CURVES and @noble/hashes $HASHES (MIT, Paul Miller), secp256k1, schnorr and sha256 only, bundled by scripts/vendor-noble.sh */"; cat "$TMP/noble.js"; } > "$OUT/noble.js"
cp "$ROOT/node_modules/@noble/curves/LICENSE" "$OUT/licenses/noble-curves.txt"
cp "$ROOT/node_modules/@noble/hashes/LICENSE" "$OUT/licenses/noble-hashes.txt"
echo "wrote $OUT/noble.js ($(wc -c < "$OUT/noble.js") bytes)"
