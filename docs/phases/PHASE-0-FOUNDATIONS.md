# PricePulse — Phase 0 Implementation Document: Project Foundations

|                      |                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document Version** | 1.0                                                                                                                                                                                                                                    |
| **Date**             | 10 July 2026                                                                                                                                                                                                                           |
| **Parent Documents** | BRD-PricePulse.md v1.0; IMPLEMENTATION-PLAN.md v1.1                                                                                                                                                                                    |
| **Phase Duration**   | 1 week                                                                                                                                                                                                                                 |
| **Phase Outcome**    | A fully tooled, deployable, empty application skeleton: web app, worker, database with complete schema, CI pipeline, and local/staging environments — ready for Milestone 1 feature work to begin on day one with zero setup friction. |

---

## 1. Purpose of This Phase

Phase 0 exists so that every subsequent milestone spends its time on features, not on infrastructure. It front-loads all decisions that are expensive to change later: repository structure, database schema, migration discipline, environment topology, and secret handling. It also collects every client-side dependency (hosting, Telegram bot, sample data) so that no milestone is ever blocked waiting on the client.

**Guiding rule:** at the end of Phase 0, a developer new to the project can clone the repository, run one command, and have the full system running locally; and a deploy to the staging server is a routine, scripted act — not an event.

---

## 2. Scope Summary

### 2.1 In Scope

- Monorepo creation with all workspace packages stubbed and wired.
- Continuous integration pipeline (lint, typecheck, test, build) running on every push.
- Local development environment (one-command bring-up with hot reload).
- Staging environment on the client VPS (separate hostname and database from future production).
- Complete database schema for the entire Phase 1 product, migrated and seeded.
- Configuration and secret-management conventions.
- Collection and verification of all client-provided dependencies.

### 2.2 Out of Scope

- Any user-facing feature (registration, monitoring, alerts, dashboard).
- Production hardening beyond sensible defaults (full security pass is WP-2.1 / §8.4 of the plan).
- Backup automation (delivered with Milestone 2 per NFR-9; the staging DB is disposable during development).

---

## 3. Entry Criteria (Client Dependencies)

Phase 0 both starts and _collects_; these items are requested on day one and must all be in hand by the end of the week:

| #   | Dependency                                                                                           | Needed For                                          | Requested From |
| --- | ---------------------------------------------------------------------------------------------------- | --------------------------------------------------- | -------------- |
| D-1 | VPS access (SSH), sized at least 2 vCPU / 4 GB RAM                                                   | Staging environment; later production               | Client         |
| D-2 | Domain or subdomain for the application, with DNS control                                            | HTTPS via Caddy; staging hostname                   | Client         |
| D-3 | Telegram bot token (client-created or consultant-created with client approval, per BRD Assumption 2) | Milestone 1 notification work                       | Client         |
| D-4 | Destination Telegram chat/channel ID                                                                 | Milestone 1 notification work                       | Client         |
| D-5 | A realistic sample product list (50–150 real Amazon India and Flipkart URLs)                         | Milestone 1 soak testing; adapter fixture selection | Client         |
| D-6 | A sample of the client's existing spreadsheet format (if any)                                        | Bulk-import column-mapping design (WP-2.9)          | Client         |
| D-7 | Written acknowledgement of BRD Risk R-3 (ToS posture) at BRD sign-off                                | Project start                                       | Client         |

If any item is late, feature work still starts on schedule; the dependency is escalated in the weekly status note with the specific milestone task it will eventually block.

---

## 4. Work Packages

### WP-0.1 — Repository, Workspace & Tooling

**Objective:** a monorepo in which backend, worker, frontend, and shared contracts live together, share one dependency tree, and enforce one code standard.

**Detailed scope:**

1. **Workspace layout** (pnpm workspaces):
   - An API application package: the NestJS HTTP application (REST, auth, SSE, static SPA serving).
   - A worker application package: the NestJS standalone application context (scheduler, scraping, alerting, Telegram).
   - A web application package: the Vite + React + TypeScript single-page application.
   - A shared package: data-transfer types, validation schemas, enumerations (marketplace, alert type, stock status, failure reason, product status), and formatting helpers (currency, relative time) consumed by all three applications.
   - An adapters package: the marketplace-adapter framework and its implementations, isolated per NFR-8 so a future marketplace is a change to this package only.
   - A deploy directory: compose definitions, reverse-proxy configuration, operational scripts.
   - A docs directory: this document set, runbooks, ADRs.
2. **Language and compiler standards:** TypeScript strict mode in every package; a single root TypeScript configuration extended per package; path aliases so cross-package imports are explicit and typed.
3. **Code quality tooling:** one ESLint configuration and one Prettier configuration at the root, applied uniformly; import-ordering and unused-code rules on; a pre-commit hook running lint and format on staged files.
4. **Testing scaffolds:** Vitest configured in every package with one passing placeholder test each, so the CI test stage is meaningful from the first day.
5. **Developer ergonomics:** a task runner (make or package scripts) exposing the canonical commands — bring up dev environment, run all tests, lint everything, build everything, open database console; a README covering setup from a clean machine in under ten minutes.
6. **Decision records:** an ADR (architecture decision record) template and the first ADRs capturing the §1 stack decisions from the implementation plan, including the NestJS revision and its rationale.

**Acceptance criteria:**

- Clean clone → install → all placeholder tests pass, lint passes, all packages build.
- A deliberately mis-formatted file is rejected by the pre-commit hook.
- Cross-package type import (shared package into API and web packages) compiles and type-checks.

**Estimate:** 1.5 days.

---

### WP-0.2 — Continuous Integration Pipeline

**Objective:** every push is automatically proven safe to the standard the project will rely on for the next year of maintenance.

**Detailed scope:**

1. **Pipeline stages, in order:** dependency install with lockfile verification → lint → typecheck (all packages) → unit tests (all packages) → production builds (API, worker, SPA) → Docker image builds.
2. **Scraper regression stage (placeholder now, real from Milestone 1):** a dedicated stage that runs the adapter fixture suites; explicitly configured so that **no CI run ever contacts a live marketplace** — fixture files are the only inputs. This stage is created in Phase 0 (empty but wired) so Milestone 1 drops fixtures into an existing harness.
3. **Image publishing:** tagged builds (git tag → versioned image) pushed to a container registry accessible from the VPS; every image labelled with git commit and build time.
4. **Dependency hygiene:** an audit step (advisory-level in Phase 0, blocking severity threshold agreed during Milestone 2 hardening) and an automated lockfile-freshness report.
5. **Status discipline:** the default branch is protected; merges require a green pipeline.

**Acceptance criteria:**

- A commit with a type error, a failing test, or a lint violation produces a red pipeline.
- A tagged commit produces retrievable, runnable images for API and worker.

**Estimate:** 1 day.

---

### WP-0.3 — Local & Staging Environments

**Objective:** the same containerised topology everywhere; "works on my machine" and "works on staging" are the same statement.

**Detailed scope:**

1. **Local development compose:** PostgreSQL, API with hot reload, worker with hot reload, SPA dev server with proxy to the API; seeded database on first start; a single documented command brings everything up and a single command tears it down (with and without data).
2. **Staging environment on the VPS:**
   - Docker and compose runtime installed and hardened (non-root service user, firewall allowing only SSH and HTTP/S, SSH key-only auth).
   - Staging compose file: reverse proxy (Caddy, automatic TLS on the staging hostname), API, worker, PostgreSQL — all with restart-unless-stopped policies.
   - Staging is intentionally identical in shape to future production; production bring-up (Milestone 2) is a second compose project with its own hostname, database, and secrets.
3. **Deployment script:** a scripted deploy (pull tagged images, run migrations as a release step, restart services, run a smoke check that verifies the API health endpoint and worker heartbeat). Executable by the consultant in one command; documented in the operations runbook skeleton.
4. **Environment parity rules documented:** what is allowed to differ between local, staging, and production (secrets, hostnames, resource limits) and what is not (schema, image contents, service topology).

**Acceptance criteria:**

- One-command local bring-up on a clean machine ends with reachable web app shell, healthy API, and worker heartbeat recorded in the database.
- Staging reachable over HTTPS at its hostname; deploy script executes end-to-end from a tagged CI image; smoke check passes.

**Estimate:** 1.5 days.

---

### WP-0.4 — Database Foundation & Complete Schema

**Objective:** the entire Phase 1 schema (implementation plan §3) exists from day one, under migration control, so that no milestone ever performs destructive restructuring — features fill tables that already exist.

**Detailed scope:**

1. **Migration discipline:** Prisma schema as the source of truth for ordinary tables; hand-written SQL migration steps, versioned in the same migration stream, for everything Prisma cannot express — notably the monthly partitioning of the price-history table and its partition-management routine.
2. **Full schema creation, covering:**
   - Users table (single seeded account; structure per multi-user readiness principle).
   - Products table with all columns from plan §3.2, including the current-state snapshot columns, status enumeration (active / paused by user / paused automatically), crossing-latch flag, linked-product self-reference, and priority tier (schema-ready for Phase 2).
   - Price-history table, monthly-partitioned, with the full success/failure/reason/extraction-tier column set; an automated routine that creates future partitions ahead of time (and its failure mode alarmed — a missing partition must never silently drop history rows).
   - Alerts table with type enumeration, old/new value payloads, delivery status lifecycle.
   - Settings storage with typed accessors for every configurable named in FR-6.1 and the Milestone 3 hygiene settings (cooldown, quiet hours, digest) so no later migration is needed.
   - Import-batches table for the FR-1.7 report.
   - System-status single-row health snapshot.
   - pg-boss's queue schema, provisioned in its own namespace.
3. **Indexing plan applied up front:** scheduler queue index (next-check time on active products), history lookups (product + checked-at), alert log (user + fired-at), catalogue search support.
4. **Seed script:** one user account (credentials delivered out-of-band), default settings row (30-minute interval, default thresholds, all mandatory alert types on), empty catalogue.
5. **Data dictionary:** a docs page describing every table and column in business terms, cross-referenced to BRD Section 9 — this becomes the contract that the FR-6.4 "no restructuring for multi-user" promise is judged against.

**Acceptance criteria:**

- Migrations run cleanly on an empty database, locally and on staging; re-running is a no-op.
- Partition routine demonstrably creates the next month's partition; inserting a history row dated in a future covered month succeeds.
- Seeded login row exists; a schema-diff check between Prisma schema and live database is clean.

**Estimate:** 1.5 days.

---

### WP-0.5 — Configuration & Secrets Conventions

**Objective:** twelve-factor configuration with no secret ever entering the repository, and a defined home for every configurable value.

**Detailed scope:**

1. **Configuration taxonomy** documented and enforced: (a) build-time constants; (b) environment configuration (DB connection, listen ports, public URL, log level) — environment variables; (c) **user-facing settings** (interval, thresholds, toggles, Telegram credentials) — database-held, editable from the future settings screen per FR-6.2, never environment variables.
2. **Secret set defined and provisioned per environment:** database credentials, JWT signing key, settings-encryption key (for Telegram credentials at rest), container-registry credentials on the VPS. Environment template files (with placeholders, committed) and real files (ignored, per environment) with restrictive permissions.
3. **Fail-fast validation:** both API and worker validate their entire environment configuration at startup and refuse to boot with a precise message naming the missing/invalid variable — configuration errors must be loud, in keeping with NFR-2's no-silent-failure ethos.
4. **Key rotation notes** in the runbook: how each secret is rotated and what it invalidates.

**Acceptance criteria:**

- Booting with a missing required variable fails immediately with a message naming it.
- Repository history contains no real secret (verified with a secret-scanning pass in CI).

**Estimate:** 0.5 day.

---

## 5. Phase-Level Testing & Verification

| Verification                 | Method                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------ |
| Clean-machine onboarding     | Performed literally on a second machine/user account following only the README                         |
| CI gate correctness          | Intentional bad commits (type error, failing test, lint violation, embedded fake secret) each rejected |
| Staging deploy repeatability | Deploy script run twice consecutively; second run is a clean no-op restart                             |
| Schema completeness          | Every table/column in implementation-plan §3 present; data dictionary reviewed against BRD Section 9   |

---

## 6. Deliverables Checklist

- [ ] Monorepo with all packages, tooling, and passing CI.
- [ ] CI pipeline with fixture-stage wiring and image publishing.
- [ ] Local one-command environment; staging environment live over HTTPS.
- [ ] Scripted, documented deploy with smoke check.
- [ ] Complete migrated schema + partitioning routine + seed; data dictionary.
- [ ] Configuration/secrets conventions and environment templates; runbook skeleton and first ADRs.
- [ ] Client dependency register (D-1…D-7) with status of each item.

---

## 7. Exit Criteria

Phase 0 is complete when:

1. All acceptance criteria in WP-0.1 through WP-0.5 pass.
2. The staging environment serves the empty application over HTTPS and survives a VPS reboot with all services returning.
3. All client dependencies D-1 through D-7 are received, or formally escalated with the milestone task each blocks.
4. Milestone 1 can begin with no known setup work remaining.

---

## 8. Phase-Specific Risks

| Risk                                                      | Mitigation                                                                                                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| VPS or domain provisioning delayed by client              | Local environment is fully sufficient for Milestones 1 feature development; staging need only exist before the first soak test (Milestone 1, week 4)                                   |
| Partitioning under an ORM proves awkward later            | Partition DDL lives in plain SQL migrations from the start; the ORM only ever reads/writes through the parent table; this boundary is documented in an ADR                             |
| Schema designed before features are built misses a column | Additive migrations remain cheap forever; the rule being protected is _no destructive restructuring_, which the up-front design of keys, ownership (user id), and enumerations secures |

---

_— End of Phase 0 Implementation Document —_
