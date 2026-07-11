# PricePulse — canonical developer commands (WP-0.1)

.PHONY: dev dev-down db-up db-console migrate seed build test lint typecheck check hooks

## Enable the repo's pre-commit hook (run once after cloning)
hooks:
	git config core.hooksPath .githooks

## Bring up local dev: Postgres (Docker) + all apps with hot reload
dev: db-up migrate
	pnpm -r --parallel dev

## Stop dev containers (keeps data volume)
dev-down:
	docker compose -f deploy/docker-compose.dev.yml down

## Start only the database container
db-up:
	docker compose -f deploy/docker-compose.dev.yml up -d db
	deploy/scripts/wait-for-db.sh

## psql console into the dev database
db-console:
	docker compose -f deploy/docker-compose.dev.yml exec db psql -U pricepulse pricepulse

## Apply migrations (production-style; see ADR-0002)
migrate:
	pnpm --filter @pricepulse/db migrate

## Seed the single Phase 1 user and default settings
seed:
	pnpm --filter @pricepulse/db seed

build:
	pnpm build

test:
	pnpm test

lint:
	pnpm lint

typecheck:
	pnpm typecheck

## Everything CI runs, locally
check: lint typecheck test build
