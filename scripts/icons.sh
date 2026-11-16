#!/usr/bin/env bash
# Rebuilds the app icons in public/icons from the anvil mark. Needs rsvg-convert (librsvg).
#   scripts/icons.sh
# icon-192/512: public/icon.svg (rounded tile, transparent corners) for "any" purpose.
# maskable-512: full-bleed tile with the mark inside the maskable safe zone (central 80% circle).
# apple-touch-icon (180): full-bleed square; iOS rounds the corners itself and fills transparency black.
# The iPhone app (ios/, docs/IOS.md): its 1024 icon from the same full-bleed square, with no alpha
# channel (App Store Connect refuses an icon with one), and the launch screen's mark (scripts/icons/
# ios-splash.svg, the anvil alone) at 100x72 points. Needs sips (macOS) for the icon's alpha.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/public/icons"
mkdir -p "$OUT"
rsvg-convert -w 192 -h 192 "$ROOT/public/icon.svg" -o "$OUT/icon-192.png"
rsvg-convert -w 512 -h 512 "$ROOT/public/icon.svg" -o "$OUT/icon-512.png"
rsvg-convert -w 512 -h 512 "$ROOT/scripts/icons/maskable.svg" -o "$OUT/maskable-512.png"
rsvg-convert -w 180 -h 180 "$ROOT/scripts/icons/apple-touch-icon.svg" -o "$OUT/apple-touch-icon.png"
ls -la "$OUT"
IOS="$ROOT/ios/App/App/Assets.xcassets"
if [ -d "$IOS" ]; then
  TMP="$(mktemp -d)"
  rsvg-convert -w 1024 -h 1024 "$ROOT/scripts/icons/apple-touch-icon.svg" -o "$TMP/icon.png"
  # PNG to JPEG and back drops the alpha channel; the square is opaque, so nothing else changes.
  sips -s format jpeg -s formatOptions best "$TMP/icon.png" --out "$TMP/icon.jpg" >/dev/null
  sips -s format png "$TMP/icon.jpg" --out "$IOS/AppIcon.appiconset/AppIcon-1024.png" >/dev/null
  rm -rf "$TMP"
  rsvg-convert -w 100 -h 72 "$ROOT/scripts/icons/ios-splash.svg" -o "$IOS/Splash.imageset/splash.png"
  rsvg-convert -w 200 -h 144 "$ROOT/scripts/icons/ios-splash.svg" -o "$IOS/Splash.imageset/splash@2x.png"
  rsvg-convert -w 300 -h 216 "$ROOT/scripts/icons/ios-splash.svg" -o "$IOS/Splash.imageset/splash@3x.png"
  ls -la "$IOS/AppIcon.appiconset" "$IOS/Splash.imageset"
fi
