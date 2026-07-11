# PricePulse

Price tracking and alerting for Amazon India and Flipkart with Telegram notifications and a web dashboard. See [BRD-PricePulse.md](BRD-PricePulse.md) for requirements, [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md) for architecture, and [docs/phases/](docs/phases/) for per-milestone scope.

**Status:** Phase 0 (foundations) — empty application skeleton; feature work begins in Milestone 1.

## Prerequisites

- Node.js ≥ 22, pnpm ≥ 9 (`corepack enable`)
- Docker (for the local PostgreSQL)

## Getting started

```
cp .env.example .env          # dev defaults work as-is
pnpm install                  # installs all workspace packages, generates Prisma client
make dev                      # starts Postgres, applies migrations, runs api+worker+web with hot reload
make seed                     # seeds the single user account and default settings (first run only)
```

- Web app: http://localhost:5173 (proxies `/api` to the API)
- API health: http://localhost:3000/api/health
- `make check` runs everything CI runs: lint, typecheck, tests, build.
- `make db-console` opens psql. `make dev-down` stops containers (data kept).
- `make hooks` enables the pre-commit hook (lint + format on staged files) — run once after cloning.

## Workspace layout

| Path                                    | Package                | Purpose                                                          |
| --------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| [apps/api](apps/api/)                   | `@pricepulse/api`      | NestJS HTTP app: REST API, auth, SSE, serves the SPA             |
| [apps/worker](apps/worker/)             | `@pricepulse/worker`   | NestJS standalone context: scheduler, scraping, alerts, Telegram |
| [apps/web](apps/web/)                   | `@pricepulse/web`      | React SPA (Vite)                                                 |
| [packages/shared](packages/shared/)     | `@pricepulse/shared`   | Enums, DTO types, formatting — the contract all apps share       |
| [packages/adapters](packages/adapters/) | `@pricepulse/adapters` | Marketplace-adapter framework (NFR-8 plugin boundary)            |
| [packages/db](packages/db/)             | `@pricepulse/db`       | Prisma schema, migrations, seed; exports the client              |
| [deploy/](deploy/)                      | —                      | Compose files, Dockerfiles, Caddyfile, deploy scripts            |
| [docs/](docs/)                          | —                      | Phase documents, ADRs, runbooks                                  |

## Conventions that will save you a headache

- **Migrations** are applied with `prisma migrate deploy` only; new migrations are authored with `prisma migrate diff` and hand-edited where Prisma can't express the DDL (partitioning) — see [ADR-0002](docs/adr/0002-prisma-migrations-and-partitioning.md).
- **Constructor injection always uses explicit `@Inject(...)`** — the dev runner (tsx) does not emit decorator metadata, so injection-by-type resolves only in compiled builds. Explicit tokens work in both.
- **Import `@pricepulse/db`, never `@prisma/client`**, outside packages/db.
- **Environment config vs. user settings:** env vars are for infrastructure (DB URL, keys, ports); anything the user can change lives in the database and applies live (FR-6.2).
- Root `.env` is the single env file for local dev; apps load it themselves. Real environments set real environment variables.
