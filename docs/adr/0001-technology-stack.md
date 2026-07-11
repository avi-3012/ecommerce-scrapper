# ADR-0001: Technology Stack

**Status:** Accepted · **Date:** 2026-07-10

## Context

The implementation plan v1.0 proposed Python/FastAPI. The client asked for a NestJS backend (plan revised to v1.1). The full decision table lives in [IMPLEMENTATION-PLAN.md §1.1](../../IMPLEMENTATION-PLAN.md); this ADR records the reasoning that must outlive the discussion.

## Decision

- **Node.js 22 + TypeScript everywhere**, NestJS 11 for the API, a NestJS standalone application context for the worker, React/Vite for the SPA — one language, with `packages/shared` as the single contract package consumed by backend and frontend.
- **PostgreSQL 16 + Prisma**; **pg-boss** (Postgres-backed) for jobs instead of Redis/BullMQ — one stateful service in Phase 1.
- **Scraping:** got-scraping/impit (tier-1 impersonated HTTP) + cheerio parsing, Playwright as tier-2 fallback.
- **Telegram:** grammY.

## Consequences

- Shared DTO/validation types eliminate API↔frontend contract drift.
- Node's scraping ecosystem is adequate but thinner than Python's; the mitigation is the fixture-first adapter methodology (Milestone 1 doc, WP-1.2/1.3), which is language-agnostic.
- No Redis to operate; if Phase 2 outgrows pg-boss, BullMQ is a contained swap behind the job-queue seam.
- The web/worker split is two processes sharing one database — either can die without taking the other down (NFR-1).
