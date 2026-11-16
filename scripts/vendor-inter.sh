#!/usr/bin/env bash
# Vendors Inter (rsms/inter, SIL Open Font License 1.1), the app's typeface, into public/v2/vendor/inter:
# the official variable woff2 from the v4.1 release, one file for every weight the app uses (400 to 800).
#
# The app used to ask for Inter by name and fall back to the phone's own font, so the same screen was
# laid out in SF on an iPhone and a Mac without Inter, in Roboto on Android and in DejaVu Sans on a Linux
# test runner: a step that fit 360 by 640 on one could scroll on another. With the font served from our
# origin (and kept offline by the v2 service worker and in the Android bundle), every phone and every
# test browser lays the text out with the same metrics.
#
# The release zip and the woff2 inside it are both checked against the SHA-256 pinned here before
# anything is copied. The licence goes in public/vendor/licenses with the others.
#   scripts/vendor-inter.sh
set -euo pipefail
VERSION=4.1
URL="https://github.com/rsms/inter/releases/download/v$VERSION/Inter-$VERSION.zip"
ZIP_SHA256=9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e
WOFF2_SHA256=693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/v2/vendor/inter"
LIC="$ROOT/public/vendor/licenses"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

curl -sSfL --retry 3 -o "$TMP/inter.zip" "$URL"
if [ "$(sha "$TMP/inter.zip")" != "$ZIP_SHA256" ]; then echo "Inter-$VERSION.zip: sha256 mismatch" >&2; exit 1; fi
unzip -q "$TMP/inter.zip" web/InterVariable.woff2 LICENSE.txt -d "$TMP/x"
if [ "$(sha "$TMP/x/web/InterVariable.woff2")" != "$WOFF2_SHA256" ]; then echo "InterVariable.woff2: sha256 mismatch" >&2; exit 1; fi

rm -rf "$OUT"; mkdir -p "$OUT" "$LIC"
cp "$TMP/x/web/InterVariable.woff2" "$OUT/InterVariable.woff2"
printf '{ "name": "Inter", "version": "%s", "license": "OFL-1.1", "file": "InterVariable.woff2", "sha256": "%s", "source": "%s", "zipSha256": "%s" }\n' \
  "$VERSION" "$WOFF2_SHA256" "$URL" "$ZIP_SHA256" > "$OUT/VERSION.json"
{ echo "Inter $VERSION (InterVariable.woff2), https://github.com/rsms/inter, from $URL"; echo; cat "$TMP/x/LICENSE.txt"; } > "$LIC/inter.txt"
echo "vendored Inter $VERSION into $OUT ($(wc -c < "$OUT/InterVariable.woff2") bytes)"
