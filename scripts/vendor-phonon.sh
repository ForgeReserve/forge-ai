#!/usr/bin/env bash
# Vendors phonon-tts (Gradium's browser build of Phonon text to speech, MIT OR Apache-2.0) into
# public/v2/vendor/phonon-tts as plain files: the app imports nothing from npm at run time.
#
# Fetched with pnpm in a throwaway folder that carries the repo's release-age rule (3 days), with
# install scripts off, and checked against the npm registry's integrity hash before anything is
# copied. 0.7.0 was published 2026-11-09; 0.7.1 (2026-11-13) was too new on 2026-11-14.
#
# The files live under /v2/ and not /vendor/: the v2 service worker (scope /v2/) only controls a
# worker whose script is inside its scope, and the package runs the model in a worker that loads the
# wasm itself. Under /v2/ those loads go through the service worker, so voice works offline after the
# first use. Licences go in public/vendor/licenses with the others.
#   scripts/vendor-phonon.sh
set -euo pipefail
VERSION=0.7.0
INTEGRITY='sha512-k37+AoN2Kirc37zBsmtY9xCXfYpc7foUZ1Q5ahiplv3nTMu81LyYfJLKopJXbqr1ThWjhi1BilhKH/Ip6YEN5g=='
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/v2/vendor/phonon-tts"
LIC="$ROOT/public/vendor/licenses"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
printf '{"name":"phonon-fetch","private":true}\n' > package.json
printf 'minimumReleaseAge: 4320\n' > pnpm-workspace.yaml
pnpm add "phonon-tts@$VERSION" --ignore-scripts --config.confirmModulesPurge=false >/dev/null
PKG="$TMP/node_modules/phonon-tts"
got="$(grep -A3 "phonon-tts@$VERSION" pnpm-lock.yaml | sed -n "s/.*integrity: \([^},]*\).*/\1/p" | head -1)"
if [ "$got" != "$INTEGRITY" ]; then echo "integrity mismatch: $got" >&2; exit 1; fi
test "$(node -p "require('$PKG/package.json').version")" = "$VERSION"

rm -rf "$OUT"; mkdir -p "$OUT/gpu" "$OUT/wasm" "$OUT/wasm-threads" "$LIC"
# The runtime files only: the type declarations and the README stay out.
cp "$PKG"/{index,worker,fetch,hub,wav,threads,device,simd}.js "$OUT/"
cp "$PKG"/gpu/*.js "$OUT/gpu/"
cp "$PKG"/wasm/phonon_tts.js "$PKG"/wasm/*.wasm "$OUT/wasm/"
cp "$PKG"/wasm-threads/phonon_tts.js "$PKG"/wasm-threads/*.wasm "$OUT/wasm-threads/"
# wasm-bindgen-rayon's thread helper, at the path the threaded build imports it from.
(cd "$PKG/wasm-threads" && find snippets -name '*.js' -exec sh -c 'mkdir -p "$0/$(dirname "$1")" && cp "$1" "$0/$1"' "$OUT/wasm-threads" {} \;)
printf '{ "name": "phonon-tts", "version": "%s", "license": "MIT OR Apache-2.0", "integrity": "%s", "source": "https://www.npmjs.com/package/phonon-tts/v/%s" }\n' "$VERSION" "$INTEGRITY" "$VERSION" > "$OUT/VERSION.json"

{ echo "phonon-tts $VERSION (npm), Gradium. Licensed MIT OR Apache-2.0, at your option. Both texts follow."; echo
  echo "==== LICENSE-MIT"; echo; cat "$PKG/LICENSE-MIT"; echo
  echo "==== LICENSE-APACHE"; echo; cat "$PKG/LICENSE-APACHE"; } > "$LIC/phonon-tts.txt"
# The notices of the Rust crates compiled into the package's wasm modules, as the package ships them.
cp "$PKG/THIRD_PARTY_LICENSES.md" "$LIC/phonon-tts-THIRD_PARTY_LICENSES.md"
echo "vendored phonon-tts $VERSION into $OUT"
du -sh "$OUT"
