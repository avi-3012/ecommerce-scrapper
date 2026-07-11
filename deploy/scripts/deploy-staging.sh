#!/usr/bin/env bash
# Scripted staging deploy (WP-0.3): pull tagged images, run migrations as a
# release step, restart services, smoke-check. Run on the VPS from deploy/.
#   TAG=v0.1.0 ./scripts/deploy-staging.sh
set -euo pipefail

cd "$(dirname "$0")/.."
: "${TAG:?Set TAG to the image tag to deploy}"

ENV_FILE=.env.staging
COMPOSE=(docker compose --env-file "$ENV_FILE" -f docker-compose.staging.yml)

echo "==> Pulling images for $TAG"
TAG="$TAG" "${COMPOSE[@]}" pull api worker

echo "==> Running database migrations (release step, before apps roll)"
TAG="$TAG" "${COMPOSE[@]}" run --rm --no-deps \
  --entrypoint sh api -c "cd packages/db && npx prisma migrate deploy"

echo "==> Rolling services"
TAG="$TAG" "${COMPOSE[@]}" up -d

echo "==> Smoke check"
sleep 5
source "$ENV_FILE"
curl --fail --silent --show-error "https://${SITE_HOSTNAME}/api/health" | tee /dev/stderr | grep -q '"db":"up"'
echo
echo "Deploy of $TAG complete."
