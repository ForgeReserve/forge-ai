#!/usr/bin/env bash
# Rebuilds the app icons in public/icons from the anvil mark. Needs rsvg-convert (librsvg).
#   scripts/icons.sh
# icon-192/512: public/icon.svg (rounded tile, transparent corners) for "any" purpose.
# maskable-512: full-bleed tile with the mark inside the maskable safe zone (central 80% circle).
# apple-touch-icon (180): full-bleed square; iOS rounds the corners itself and fills transparency black.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/icons"
mkdir -p "$OUT"
rsvg-convert -w 192 -h 192 "$ROOT/public/icon.svg" -o "$OUT/icon-192.png"
rsvg-convert -w 512 -h 512 "$ROOT/public/icon.svg" -o "$OUT/icon-512.png"
rsvg-convert -w 512 -h 512 "$ROOT/scripts/icons/maskable.svg" -o "$OUT/maskable-512.png"
rsvg-convert -w 180 -h 180 "$ROOT/scripts/icons/apple-touch-icon.svg" -o "$OUT/apple-touch-icon.png"
ls -la "$OUT"
