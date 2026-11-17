#!/usr/bin/env bash
# CI only: starts the local test mints (docker-compose.test.yml, as `pnpm mint:up` does) in the
# background, so their 40 s or so of pulling and unpacking the image runs while the job sets up Node,
# installs and fetches the voice files, and waits for them only when the tests need them (docs/CI.md).
#
#   scripts/ci-mints.sh start   # returns at once
#   scripts/ci-mints.sh wait    # waits for the start, prints its log with timings, exits with its status
#
# Locally use `pnpm mint:up`: the mints there are shared by every checkout and stay up.
set -euo pipefail
DIR="${RUNNER_TEMP:-/tmp}/forge-ai-mints"
COMPOSE=(docker compose -f docker-compose.test.yml)

case "${1:-}" in
  start)
    mkdir -p "$DIR"
    rm -f "$DIR/status"
    (
      t0=$(date +%s)
      say() { echo "[$(($(date +%s) - t0)) s] $*"; }
      say "image store: $(docker info --format '{{.Driver}} {{json .DriverStatus}}' 2>&1)"
      # Docker Hub now and then answers a pull with a 5xx: try again before calling the run failed.
      for i in 1 2 3; do
        say "pull, try $i"
        if "${COMPOSE[@]}" pull --quiet && say "pulled; starting and waiting for healthy" && "${COMPOSE[@]}" up -d --wait; then
          say "mints healthy"
          echo 0 >"$DIR/status"
          exit 0
        fi
        if [ "$i" -lt 3 ]; then sleep $((i * 15)); fi
      done
      say "the mints did not start"
      echo 1 >"$DIR/status"
    ) >"$DIR/log" 2>&1 &
    echo "local mints starting in the background (log: $DIR/log)"
    ;;
  wait)
    # Three tries of a pull, a start and a health wait fit well inside this.
    for _ in $(seq 1 600); do
      [ -s "$DIR/status" ] && break
      sleep 1
    done
    cat "$DIR/log" 2>/dev/null || true
    if [ ! -s "$DIR/status" ]; then
      echo "the mints were still starting after 10 minutes" >&2
      exit 1
    fi
    exit "$(cat "$DIR/status")"
    ;;
  *)
    echo "usage: $0 start | wait" >&2
    exit 2
    ;;
esac
