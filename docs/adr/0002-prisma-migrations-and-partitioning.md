# ADR-0002: Migration Discipline & price_history Partitioning

**Status:** Accepted · **Date:** 2026-07-10

## Context

`price_history` receives one row per check per product — ~8.8M rows/year at 500 products / 30-minute interval — and is retained indefinitely (NFR-4). It is monthly range-partitioned by `checked_at`. Prisma cannot declare partitioned tables in its schema language.

## Decision

1. The Prisma schema remains the source of truth for **types** (the generated client reads/writes `price_history` through the parent table transparently).
2. Migrations are **authored** with `prisma migrate diff` and hand-edited where Prisma's SQL is insufficient — the initial migration replaces the plain `CREATE TABLE price_history` with a `PARTITION BY RANGE (checked_at)` version, adds the `ensure_price_history_partitions(months_ahead)` routine, and creates the initial partitions.
3. Migrations are **applied** with `prisma migrate deploy` in every environment, including local dev. `prisma migrate dev` is not used (its drift detection does not understand the partitioned table).
4. The worker calls the partition-ensure routine on a schedule (Milestone 1); a missing partition makes inserts fail loudly rather than silently dropping rows — by design (NFR-2). There is deliberately no DEFAULT partition.
5. The primary key is `(id, checked_at)` because PostgreSQL requires the partition key inside the PK. `id` remains a plain bigserial sequence (PG16 does not support identity columns on partitioned tables).

## Consequences

- Schema changes to `price_history` need hand-written SQL; everything else stays on the normal Prisma path.
- A drift check comparing schema.prisma to the live DB will show the partitioning difference; this is expected and documented here.
