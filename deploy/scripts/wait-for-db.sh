#!/usr/bin/env bash
# Block until the dev database container answers (used by `make dev`).
set -euo pipefail

cd "$(dirname "$0")/../.."

for _ in $(seq 1 60); do
  if docker compose -f deploy/docker-compose.dev.yml exec -T db pg_isready -U pricepulse -d pricepulse >/dev/null 2>&1; then
    echo "Database is ready."
    exit 0
  fi
  sleep 1
done

echo "Database did not become ready within 60s." >&2
exit 1
