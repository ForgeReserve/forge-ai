#!/usr/bin/env bash
# Runs the UI tests in Linux, as CI does, from a Mac: the pre-push check for any change a phone sees.
#
#   pnpm mint:up                                       # once: the shared local mints on 127.0.0.1:3338-3341
#   pnpm test:ui:linux                                 # the whole UI suite
#   pnpm test:ui:linux test/ui/firstrun.ui.test.ts     # one file (any vitest arguments)
#
# The tests pass on a Mac and fail in CI when they depend on the machine: its fonts, its touch events,
# its speed. This runs them in Playwright's Linux image (Ubuntu 24.04, pinned by digest, the Playwright
# version in pnpm-lock.yaml), with the repository mounted and the mints reached on the host's 127.0.0.1.
# The tests ask for Chrome (channel 'chrome'); Google ships no Linux build for Apple's chip, so the
# image's own Chromium stands in for it at Chrome's path. Linux node_modules live in a Docker volume per
# checkout, so the Mac's are never touched.
#
# Needs Docker Desktop with host networking on (Settings > Resources > Network > Enable host networking).
set -euo pipefail
IMAGE=mcr.microsoft.com/playwright:v1.65.0-noble@sha256:9beb546099e11f52d62e505537914870e01a67e0e6b00ae41da4775324e73dbe
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PW="$(sed -n 's/^  playwright-core@\([0-9.]*\):$/\1/p' pnpm-lock.yaml | head -1)"
case "$IMAGE" in *":v$PW-"*) ;; *) echo "playwright-core is $PW in pnpm-lock.yaml; move IMAGE in $0 to the same version" >&2; exit 1 ;; esac
for port in 3338 3339 3340 3341; do
  curl -sf -m 3 "http://127.0.0.1:$port/v1/info" >/dev/null || { echo "no mint answers on 127.0.0.1:$port: run pnpm mint:up" >&2; exit 1; }
done
PNPM="$(node -p "require('./package.json').packageManager")"
TAG="$(printf '%s' "$ROOT" | shasum | cut -c1-10)"

exec docker run --rm --init --network host --ipc host \
  -v "$ROOT:/work" -v "forge-ai-linux-modules-$TAG:/work/node_modules" -v forge-ai-linux-pnpm-store:/pnpm-store \
  -w /work -e CI=1 -e PNPM="$PNPM" "$IMAGE" bash -euo pipefail -c '
    curl -sf -m 3 http://127.0.0.1:3338/v1/info >/dev/null || { echo "the container cannot reach the mints: turn on host networking in Docker Desktop" >&2; exit 1; }
    # The GitHub runner falls back to DejaVu Sans for any letter Inter lacks; so does this.
    { apt-get update -qq && apt-get install -y -qq --no-install-recommends fonts-dejavu-core; } >/dev/null 2>&1 || echo "could not install DejaVu Sans: the fallback font differs from CI" >&2
    mkdir -p /opt/google/chrome && ln -sf /ms-playwright/chromium-*/chrome-linux*/chrome /opt/google/chrome/chrome
    npm install -g --silent --no-fund --no-audit "$PNPM"
    pnpm config set store-dir /pnpm-store >/dev/null
    pnpm install --frozen-lockfile --reporter=silent
    node scripts/phonon-model.ts
    if [ $# -eq 0 ]; then set -- test/ui; fi
    exec pnpm exec vitest run "$@"
  ' ui-linux "$@"
