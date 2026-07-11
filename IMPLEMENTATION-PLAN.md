# PricePulse — Phased Implementation Plan

|                      |                                                             |
| -------------------- | ----------------------------------------------------------- |
| **Document Version** | 1.1 (backend stack revised to NestJS per client preference) |
| **Date**             | 10 July 2026                                                |
| **Source Document**  | BRD-PricePulse.md v1.0 (Draft)                              |
| **Prepared By**      | Rishika Jat, Independent Software Consultant                |
| **Status**           | Draft — for review alongside BRD sign-off                   |

This plan translates every requirement in the BRD into concrete engineering work packages, organised into the BRD's delivery milestones (Section 13), with a technical architecture, full data model, testing strategy, deployment plan, effort estimates, and a requirements-traceability matrix proving every FR/NFR is covered.

---

## Table of Contents

1. [Guiding Technical Decisions](#1-guiding-technical-decisions)
2. [System Architecture](#2-system-architecture)
3. [Data Model](#3-data-model)
4. [Phase 0 — Project Foundations](#4-phase-0--project-foundations)
5. [Milestone 1 — Core Tracking Engine](#5-milestone-1--core-tracking-engine)
6. [Milestone 2 — Dashboard & Administration](#6-milestone-2--dashboard--administration)
7. [Milestone 3 — Experience Enhancements](#7-milestone-3--experience-enhancements)
8. [Cross-Cutting Workstreams](#8-cross-cutting-workstreams)
9. [Deployment & Operations](#9-deployment--operations)
10. [Timeline, Effort & Dependencies](#10-timeline-effort--dependencies)
11. [Requirements Traceability Matrix](#11-requirements-traceability-matrix)
12. [Engineering Risk Register](#12-engineering-risk-register)
13. [Definition of Done per Milestone](#13-definition-of-done-per-milestone)
14. [Phase 2 Preparedness (Design-Ahead Items)](#14-phase-2-preparedness-design-ahead-items)

---

## 1. Guiding Technical Decisions

These decisions are stated up front because every work package depends on them. Each is a recommendation; swapping any of them changes estimates but not the plan's structure.

### 1.1 Technology Stack

| Layer                              | Choice                                                                                                                              | Rationale                                                                                                                                                                                                                                                       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Backend language                   | **Node.js 22 LTS + TypeScript**                                                                                                     | One language across backend and frontend; API DTOs and validation schemas shared with the React app as a common package — eliminates a whole class of contract bugs                                                                                             |
| Web framework / API                | **NestJS 11**                                                                                                                       | Modular DI architecture maps cleanly onto the adapter/channel plugin principles (§1.2); first-class OpenAPI (`@nestjs/swagger`), guards/interceptors for auth, built-in `@Sse` support for live dashboard updates                                               |
| Database                           | **PostgreSQL 16**                                                                                                                   | Indefinite price history (NFR-4) at 500 products × 48 checks/day ≈ 8.8M rows/year — needs a real database with partitioning/indexing, not SQLite; JSONB for offer lists; trivially supports multi-user later (FR-6.4)                                           |
| ORM / migrations                   | **Prisma** (raw-SQL migration steps for the `price_history` partitioning DDL)                                                       | Versioned schema migrations are mandatory for a long-lived data store; generated types flow through the shared-types package                                                                                                                                    |
| Scheduler / worker                 | **Dedicated NestJS worker app** (standalone application context) using `@nestjs/schedule` + **pg-boss** (Postgres-backed job queue) | 500 products / 30 min ≈ 17 checks/min — one Node worker handles this comfortably (NFR-5); pg-boss gives retries/priorities/cron on top of Postgres, avoiding Redis/BullMQ infrastructure for Phase 1 while keeping the worker isolated from the web app (NFR-1) |
| HTTP scraping (tier 1)             | **got-scraping / impit** (browser-impersonating TLS + header generation) + **cheerio** parsing                                      | Fast, cheap per-check; TLS/header fingerprint impersonation materially reduces bot detection on Amazon/Flipkart                                                                                                                                                 |
| Browser scraping (tier 2 fallback) | **Playwright** (headless Chromium, Node API)                                                                                        | Automatic fallback when HTTP-tier extraction fails (R-1 mitigation "multi-layer extraction")                                                                                                                                                                    |
| Telegram                           | **grammY**                                                                                                                          | Modern TypeScript bot framework; supports outbound notifications (M1) and two-way commands with inline keyboards (M3); clean NestJS integration                                                                                                                 |
| Frontend                           | **React 18 + TypeScript + Vite + Tailwind CSS**                                                                                     | Fast to build, mobile-responsive by construction (FR-5.9)                                                                                                                                                                                                       |
| Charts                             | **Recharts**                                                                                                                        | Time-series price charts, multi-series comparison chart (FR-5.4, FR-5.6)                                                                                                                                                                                        |
| Data fetching / live updates       | **TanStack Query + Server-Sent Events**                                                                                             | SSE gives refresh-free dashboard (FR-5.8) with far less machinery than WebSockets                                                                                                                                                                               |
| Auth                               | Single account, **argon2** password hash, **HTTP-only session cookie (JWT)** via `@nestjs/passport` guards                          | Meets FR-6.4/NFR-7 now; `user_id` foreign keys everywhere make multi-user a data-fill, not a restructure                                                                                                                                                        |
| Spreadsheet I/O                    | **exceljs** (xlsx) + **csv-parse/csv-stringify**                                                                                    | FR-1.7 import, FR-6.3 export                                                                                                                                                                                                                                    |
| Deployment                         | **Docker Compose** (web, worker, db, caddy) on client-provided VPS                                                                  | Single-box, reproducible, restart-on-failure (R-6); Caddy provides automatic HTTPS                                                                                                                                                                              |
| Backups                            | Nightly `pg_dump` → compressed archive → offsite copy (object storage or client-approved location)                                  | NFR-9                                                                                                                                                                                                                                                           |

### 1.2 Key Architectural Principles

1. **Marketplace adapters are plugins (NFR-8).** All Amazon/Flipkart-specific code lives behind a single `MarketplaceAdapter` interface (`matches_url`, `canonicalize_url`, `fetch`, `parse`). Registration, monitoring, alerting, history, and the dashboard only ever see the adapter interface and its normalized `ProductSnapshot` output. Adding a marketplace in Phase 2 = adding one adapter package + one enum value.
2. **Every check writes history, success or failure (FR-2.3, NFR-2).** The scrape pipeline cannot exit without producing either a snapshot row or a failure row with a categorised reason. "Silent failure" is made structurally impossible, not procedurally discouraged.
3. **Alert evaluation is a pure function.** `evaluate(previous_state, new_snapshot, rules, settings) -> [AlertEvent]` — deterministic and unit-testable, which is how crossing semantics (FR-3.1), threshold logic (FR-3.2) and offer-diffing (FR-3.4) get exhaustively tested without live marketplaces.
4. **Notification delivery is a channel abstraction (FR-4.6).** `NotificationChannel.send(alert) -> DeliveryResult`. Telegram is the sole Phase 1 implementation; email/WhatsApp become new implementations, not redesigns.
5. **Single-user now, multi-user-shaped data (FR-6.4, Section 9.5 of BRD).** Every user-owned table carries `user_id` from day one; Phase 1 seeds exactly one user row.
6. **The scraper assumes it will break (R-1).** Extraction uses ordered strategies per field (structured data → known selectors → fallback selectors), reports _which_ strategy succeeded, and treats parse-confidence degradation as an observable signal — so breakage is detected by the system before the user notices missing data.

### 1.3 Assumptions Carried from the BRD

- Client provides VPS hosting (≥ 2 vCPU / 4 GB RAM recommended for Playwright headroom), Telegram bot token, and destination chat ID (BRD Assumptions 2, 4).
- Public-page observation approach and its ToS posture are accepted at sign-off (BRD Assumption 1, R-3).
- No proxy/rotation service is included in Phase 1; if the marketplaces block the host IP, engaging a proxy or commercial data provider is a chargeable change (R-2).

---

## 2. System Architecture

```
                                    ┌──────────────────────────────────────────┐
                                    │              VPS (Docker Compose)         │
                                    │                                          │
  ┌──────────┐   HTTPS (Caddy)     │  ┌────────────┐        ┌──────────────┐  │
  │ Browser   │ ─────────────────▶ │  │  Web app    │        │  Worker       │  │
  │ (mobile/  │   REST + SSE       │  │  NestJS     │        │  - Scheduler  │  │
  │  desktop) │                    │  │  + static   │        │  - Scrape     │  │
  └──────────┘                     │  │    React SPA│        │    pipeline   │  │
                                   │  └─────┬──────┘        │  - Alert      │  │
  ┌──────────┐                     │        │               │    engine     │  │
  │ Telegram  │ ◀───────────────── │        │               │  - Notifier   │  │
  │ (user)    │   bot API          │        ▼               └──────┬───────┘  │
  └──────────┘   (send + webhook/  │  ┌─────────────────────────────▼───────┐ │
                  long-poll)       │  │            PostgreSQL 16             │ │
                                   │  │  products / price_history / alerts  │ │
                                   │  │  settings / users / system_status   │ │
                                   │  └─────────────────────────────────────┘ │
                                   │        │  nightly pg_dump → offsite      │
                                   └──────────────────────────────────────────┘
                                             │ outbound scraping
                                             ▼
                                   amazon.in        flipkart.com
```

**Processes**

| Process  | Responsibilities                                                                                                                                                                                                                                                                                                                      |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `web`    | NestJS HTTP app: REST API, auth, serves the built SPA, SSE event stream, on-demand check _requests_ (enqueued for the worker), bulk import/export, settings                                                                                                                                                                           |
| `worker` | NestJS standalone application context (no HTTP listener), sharing domain modules with `web`: recurring schedule, politeness pacing, scrape pipeline (tier-1 HTTP → tier-2 Playwright), history writes, alert evaluation, Telegram delivery, Telegram bot command handling, auto-pause logic, digest/quiet-hour queues (M3), heartbeat |
| `db`     | PostgreSQL                                                                                                                                                                                                                                                                                                                            |
| `caddy`  | TLS termination, reverse proxy                                                                                                                                                                                                                                                                                                        |

**Web ↔ worker contract:** communication is through the database only (pg-boss job queue for on-demand checks and a `LISTEN/NOTIFY` channel for wake-ups + SSE fan-out). No message broker in Phase 1. Failure of either process never takes down the other; both restart automatically (`restart: unless-stopped`).

**Monitoring cycle (worker main loop)**

1. Read due products (active, not paused, `next_check_at <= now`).
2. Shuffle and space them across the interval with per-request jitter and a global per-marketplace concurrency cap + minimum gap (FR-2.5).
3. For each product: adapter fetch (tier 1; escalate to tier 2 on extraction failure) → parse to `ProductSnapshot` → write `price_history` row → run alert engine against previous state → enqueue any alerts → update product's current-state snapshot and `next_check_at`.
4. Per-product exceptions are caught, categorised, recorded as failed checks; consecutive-failure counter drives auto-pause (FR-2.6). The loop itself is never interrupted (NFR-1).
5. On cycle completion: update `system_status` (last run, success rate) and emit SSE event.

---

## 3. Data Model

Full schema, designed once so that no milestone requires destructive migration. Types are PostgreSQL.

### 3.1 `users`

| Column                  | Type          | Notes                                             |
| ----------------------- | ------------- | ------------------------------------------------- |
| id                      | uuid PK       |                                                   |
| email                   | text unique   | login identity                                    |
| password_hash           | text          | argon2id                                          |
| telegram_chat_id        | text nullable | destination chat (per-user, ready for multi-user) |
| created_at / updated_at | timestamptz   |                                                   |

### 3.2 `products`

| Column                                              | Type                                           | Notes                                                      |
| --------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------- |
| id                                                  | uuid PK                                        |                                                            |
| user_id                                             | uuid FK → users                                | multi-user-ready                                           |
| marketplace                                         | text enum (`amazon_in`, `flipkart`)            | extensible                                                 |
| url                                                 | text                                           | as supplied                                                |
| canonical_url                                       | text, **unique (user_id, canonical_url)**      | duplicate prevention (FR-1.5) survives URL-parameter noise |
| marketplace_product_id                              | text                                           | ASIN / Flipkart itemId, extracted at registration          |
| display_name                                        | text                                           | scraped, user-editable                                     |
| image_url                                           | text nullable                                  | for cards/preview                                          |
| tags                                                | text[]                                         | category tags (FR-1.4)                                     |
| notes                                               | text                                           | free text (FR-1.4)                                         |
| target_price                                        | numeric(12,2) nullable                         | FR-1.4                                                     |
| drop_threshold_pct                                  | numeric(5,2) nullable                          | per-product override (FR-1.4)                              |
| status                                              | enum: `active` / `paused_user` / `paused_auto` | distinguishes FR-1.6 pause from FR-2.6 auto-pause          |
| consecutive_failures                                | int default 0                                  | drives auto-pause                                          |
| linked_product_id                                   | uuid FK → products, nullable                   | cross-platform link (FR-1.8)                               |
| — current-state snapshot:                           |                                                | denormalised for fast catalogue view (FR-5.2)              |
| current_price / current_mrp                         | numeric(12,2)                                  |                                                            |
| current_discount_pct                                | numeric(5,2)                                   |                                                            |
| current_offers                                      | jsonb                                          | normalized offer list                                      |
| current_stock_status                                | enum: `in_stock` / `out_of_stock` / `unknown`  |                                                            |
| target_crossed                                      | boolean default false                          | crossing-state latch for FR-3.1                            |
| last_checked_at / last_success_at / last_changed_at | timestamptz                                    | NFR-2 visibility                                           |
| next_check_at                                       | timestamptz indexed                            | scheduler queue                                            |
| priority_tier                                       | enum: `normal` / `high` default `normal`       | schema-ready for FR-2.8 (Phase 2 behaviour)                |
| created_at / updated_at / deleted_at                | timestamptz                                    | soft-delete window before hard purge                       |

### 3.3 `price_history` — one row per check (FR-2.3), **partitioned by month** (NFR-4/NFR-5 scale)

| Column          | Type                                                                                                                      | Notes                                         |
| --------------- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| id              | bigserial PK                                                                                                              |                                               |
| product_id      | uuid FK indexed                                                                                                           |                                               |
| checked_at      | timestamptz indexed                                                                                                       | partition key                                 |
| success         | boolean                                                                                                                   |                                               |
| price / mrp     | numeric(12,2) nullable                                                                                                    | null on failure                               |
| discount_pct    | numeric(5,2) nullable                                                                                                     |                                               |
| offers          | jsonb                                                                                                                     | list of `{type, description, hash}`           |
| offers_hash     | text                                                                                                                      | cheap change detection for FR-3.4             |
| stock_status    | enum                                                                                                                      | out-of-stock is a _successful_ check (FR-2.7) |
| failure_reason  | enum: `fetch_blocked`, `fetch_timeout`, `http_error`, `parse_failed`, `listing_removed`, `captcha`, `other` + detail text | categorised for diagnostics & user messaging  |
| extraction_tier | enum: `http` / `browser`                                                                                                  | R-1 observability                             |
| duration_ms     | int                                                                                                                       | performance monitoring                        |

### 3.4 `alerts`

| Column                | Type                                                                                                                    | Notes                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| id                    | uuid PK                                                                                                                 |                                             |
| product_id            | uuid FK                                                                                                                 |                                             |
| user_id               | uuid FK                                                                                                                 |                                             |
| type                  | enum: `target_price`, `threshold_drop`, `price_change`, `offer_change`, `back_in_stock`, `auto_paused`, `system_health` | FR-3.1–3.6                                  |
| old_value / new_value | jsonb                                                                                                                   | price or offers or stock, per type (FR-3.7) |
| change_pct            | numeric nullable                                                                                                        |                                             |
| fired_at              | timestamptz                                                                                                             |                                             |
| channel               | text (`telegram`)                                                                                                       | FR-4.6-ready                                |
| delivery_status       | enum: `pending`, `delivered`, `failed`, `held_quiet_hours`                                                              | FR-4.2, FR-3.9                              |
| delivery_error        | text nullable                                                                                                           |                                             |
| delivered_at          | timestamptz nullable                                                                                                    |                                             |

### 3.5 `settings` — single row per user (key/value with typed accessors)

Monitoring interval (default 30 min), global drop threshold %, per-alert-type toggles (any-change, offer-change, etc.), consecutive-failure limit (default 5), cooldown window (M3), quiet hours start/end (M3), digest frequency (M3), Telegram bot token + chat id (encrypted at rest — see §8.4).

### 3.6 On-demand job queue (web → worker) — **pg-boss**

Postgres-backed queue managed by pg-boss (its schema lives in a dedicated `pgboss` schema); job types: `check_product`, `check_all`, `test_notification`, `import_batch` — with retry, priority, and completion tracking out of the box. (FR-2.4, FR-4.3, FR-1.7.)

### 3.7 `system_status` — single-row health snapshot (NFR-2, FR-5.1, UC-9)

Last cycle started/completed, products due/checked/succeeded/failed in last cycle, rolling 7-day success rate (Success Criterion 1), worker heartbeat timestamp, scraper-health flags per marketplace (e.g. "Flipkart parse-confidence degraded").

### 3.8 `import_batches` (M2)

`id, user_id, filename, total_rows, imported, duplicates, invalid, row_errors jsonb, created_at` — the FR-1.7 import report, persisted.

---

## 4. Phase 0 — Project Foundations

Everything needed before feature work starts. **Duration: ~1 week.**

### WP-0.1 Repository, Tooling & Skeleton

- **pnpm workspace monorepo:** `apps/api` (NestJS web app), `apps/worker` (NestJS standalone worker), `apps/web` (Vite React SPA), `packages/shared` (DTOs, validation schemas, enums — consumed by all three), `packages/adapters` (marketplace adapters, per NFR-8), `deploy/` (compose files, Caddyfile, backup scripts), `docs/`.
- TypeScript strict mode everywhere; tooling: `eslint` + `prettier` across all packages, `vitest` (unit) and NestJS testing utilities; single lockfile.
- Pre-commit hooks; `README` with one-command local bring-up.

### WP-0.2 CI Pipeline

- GitHub Actions (or client's forge): lint → typecheck → unit tests → build images on every push; fixture-based scraper regression suite runs in CI (no live marketplace calls in CI).

### WP-0.3 Local & Staging Environments

- `docker-compose.dev.yml` with hot-reload web + worker + Postgres.
- Staging = production compose on the VPS under a separate hostname/DB, used for milestone acceptance demos (BRD §14 "joint review session").

### WP-0.4 Database Foundation

- PostgreSQL provisioning, Prisma wiring, initial migration for the **entire §3 schema** (all milestones' tables created up front; features fill them in) — the `price_history` monthly-partitioning DDL as a hand-written SQL migration step alongside the Prisma schema.
- Seed script: single user account, default settings row.

### WP-0.5 Configuration & Secrets

- 12-factor config via environment; `.env` templates; secrets (DB password, JWT signing key, settings-encryption key) never in the repo.

**Exit criteria:** clean clone → `make dev` → empty app boots (web healthcheck + worker heartbeat + migrated DB); CI green.

---

## 5. Milestone 1 — Core Tracking Engine

BRD Milestone 1: "Working tracker demonstrable end-to-end via Telegram." All Must-have items except the dashboard. **Duration: ~5–6 weeks.** During M1 the operator interface is the Telegram bot plus a minimal authenticated JSON API (which M2's dashboard will consume unchanged).

### WP-1.1 Marketplace Adapter Framework — _the NFR-8 backbone_

**Scope:** the plugin interface every other component builds on.

- `MarketplaceAdapter` TypeScript interface (implementations registered via Nest DI): `matchesUrl(url)`, `canonicalizeUrl(url)` (strip tracking params, resolve short links like `amzn.in`/`dl.flipkart.com`, extract ASIN/itemId), `fetch(url): RawPage`, `parse(RawPage): ProductSnapshot`.
- `ProductSnapshot` normalized type in `packages/shared`: name, price, MRP, computed discount %, offers `[{type, description}]`, stock status, image URL, per-field extraction-strategy provenance — the same type the frontend preview card renders (FR-1.3).
- Adapter registry keyed by domain; unsupported-domain detection with the FR-1.2 rejection message.
- Offer normalization rules: classify into bank-offer / coupon / exchange / other; stable `offers_hash` (sorted, whitespace-normalized) so FR-3.4 diffing is deterministic.

**Deliverables:** interface + registry + snapshot model + 100% unit-tested URL canonicalization for both marketplaces (≥ 20 real-world URL variants each: mobile URLs, share links, ref-tag-laden links).

### WP-1.2 Amazon India Adapter

- Tier-1 fetch via got-scraping/impit with browser-impersonated TLS/headers; hardened parsing: JSON/structured data first, then primary price-block selectors, then fallback selectors; explicit CAPTCHA/robot-page detection → categorised `fetch_blocked`.
- Extracts: title, selling price (buy-box), MRP/list price, offers ("Bank Offer", coupon badges, cashback), availability (in stock / currently unavailable / temporarily out of stock), main image.
- Variant discipline (R-5): parse only the buy-box/default-selected variant; record the ASIN parsed so a mismatch with the registered ASIN flags `parse_failed` rather than silently tracking the wrong variant.
- Tier-2 Playwright fallback with same parse layer against rendered DOM.
- **Fixture suite:** ≥ 15 saved real HTML pages (in-stock, out-of-stock, deal-price, coupon, bank-offer, unavailable, CAPTCHA page, removed listing…) — the regression harness that makes R-1 repairs fast and safe.

### WP-1.3 Flipkart Adapter

- Same structure as WP-1.2. Flipkart specifics: price/offers frequently delivered via embedded JSON state — prefer that over DOM selectors; "Coming Soon"/"Notify Me" states map to out-of-stock (FR-2.7); supersaver/bank-offer strips parsed into normalized offers; ≥ 15-page fixture suite.

### WP-1.4 Scrape Pipeline & Politeness Layer (FR-2.2, FR-2.3, FR-2.5)

- Orchestration around adapters: timeout budget per tier, tier-1→tier-2 escalation rules, retry-once-with-backoff on transient network errors.
- Politeness: per-marketplace semaphore (concurrency 2–3), minimum randomized gap between requests to the same marketplace, per-request jitter, realistic rotating user-agent/header profiles, spread of due checks across the whole interval window (never a thundering herd at cycle start).
- Guaranteed history write on every outcome (principle §1.2-2); categorised failure taxonomy (§3.3).

### WP-1.5 Scheduler & Monitoring Loop (FR-2.1, FR-2.4, FR-2.6, FR-2.7, NFR-1)

- Worker main loop per §2; per-product `next_check_at` scheduling (interval change → recompute all `next_check_at` live, **no restart**, FR-2.1).
- On-demand checks: pg-boss consumer with priority over scheduled work (FR-2.4).
- Consecutive-failure counter; at configured limit (default 5) → `paused_auto` + `auto_paused` alert with product + categorised reason (FR-2.6/FR-3.6); out-of-stock never increments the counter (FR-2.7).
- Missed-cycle recovery: on worker start, everything overdue is simply due now — no backlog explosion, no double-alerting (R-6).
- Worker heartbeat → `system_status`; web layer surfaces "monitoring stalled" if heartbeat is stale (NFR-2).

### WP-1.6 Product Registration Service (FR-1.1, FR-1.2, FR-1.3, FR-1.5, FR-1.6, FR-1.4)

- `POST /products/preview` — URL in → adapter detection (reject unsupported, FR-1.2) → canonicalize → duplicate check (FR-1.5) → **live fetch** → full preview snapshot returned (FR-1.3). Target: preview p95 < 15 s (supports Success Criterion 3, "registered + confirmed price in under a minute").
- `POST /products` — persist with optional target price, threshold override, notes, tags (FR-1.4); first history row written from the preview snapshot; scheduled immediately.
- Edit / pause / resume / delete endpoints; delete requires explicit confirmation token and removes history + alerts (FR-1.6) via short soft-delete window then hard purge.

### WP-1.7 Alert Engine (FR-3.1–3.7)

Pure-function evaluator (principle §1.2-3) run after every successful check:

- **Target price (FR-3.1):** fires only on crossing — `target_crossed` latch on the product resets when price rises back above target. Explicit unit tests: drop-to-target fires once; repeated checks at/below target are silent; rise-above then re-drop fires again.
- **Threshold drop (FR-3.2):** per-product override else global default; computed against previous successful check's price.
- **Any-change (FR-3.3):** rise or drop, global toggle.
- **Offer change (FR-3.4):** `offers_hash` diff; message lists added/removed offers; global toggle.
- **Back-in-stock (FR-3.5):** `out_of_stock → in_stock` transition only.
- **Auto-pause (FR-3.6):** emitted by WP-1.5.
- Every event carries old/new values and % change → persisted to `alerts` (FR-3.7 data).
- Edge-case rules documented and tested: first-ever check (no previous → no change alerts), previous check failed (compare against last _successful_), price unchanged but MRP changed, simultaneous conditions (target + threshold both true → both alerts, distinct types).

### WP-1.8 Telegram Delivery (FR-4.1, FR-4.2, FR-4.3, FR-3.7)

- `NotificationChannel` abstraction (principle §1.2-4) + Telegram implementation.
- Message templates per alert type: product name, marketplace, old → new values, % change, direct listing link, timestamp — HTML-formatted, mobile-glanceable (FR-3.7).
- Delivery pipeline: queue from `alerts` where `pending`; send with retry/backoff honouring Telegram rate limits; record `delivered`/`failed` + reason (FR-4.2).
- Test-notification job type (FR-4.3) — exposed via bot command and API now, settings-screen button in M2.

### WP-1.9 Telegram Bot — M1 Operator Interface (foundation of FR-4.4/4.5)

Minimum command set so M1 is genuinely "demonstrable end-to-end via Telegram":

- `/start` (bind chat id), `/add <url>` → preview message with ✅ Confirm / ❌ Cancel inline buttons (FR-4.4 semantics), `/list` (paginated: name, price, status, last-checked), `/check <n>` (on-demand check), `/status` (system health snapshot), `/test` (test notification).
- Chat-id allowlist: the bot ignores anyone but the configured user (NFR-7).
- _(Full management command set — pause/resume/target — lands in M3 / WP-3.1.)_

### WP-1.10 Minimal Authenticated API

- Login endpoint + session issuance (full auth hardening in WP-2.1); CRUD + preview + settings + health endpoints as needed by WP-1.6–1.9 — this is the exact API surface M2's dashboard consumes, so M2 is frontend work, not backend rework.

### WP-1.11 Milestone 1 Hardening & Acceptance

- 72-hour continuous soak on staging with 100+ real products across both marketplaces; measure check success rate against the ≥ 95% criterion; verify alert-within-one-cycle timing (NFR-3); tune pacing.
- Dry run of BRD acceptance items 1–5, 8 via Telegram + API.

**M1 exit:** a real catalogue is being tracked around the clock; every alert type fires correctly to Telegram; failures auto-pause with notification; all observable via bot commands.

---

## 6. Milestone 2 — Dashboard & Administration

BRD Milestone 2: "Complete Phase 1 application, ready for daily use." **Duration: ~4–5 weeks.**

### WP-2.1 Authentication & Session Hardening (FR-6.4, NFR-7)

- Login page; argon2id hashing; rate-limited login attempts; HTTP-only, secure, SameSite cookies; CSRF protection on mutating routes; every API route behind auth; logout; password change.

### WP-2.2 Frontend Application Shell

- Vite + React + TS + Tailwind scaffold; responsive layout (sidebar → bottom nav on mobile, FR-5.9); routing (Dashboard / Products / Product detail / Alerts / Settings); TanStack Query wiring with auth handling; loading/error/empty states as first-class components; toast system.

### WP-2.3 Dashboard Home (FR-5.1, UC-9, NFR-2)

- Stat cards: products tracked, alerts last 24 h, price drops last 24 h, last completed run.
- **Health banner** — the UC-9 "glance test": green (all normal) / amber (some products failing, N auto-paused) / red (monitoring stalled — stale heartbeat), with plain-language explanation and affected products. A non-technical user must never need logs (NFR-6).
- Recent-activity feed (latest drops and alerts).

### WP-2.4 Catalogue View (FR-5.2, FR-5.3)

- Product cards/rows: image, name, marketplace badge, current price, MRP + discount %, change-since-previous-check arrow, stock badge, offers summary, last-checked relative time, status (active/paused/auto-paused).
- Search by name/URL; filters: marketplace, tags, price-drop-today, stock status, health status (failing/auto-paused); sorting (biggest drop, recently changed, name, price).
- Row actions: check now, pause/resume, edit, delete (with FR-1.6 confirmation modal spelling out history loss). Pagination/virtualisation for 500+ products (NFR-5).

### WP-2.5 Product Registration UI (FR-1.1–1.5)

- Paste-URL flow with live preview card (name, price, MRP, offers, stock, image) and confirm/cancel (FR-1.3); inline duplicate ("already tracked — view product") and unsupported-site messages; target price / threshold / tags / notes on the save form.

### WP-2.6 Product Detail & Price History Chart (FR-5.4, FR-2.3, UC-3)

- **Price chart:** selling price over time; window selector 7/30/90 days/all; MRP reference line; target-price line; out-of-stock periods shaded; failed checks marked distinctly (Success Criterion 4: gaps only where checks failed). Server-side downsampling for long ranges.
- Check-history table (paginated): every check with outcome, values, failure reason.
- Alert history for the product; full edit panel; offers timeline.

### WP-2.7 Alert Log Screen (FR-5.7, FR-4.2)

- All fired alerts, filterable by product/type/date; each row: type, product, old → new, % change, fired-at, **Telegram delivery status** with failure reason; retry-delivery action for failed sends.

### WP-2.8 Settings Screens (FR-6.1, FR-6.2, FR-4.3)

- Telegram credentials (token/chat id) with **Send test notification** button (FR-4.3); monitoring interval (takes effect live — next-check times visibly recompute, FR-2.1/6.2); global drop threshold; per-alert-type toggles; consecutive-failure limit; password change.
- All settings apply immediately via DB-backed config read by the worker each cycle (FR-6.2) — no restart, no technical intervention.

### WP-2.9 Bulk Import (FR-1.7, UC-7)

- Upload xlsx/csv; column mapping (URL required; optional name, target price, threshold, notes, tags); validation pass (URL format, supported marketplace, duplicates within file and against DB, numeric fields) → **preview screen** with per-row disposition → confirm → background import job with progress (SSE).
- Imported products enter a registration queue processed at polite pace (200 rows ≠ 200 instant scrapes; FR-2.5); result report: imported / duplicates / invalid with per-row reasons (persisted, §3.8); downloadable error report. Template file provided. Tested with the BRD's 20-mixed-row acceptance case and with 500-row files (NFR-5).

### WP-2.10 Milestone 2 Hardening & Acceptance

- Mobile-browser pass on real devices (FR-5.9); non-technical-user walkthrough of BRD acceptance items 1–9 end-to-end through the dashboard alone (NFR-6); accessibility/basic-UX pass; load test of catalogue + chart endpoints at 500 products.

**M2 exit:** BRD Phase 1 acceptance criteria (all 9) demonstrable in a joint review session.

---

## 7. Milestone 3 — Experience Enhancements

BRD Milestone 3: Should-have items. **Duration: ~3–4 weeks.** Each package here is independently deliverable and can be re-scoped by budget (BRD marks these S).

### WP-3.1 Full Two-Way Telegram Bot (FR-4.4, FR-4.5)

- Complete management set: `/pause <n>`, `/resume <n>`, `/target <n> <price>`, `/remove` (with confirm), `/search <text>`, richer `/list` with inline per-product action buttons; inline preview-confirm registration polished from WP-1.9; help text; graceful unknown-command handling.

### WP-3.2 Alert Hygiene: Cooldown, Quiet Hours, Digest (FR-3.8, FR-3.9, FR-3.10, R-4)

- **Cooldown (FR-3.8):** suppress duplicate (product, alert-type) alerts within the configured window; suppressed alerts still recorded, marked suppressed.
- **Quiet hours (FR-3.9):** daily window (user timezone, IST default); alerts held (`held_quiet_hours`) and flushed as one consolidated summary at window end.
- **Digest (FR-3.10):** daily/weekly scheduled summary — drops, rises, offer changes, stock transitions, best deals vs recorded lows; delivered via the same channel abstraction.
- Settings UI for all three; alert-engine tests extended for interaction cases (quiet hours + cooldown + crossing).

### WP-3.3 Deal-Quality Context (FR-5.5, UC-3, UC-8)

- Per-product all-time low / average / high (maintained incrementally, not scanned); "**at/near all-time low**" badge (within configurable % of low) on cards and detail; low/avg/high reference bands on the chart; alert messages enriched with "lowest price ever recorded" context where applicable.

### WP-3.4 Cross-Platform Linking & Comparison (FR-1.8, FR-5.6, UC-4)

- Link/unlink two products (one per marketplace) as "same product"; comparison view: side-by-side current price/offers/stock, both histories on one dual-series chart, "cheaper now" and "cheaper historically" indicators; linked-pair badge in catalogue.

### WP-3.5 Data Export (FR-6.3)

- Export tracked-product list (xlsx/csv) and full price history (per product or entire catalogue); streamed generation for multi-million-row history (NFR-4/5); export includes alert log. Round-trip compatible with the WP-2.9 import template.

### WP-3.6 Live Dashboard Updates (FR-5.8)

- SSE channel (worker → `NOTIFY` → web → browser): new check results, alert firings, health changes patch TanStack Query caches live — no manual refresh; graceful reconnect/refetch on connection loss; live "checking now…" indicator on product cards.

### WP-3.7 Milestone 3 Hardening & Acceptance

- Regression pass over M1/M2 acceptance items; alert-fatigue scenario test (R-4): high-churn product with cooldown+quiet-hours+digest configured behaves as specified; joint review of Should-have items.

**M3 exit:** full Phase 1 BRD scope (M + S) delivered; product in daily unattended use.

---

## 8. Cross-Cutting Workstreams

These run across all milestones rather than inside one.

### 8.1 Testing Strategy

| Layer              | Approach                                                                                                                                                                                                                                       |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit               | Alert engine (exhaustive: crossing, thresholds, offer diffs, stock transitions, first-check, failed-previous-check); URL canonicalization; offer normalization; import validation. Target ≥ 90% on alert engine and adapters' parse functions. |
| Scraper regression | Fixture HTML suites per adapter (WP-1.2/1.3), run in CI on every change — **this is the R-1 safety net**: a marketplace repair is done when fixtures (old + newly captured) pass.                                                              |
| Integration        | API tests against real Postgres (testcontainers); scheduler tests with fake clock (interval change, auto-pause, missed-cycle recovery); Telegram delivery against a mock Bot API server.                                                       |
| E2E                | Playwright browser tests for the BRD §14 acceptance flows (register-with-preview, bulk import report, settings live-effect, alert log).                                                                                                        |
| Soak               | 72-h staging runs at each milestone (WP-1.11, 2.10, 3.7) measuring the ≥ 95% success criterion.                                                                                                                                                |
| Simulation harness | A `mock` marketplace adapter with scriptable price/offer/stock sequences — powers the BRD's "controlled simulation" acceptance path (§14 item 4) and lets alerts be demonstrated on demand without waiting for real price moves.               |

### 8.2 Observability & Self-Monitoring (NFR-2, Success Criterion 5)

- Structured JSON logs (per-check records with product, tier, duration, outcome); `system_status` heartbeat + rolling success metrics surfaced in dashboard health banner and `/status` bot command.
- **Escalation ladder:** product-level failure → history row; repeated → auto-pause alert (FR-2.6); marketplace-wide parse-success collapse (e.g. < 50% over an hour — the "site changed" signature) → distinct `system_health` Telegram alert naming the marketplace; worker heartbeat stale → red dashboard banner, and a `cron`-driven external liveness check on the VPS that alerts via Telegram even if the app itself is down.
- Error aggregation (Sentry or self-hosted GlitchTip) for the maintainer — supports the BRD §16 maintenance agreement.

### 8.3 Performance & Capacity (NFR-5)

- Budget: 500 products / 30 min ⇒ ~17 checks/min ⇒ concurrency 3, ~2–4 s/check — comfortable with 3–4× headroom before pacing floors are hit.
- `price_history` monthly partitions + `(product_id, checked_at)` index; chart queries downsampled server-side; catalogue paginated; import queue paced.
- Milestone gates include load checks at 500 products (WP-2.10).

### 8.4 Security & Data Protection (NFR-7)

- Auth per WP-2.1; all traffic HTTPS (Caddy, auto-TLS); Telegram bot token & chat id encrypted at rest (AES-256-GCM via Node `crypto`, key from environment); DB not exposed off-box; containers run non-root; dependency audit (`pnpm audit` + lockfile scanning) in CI; bot chat-id allowlist; rate limiting on auth endpoints (`@nestjs/throttler`); no third-party analytics.

### 8.5 Backup & Recovery (NFR-9, R-6)

- Nightly `pg_dump` (custom format, compressed), 30 daily + 12 monthly retention, copied offsite; weekly automated restore-verification into a scratch database with row-count sanity checks; **documented, rehearsed restore runbook** (RTO ≤ 4 h, RPO ≤ 24 h) delivered with M2; compose `restart: unless-stopped` + VPS reboot persistence for crash recovery.

### 8.6 Documentation (supports NFR-6 and §16 maintenance)

- **User guide** (dashboard + bot commands, plain language, screenshots) — delivered with M2, updated M3.
- **Operations runbook:** deploy, upgrade, backup/restore, "marketplace broke — repair procedure" (capture failing page → add fixture → fix parser → fixtures green → deploy).
- **Developer docs:** adapter-authoring guide (the NFR-8 extension path), architecture notes, ADRs for the §1 decisions.

---

## 9. Deployment & Operations

| Item                                           | Plan                                                                                                                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Topology                                       | Single VPS, Docker Compose: `caddy`, `web`, `worker`, `db` + host cron for backups & external liveness ping                                                                                                                |
| Environments                                   | `dev` (local compose) → `staging` (VPS, separate hostname/DB — milestone demos) → `production`                                                                                                                             |
| Release process                                | Tagged image build in CI → compose pull & up on VPS → `prisma migrate deploy` runs as a release step before app containers roll (worker waits on migration completion) → smoke check (health endpoint + test notification) |
| Zero-data-loss upgrades                        | Migrations are additive-first; destructive migrations gated behind a backup-verified step in the runbook                                                                                                                   |
| Rollback                                       | Previous image tags retained; `compose up` with prior tag + (if needed) restore per §8.5                                                                                                                                   |
| Time zone                                      | All storage UTC; display & quiet-hours logic in user timezone (IST default)                                                                                                                                                |
| Cost envelope (client-borne, BRD Assumption 4) | VPS ~4 GB (≈ ₹1,500–2,500/mo), domain, offsite backup storage (≈ ₹100–300/mo); Telegram free                                                                                                                               |

---

## 10. Timeline, Effort & Dependencies

Assumes one full-time senior developer (the consultant). Calendar durations include milestone hardening + client-review buffers.

| Phase                                                | Duration   | Cumulative     |
| ---------------------------------------------------- | ---------- | -------------- |
| Phase 0 — Foundations                                | 1 week     | Week 1         |
| Milestone 1 — Core Tracking                          | 5–6 weeks  | Week 6–7       |
| M1 acceptance review + fixes                         | 0.5–1 week | Week 7–8       |
| Milestone 2 — Dashboard                              | 4–5 weeks  | Week 11–13     |
| M2 acceptance review + fixes                         | 0.5–1 week | Week 12–14     |
| Milestone 3 — Enhancements                           | 3–4 weeks  | Week 15–18     |
| M3 acceptance + handover (docs, runbook walkthrough) | 1 week     | **Week 16–19** |

**Total: ~4 to 4.5 months** end-to-end for full Phase 1 (M+S scope). If Should-have items are deferred (budget option per BRD §7), Phase 1 (M-only) completes at M2: **~3 to 3.5 months**.

### Critical path & dependency notes

- WP-1.1 (adapter framework) blocks WP-1.2/1.3, which block everything downstream — it is deliberately first and small.
- WP-1.2/1.3 (the two adapters) are the highest-uncertainty packages (live-site behaviour); they are scheduled early precisely so pacing/blocking realities inform WP-1.4 politeness tuning rather than surprising the project late. **Contingency:** if tier-1 HTTP access proves unreliable for a marketplace, tier-2 (Playwright) becomes primary for it — capacity math still holds at 500 products; sustained IP-level blocking triggers the R-2 conversation (proxy/commercial data provider as chargeable change).
- WP-1.10 (API surface) is what makes M2 primarily frontend work — M2 has low technical risk by design.
- All M3 packages are mutually independent — they can be delivered/dropped/reordered individually against remaining budget.
- Client-side dependencies (needed by end of Phase 0): VPS access, domain, Telegram bot token + chat, sample product list for soak testing, spreadsheet sample for import design.

---

## 11. Requirements Traceability Matrix

Every BRD requirement → implementing work package(s).

| Requirement                 | Work Package(s)                                                  | Milestone   |
| --------------------------- | ---------------------------------------------------------------- | ----------- |
| FR-1.1, FR-1.2, FR-1.3      | WP-1.6 (+ UI WP-2.5)                                             | M1 / M2     |
| FR-1.4                      | WP-1.6, WP-2.5                                                   | M1 / M2     |
| FR-1.5                      | WP-1.1 (canonicalization), WP-1.6                                | M1          |
| FR-1.6                      | WP-1.6, WP-2.4                                                   | M1 / M2     |
| FR-1.7                      | WP-2.9                                                           | M2          |
| FR-1.8 (S)                  | WP-3.4                                                           | M3          |
| FR-1.9 (C)                  | Out of scope — §14 design-ahead                                  | Phase 2     |
| FR-2.1                      | WP-1.5, WP-2.8 (live interval change)                            | M1 / M2     |
| FR-2.2, FR-2.3              | WP-1.2/1.3/1.4                                                   | M1          |
| FR-2.4                      | WP-1.5, WP-2.4 (UI), WP-1.9 (bot)                                | M1 / M2     |
| FR-2.5                      | WP-1.4                                                           | M1          |
| FR-2.6, FR-2.7              | WP-1.5                                                           | M1          |
| FR-2.8 (C)                  | Schema-ready (`priority_tier`, §3.2)                             | Phase 2     |
| FR-3.1–3.6                  | WP-1.7 (+ WP-1.5 for 3.6)                                        | M1          |
| FR-3.7                      | WP-1.7, WP-1.8                                                   | M1          |
| FR-3.8, FR-3.9, FR-3.10 (S) | WP-3.2                                                           | M3          |
| FR-4.1, FR-4.2, FR-4.3      | WP-1.8 (+ settings button WP-2.8)                                | M1 / M2     |
| FR-4.4, FR-4.5 (S)          | WP-1.9 (foundation), WP-3.1 (complete)                           | M1 / M3     |
| FR-4.6 (C)                  | Channel abstraction, §1.2-4                                      | designed-in |
| FR-5.1                      | WP-2.3                                                           | M2          |
| FR-5.2, FR-5.3              | WP-2.4                                                           | M2          |
| FR-5.4                      | WP-2.6                                                           | M2          |
| FR-5.5 (S)                  | WP-3.3                                                           | M3          |
| FR-5.6 (S)                  | WP-3.4                                                           | M3          |
| FR-5.7                      | WP-2.7                                                           | M2          |
| FR-5.8 (S)                  | WP-3.6                                                           | M3          |
| FR-5.9                      | WP-2.2, WP-2.10                                                  | M2          |
| FR-6.1, FR-6.2              | WP-2.8                                                           | M2          |
| FR-6.3 (S)                  | WP-3.5                                                           | M3          |
| FR-6.4                      | WP-2.1 + `user_id` schema (§3)                                   | M2          |
| NFR-1                       | WP-1.5 (isolation), §2 process split                             | M1          |
| NFR-2                       | §1.2-2, WP-2.3 health banner, §8.2                               | all         |
| NFR-3                       | WP-1.5/1.7/1.8 pipeline; verified in soak (WP-1.11)              | M1          |
| NFR-4                       | §3.3 partitioning, §8.5 backups                                  | Phase 0     |
| NFR-5                       | §8.3 capacity design; gated at WP-2.10                           | all         |
| NFR-6                       | WP-2.x UX, §8.6 user guide, WP-2.10 walkthrough                  | M2          |
| NFR-7                       | WP-2.1, §8.4                                                     | M2          |
| NFR-8                       | WP-1.1 adapter framework, §8.6 adapter guide                     | M1          |
| NFR-9                       | §8.5                                                             | M2          |
| Data Reqs 1–5 (§9 BRD)      | §3 schema (products / price_history / alerts / settings / users) | Phase 0     |
| Acceptance §14 items 1–9    | WP-1.11, WP-2.10, §8.1 simulation harness                        | M1/M2 gates |

**Coverage check:** every M and S requirement maps to a scheduled work package; every C requirement has an explicit design-ahead hook (§14 below) and is otherwise excluded per BRD §15 change control.

---

## 12. Engineering Risk Register

Extends the BRD's business risks with build-time mitigations.

| #    | Risk                                                                                       | Mitigation in this plan                                                                                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| ER-1 | Amazon/Flipkart markup changes mid-build (R-1)                                             | Fixture-first parser development (WP-1.2/1.3); multi-strategy extraction with provenance; parse-success-rate alarm (§8.2); documented repair procedure (§8.6)                                    |
| ER-2 | Bot detection blocks tier-1 HTTP (R-2)                                                     | TLS/header impersonation (got-scraping/impit); politeness layer (WP-1.4); automatic Playwright escalation; early live testing in weeks 2–4; proxy/provider fallback pre-scoped as change request |
| ER-3 | Wrong variant/seller parsed (R-5)                                                          | Registration preview confirmation; ASIN/itemId echo-check in adapters (WP-1.2); alert links to live listing                                                                                      |
| ER-4 | Alert-logic subtleties (crossing, cooldown interactions) produce false/missed alerts (R-4) | Pure-function engine with exhaustive unit tests (WP-1.7, WP-3.2); simulation harness for live demonstration                                                                                      |
| ER-5 | History table growth degrades dashboard                                                    | Monthly partitions, downsampled chart queries, incremental low/avg/high stats (§3.3, §8.3, WP-3.3)                                                                                               |
| ER-6 | Single-developer bus factor                                                                | CI, fixtures, runbooks, ADRs (§8.6) make the codebase maintainable by a successor — also protects the client under BRD §16                                                                       |
| ER-7 | Scope creep during build (R-7)                                                             | Traceability matrix (§11) is the scope contract; anything unmapped → BRD §15 change control                                                                                                      |
| ER-8 | Playwright memory pressure on small VPS                                                    | Browser pool capped (1–2 contexts), recycled per N pages; 4 GB VPS specified; tier-2 used only on escalation                                                                                     |

---

## 13. Definition of Done per Milestone

**Every milestone additionally requires:** CI green, no known data-loss bugs, docs updated, staging soak passed, joint client review per BRD §13.

- **Phase 0 done:** WP-0.5 exit criteria met; client dependencies (VPS, bot token, samples) received.
- **M1 done:** BRD acceptance items 1 (via API/bot), 3, 4, 5, 8 demonstrable; ≥ 95% check success over a 72-h soak of ≥ 100 real products; all M-priority FRs in sections 7.1–7.4 (except dashboard-only surfaces) implemented and traceable.
- **M2 done:** all nine BRD §14 acceptance criteria pass in a joint session, performed by the client alone through dashboard/Telegram (NFR-6); backup + restore rehearsed; user guide delivered.
- **M3 done:** all S-priority FRs demonstrated; alert-hygiene scenario test passed; regression of M1/M2 acceptance green; handover complete (runbooks, credentials, maintenance-agreement scope confirmed per BRD §16).

---

## 14. Phase 2 Preparedness (Design-Ahead Items)

No Phase 2 work is built now (BRD §15), but Phase 1 deliberately leaves these seams so Phase 2 is quotable and low-risk:

| Phase 2 item (BRD §13)             | Seam left in Phase 1                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Additional marketplaces            | Adapter framework (WP-1.1) + adapter-authoring guide; marketplace enum extensible                 |
| Name-based product search (FR-1.9) | Registration service separates "resolve input → listing" from "register listing"                  |
| Email/WhatsApp channels (FR-4.6)   | `NotificationChannel` abstraction; `alerts.channel` column                                        |
| Multi-user accounts                | `user_id` on every owned table; per-user settings & telegram config; auth already session-based   |
| Sale-event fast checking (FR-2.8)  | `priority_tier` column; per-product `next_check_at` scheduler already supports variable intervals |
| Price-trend insights               | Indefinite normalized history (NFR-4) is the training/analysis substrate                          |

---

_— End of Implementation Plan —_
