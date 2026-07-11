# PricePulse — Milestone 1 Implementation Document: Core Tracking Engine

|                        |                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document Version**   | 1.0                                                                                                                                                                                                                                   |
| **Date**               | 10 July 2026                                                                                                                                                                                                                          |
| **Parent Documents**   | BRD-PricePulse.md v1.0; IMPLEMENTATION-PLAN.md v1.1                                                                                                                                                                                   |
| **Milestone Duration** | 5–6 weeks (+ up to 1 week acceptance review)                                                                                                                                                                                          |
| **BRD Definition**     | "Working tracker demonstrable end-to-end via Telegram" — all Must-have requirements except the dashboard                                                                                                                              |
| **Milestone Outcome**  | A real product catalogue is tracked around the clock; every alert type fires correctly to Telegram; failures are detected, categorised, and surfaced; the whole system is operable through the Telegram bot and an authenticated API. |

---

## 1. Purpose and Position of This Milestone

Milestone 1 builds the entire value-producing core of PricePulse: data collection, history, alerting, and delivery. Everything in Milestone 2 is a window onto what Milestone 1 creates; everything in Milestone 3 refines it. It also deliberately front-loads the project's highest-uncertainty work — live scraping of Amazon India and Flipkart — into weeks 2–4, so that any marketplace-access reality (blocking, pacing limits) reshapes plans early rather than late.

**Operator interface during this milestone:** the Telegram bot (primary) plus a minimal authenticated JSON API (secondary). The API surface built here is exactly the surface the Milestone 2 dashboard will consume; nothing in Milestone 2 requires backend rework.

---

## 2. Scope Summary

### 2.1 In Scope (requirements delivered)

- FR-1.1 – FR-1.6 (registration, detection/rejection, preview, per-product settings, duplicate prevention, edit/pause/delete) — via API and bot.
- FR-2.1 – FR-2.7 (scheduled monitoring, capture set, history of every check, on-demand checks, politeness, auto-pause, out-of-stock semantics).
- FR-3.1 – FR-3.7 (all six alert types with crossing semantics; alert content).
- FR-4.1 – FR-4.3 (Telegram delivery, delivery outcome recording, test notification) and the foundations of FR-4.4/4.5 (bot registration with preview, list/check/status commands).
- NFR-1, NFR-2, NFR-3, NFR-8 substantially; NFR-5 validated at soak scale.

### 2.2 Out of Scope (this milestone)

- All dashboard/browser UI (Milestone 2). Bulk import (Milestone 2 — its politeness queue is designed here).
- Should-have items: full bot management command set, cooldown, quiet hours, digest, deal-quality stats, cross-platform linking, export, live updates (Milestone 3).
- Auth hardening beyond a functional login (Milestone 2, WP-2.1).

### 2.3 Entry Criteria

- Phase 0 exit criteria met; client dependencies D-3, D-4 (Telegram bot + chat) and D-5 (sample product list) in hand.

---

## 3. Work Packages

### WP-1.1 — Marketplace Adapter Framework

**Objective:** the plugin boundary (NFR-8) behind which all marketplace-specific knowledge lives. Every other component in the system depends only on this interface and its normalized output.

**Detailed functional scope:**

1. **Adapter contract.** Each marketplace adapter provides four capabilities: recognising whether a URL belongs to it; canonicalising a URL; fetching the listing page; parsing a fetched page into a normalized product snapshot. Adapters are registered through dependency injection and discovered by domain; the rest of the system iterates the registry and never names a marketplace directly.
2. **URL recognition & rejection.** Detection covers all real-world URL shapes for both marketplaces: desktop URLs, mobile-site URLs, app-share short links (Amazon's short domain, Flipkart's deep-link domain), and links wrapped in tracking redirects. Any URL matching no adapter yields a structured "unsupported marketplace" outcome carrying the site name detected (if any), which the API and bot translate into the FR-1.2 user message naming the supported marketplaces.
3. **Canonicalisation.** For each marketplace: strip tracking/referral/session query parameters; resolve short links to full listing URLs; extract the stable product identifier (ASIN for Amazon, item identifier for Flipkart); produce a canonical URL that is identical for any two links pointing at the same listing. Duplicate prevention (FR-1.5) is defined as uniqueness of this canonical URL per user — meaning two differently-decorated links to one listing are correctly recognised as the same product.
4. **Normalized product snapshot.** The single shape every adapter must produce: product name; selling price; MRP; computed discount percentage; the offers list; stock status (in stock / out of stock / unknown); primary image reference; and per-field provenance recording _which extraction strategy_ produced each value (used by scraper-health monitoring). This type lives in the shared package so the Milestone 2 preview card renders it directly.
5. **Offer normalization.** Rules that turn each marketplace's promotional text into comparable structures: classification into bank instant discount / coupon / cashback / exchange bonus / other; whitespace and punctuation normalization; a deterministic ordering; and a stable hash over the normalized set. The hash is the FR-3.4 change-detection primitive, so its stability rules (what changes the hash, what must not) are specified and unit-tested exhaustively — e.g. reordered offers must not change the hash; a changed discount amount within an offer must.
6. **Snapshot validation.** A parsed snapshot is rejected (categorised as a parse failure, never stored as fact) if it violates sanity rules: missing or non-positive selling price on an in-stock listing; MRP lower than selling price beyond a tolerance; empty product name. This is the guard that keeps garbage out of the permanent history.

**Edge cases explicitly specified and tested:** URLs with no scheme; URLs to marketplace home/search/category pages (recognised marketplace but not a product listing — distinct rejection message); listing URLs for the same product with different variant parameters (treated as _different_ listings — the user tracks a specific variant, per BRD R-5).

**Acceptance criteria:** canonicalisation test suite of at least 20 real-world URL variants per marketplace passes; identical canonical output for decorated vs. clean links to the same listing; unsupported and non-listing URLs produce their distinct structured rejections.

**Estimate:** 3 days. **Depends on:** Phase 0.

---

### WP-1.2 — Amazon India Adapter

**Objective:** reliable extraction of the FR-2.2 capture set from amazon.in listing pages, resilient across page layout variants, with failures categorised rather than silent.

**Detailed functional scope:**

1. **Tier-1 fetching.** HTTP fetching with browser-grade TLS and header impersonation; realistic header profiles rotated per request; cookie handling per session; explicit timeout budget; detection of anti-bot interstitials (CAPTCHA/robot pages) as a distinct outcome (`fetch_blocked`), never as a parse attempt.
2. **Layered parsing.** For each captured field, an ordered list of extraction strategies is attempted: embedded structured data first, then the primary known page locations, then documented fallbacks. The strategy that succeeded is recorded per field (provenance). One field failing all strategies fails the check as `parse_failed` naming the field — partial snapshots are never recorded as successes.
3. **Capture set specifics for Amazon:** buy-box selling price (including deal prices); MRP/list price; title; coupon badges, bank-offer strips and cashback promotions into normalized offers; availability states mapped to the stock enumeration — in stock, temporarily out of stock, currently unavailable (all _successful_ checks per FR-2.7); main product image.
4. **Variant and seller discipline (BRD R-5).** Only the default/buy-box offer of the listing as registered is parsed. The product identifier present on the parsed page is compared with the identifier registered; a mismatch (marketplace redirected to a different variant/product) is a categorised failure, not a silently tracked wrong product.
5. **Listing lifecycle states.** Removed/dead listings (404 or "page not found" content) → `listing_removed` failure category, which flows into consecutive-failure handling and produces an unambiguous eventual auto-pause message ("the listing appears to have been removed").
6. **Tier-2 fallback.** The same parse layer applied to a headless-browser-rendered page when tier-1 fetching is blocked or tier-1 parsing fails; escalation rules and their telemetry defined in WP-1.4.
7. **Fixture suite.** At least 15 captured real pages held in the repository: normal in-stock, deal price, coupon present, bank offer present, multiple offers, out of stock, temporarily unavailable, currently unavailable, removed listing, CAPTCHA interstitial, robot-check page, mobile-layout variant, quantity-limited listing, price-range listing, and a deliberately unknown future-layout page (asserting it fails _cleanly_ as parse-failure). Every extraction rule change must keep the whole suite green — this suite is the R-1 repair safety net.

**Acceptance criteria:** full fixture suite green in CI; live spot-check of 25 diverse real listings achieving ≥ 95% successful extraction with all sanity validations passing; CAPTCHA and removed-listing pages categorised correctly.

**Estimate:** 5 days (highest-uncertainty package; includes live behavioural discovery). **Depends on:** WP-1.1.

---

### WP-1.3 — Flipkart Adapter

**Objective:** as WP-1.2, for flipkart.com.

**Detailed functional scope (differences from Amazon noted):**

1. Tier-1 fetching as WP-1.2, tuned to Flipkart's anti-bot behaviour (independently assessed — assumptions from Amazon are not carried over).
2. **Parsing strategy order:** Flipkart commonly ships listing state as embedded structured data in the page — that is the primary strategy, with rendered-markup selectors as fallback; provenance recorded as in WP-1.2.
3. **Capture set specifics for Flipkart:** selling price and struck-through MRP; the offers list (bank offers, special-price promotions, combo offers) normalized per WP-1.1 rules; stock states including Flipkart-specific "Coming Soon" and "Notify Me" (both map to out-of-stock, successful checks); "Sold Out" and unserviceable states; title and image.
4. Variant discipline, lifecycle states, tier-2 fallback, and a ≥ 15-page fixture suite, all to the same standard and same categories as WP-1.2 with Flipkart-specific states added.

**Acceptance criteria:** identical in form to WP-1.2, against Flipkart pages and fixtures.

**Estimate:** 4 days (benefits from WP-1.2 patterns). **Depends on:** WP-1.1; can overlap the tail of WP-1.2.

---

### WP-1.4 — Scrape Pipeline & Politeness Layer

**Objective:** the orchestration wrapper that turns a "check this product" instruction into exactly one recorded history row — success or categorised failure — while keeping monitoring traffic well below anything resembling abuse (FR-2.5).

**Detailed functional scope:**

1. **Check lifecycle.** Fetch (tier 1) → parse → validate → snapshot; on defined failure classes, escalate once to tier 2 (browser) and repeat parse/validate. Transient network errors retried once with backoff within the same check. Total per-check time budget enforced; budget exhaustion is itself a categorised failure (`fetch_timeout`).
2. **Escalation policy.** Which tier-1 outcomes escalate to tier 2 (blocked, parse-failed) and which do not (listing removed, timeout); per-marketplace flags allowing tier 2 to be made primary for a marketplace if tier-1 access degrades (the WP-1.11 contingency lever); every check records which tier produced its result.
3. **Politeness controls (FR-2.5):** per-marketplace concurrency caps (2–3); a minimum randomized gap between successive requests to the same marketplace; per-request jitter; checks due in a cycle shuffled and spread across the whole interval window rather than fired at cycle start; a global stop lever (all monitoring pausable instantly via settings, for emergencies).
4. **Guaranteed history write.** The pipeline is structured so no exit path exists that does not write exactly one history row per FR-2.3 — carrying either the full capture set (price, MRP, discount, offers, offer-hash, stock, timestamp) or the failure category with detail, plus extraction tier and duration.
5. **Failure taxonomy** (fixed vocabulary used across history, auto-pause messages, bot/status output, and later the dashboard):

| Category        | Meaning                               | User-facing phrasing                                       |
| --------------- | ------------------------------------- | ---------------------------------------------------------- |
| fetch_blocked   | Anti-bot interstitial / access denied | "The marketplace temporarily blocked automated access"     |
| fetch_timeout   | Time budget exceeded                  | "The marketplace did not respond in time"                  |
| http_error      | Unexpected server response            | "The marketplace returned an error"                        |
| parse_failed    | Page retrieved, data not extractable  | "The page layout has changed; maintenance may be required" |
| listing_removed | Listing gone                          | "The listing appears to have been removed"                 |
| captcha         | Explicit CAPTCHA challenge            | "The marketplace presented a verification challenge"       |
| other           | Anything else, with detail            | "An unexpected error occurred"                             |

6. **Browser-resource stewardship:** a small capped pool of browser contexts, recycled after a fixed number of pages, memory-observed — sized for the 4 GB VPS (plan ER-8).

**Acceptance criteria:** fault-injection tests (timeouts, blocks, malformed pages, mid-check crashes) each produce exactly one correctly-categorised history row; concurrency and minimum-gap rules verifiably honoured under a 100-product synthetic load; no check path exists without a history write (verified by test coverage over all pipeline exits).

**Estimate:** 4 days. **Depends on:** WP-1.1 (interfaces); tunes against WP-1.2/1.3 realities.

---

### WP-1.5 — Scheduler & Monitoring Loop

**Objective:** the always-on heart of the system (FR-2.1): every active product checked at the configured interval, forever, with per-product failure never disturbing the whole (NFR-1).

**Detailed functional scope:**

1. **Due-product scheduling.** Each product carries its own next-check time. The worker continuously selects due products and hands them to the pipeline under the politeness constraints. After every check, the product's next-check time advances by the configured interval (with jitter).
2. **Live interval changes (FR-2.1/6.2).** The interval is read from settings each cycle; a change immediately recomputes upcoming next-check times without restart. Behaviour on shortening and lengthening the interval is specified (no product may be starved or double-checked by the transition).
3. **On-demand checks (FR-2.4).** Queue-delivered jobs for one product or all products, honoured ahead of scheduled work but _within_ politeness constraints (an on-demand "check all 500" paces itself; it does not stampede). On-demand results flow through the identical pipeline (history, alerts, state updates).
4. **Auto-pause (FR-2.6, FR-3.6).** A consecutive-failure counter per product: incremented on failed checks, reset on success, **never incremented by out-of-stock results** (FR-2.7). At the configured limit (default 5, settings-editable) the product transitions to paused-automatically status and an auto-pause alert is emitted stating product, marketplace, and the dominant failure category in user phrasing. Distinctness rule: user-paused and auto-paused are different states; resuming either is explicit; a resumed auto-paused product starts with a clean failure counter.
5. **Missed-cycle recovery (R-6).** After downtime, everything overdue is simply due now — processed under normal pacing, with no attempt to backfill missed history rows and no burst of stale alerts: alert evaluation always compares against the last _successful_ check, so a gap produces at most one alert per genuinely-changed product.
6. **Cycle bookkeeping (NFR-2, FR-5.1 groundwork).** On each cycle completion the system-status row is updated: cycle started/finished, due/checked/succeeded/failed counts, rolling 7-day success percentage (the Success-Criterion-1 measure). The worker writes a heartbeat on a short fixed period; the API exposes staleness so any interface can show "monitoring stalled".
7. **Isolation guarantees (NFR-1).** A per-product check failure of any kind — including an adapter crash — is contained and recorded; the loop continues. Worker process death is recovered by the container restart policy; on restart the loop resumes from durable state with no manual step.

**Acceptance criteria:** fake-clock tests cover interval change mid-cycle, auto-pause at exactly the configured threshold, counter reset on success, out-of-stock non-counting, and overdue-recovery producing single alerts; a killed worker resumes correctly; heartbeat staleness is observable via the API within one heartbeat period.

**Estimate:** 4 days. **Depends on:** WP-1.4.

---

### WP-1.6 — Product Registration & Management Service

**Objective:** the FR-1.x lifecycle, exposed through the API (and consumed by the bot in WP-1.9): register with live preview, configure, edit, pause/resume, delete.

**Detailed functional scope:**

1. **Preview operation (FR-1.3).** Input: a URL. Steps: adapter detection (unsupported → FR-1.2 rejection naming supported marketplaces; non-listing page → its distinct rejection); canonicalisation; duplicate check (already tracked → response identifies the existing product, FR-1.5); **live fetch and parse now** through the standard pipeline (politeness-constrained but prioritised); output: the full normalized snapshot for user confirmation. Preview does not persist anything. Performance target: 95th percentile under 15 seconds, supporting the BRD's under-one-minute registration criterion. Failure of the live fetch returns the categorised reason with a retry hint — the user is never shown a bare error.
2. **Registration (FR-1.1, FR-1.4).** Persists the confirmed product with: display name (defaulting from the snapshot, user-overridable), optional target price, optional per-product drop-threshold percentage, free-text notes, category tags (multiple). The preview snapshot is written as the product's first history row and becomes its current state; the product enters the schedule immediately. Validation rules specified for each field (target price positive and sane relative to current price with a confirm-anyway path; threshold percentage bounds; tag length/count limits).
3. **Editing.** All user-set fields editable at any time; target-price edits interact with crossing state (defined precisely in WP-1.7 — e.g. raising the target above the current price re-arms the alert).
4. **Pause / resume (FR-1.6).** User-pause stops scheduling but retains everything; resume re-enters the schedule with an immediate check. Interactions with auto-pause status per WP-1.5.
5. **Deletion (FR-1.6).** Two-step: request → explicit confirmation carrying a summary of what is lost (history row count, alert count). On confirmation: product, its full history, and its alerts are removed (short soft-delete window before hard purge as an operational mercy; not exposed as a user feature). Linked-product references (Milestone 3) specified now: deleting one side of a link severs the link.
6. **Duplicate semantics (FR-1.5).** Uniqueness on canonical URL per user; re-registering a deleted product is permitted and starts a fresh history; attempting to register an existing paused product points at it and offers resume.

**Acceptance criteria:** end-to-end API tests for every path above, including both rejection classes, duplicate variants (decorated URL of an already-tracked listing), preview-fetch failure, delete-with-confirmation, and re-registration after delete.

**Estimate:** 4 days. **Depends on:** WP-1.1–1.4.

---

### WP-1.7 — Alert Engine

**Objective:** deterministic, exhaustively-tested evaluation of every alert rule (FR-3.1–3.7) as a pure function of previous state, new snapshot, product configuration, and global settings.

**Detailed functional scope — rule by rule:**

1. **Target price (FR-3.1) — crossing semantics.** Fires when the price moves from above-target to at-or-below-target. A per-product latch records crossed state: while latched, further at-or-below checks are silent; the latch resets when a price strictly above target is observed, re-arming the alert. Specified interactions: target edited to below current price (latch resets, no immediate fire); target edited to above current price (fires on the _next check_ that observes at-or-below — the edit itself does not synthesise an alert); product with no previous successful check (first check at-or-below target _does_ fire — the user registered wanting to know); target removed (latch cleared).
2. **Threshold drop (FR-3.2).** Fires when the percentage drop from the previous successful check's price meets or exceeds the applicable threshold — per-product override if set, else global default. Comparison is always against the last _successful_ check (failed checks in between are transparent). Rounding and boundary behaviour specified (exactly-at-threshold fires).
3. **Any-change (FR-3.3).** Global toggle, default off. Fires on any price difference from the previous successful check, rise or fall, including changes smaller than the threshold. Suppression rule: when a movement qualifies for a more specific price alert (target/threshold), the any-change alert for the same movement is not additionally sent.
4. **Offer change (FR-3.4).** Global toggle. Fires when the normalized offer-hash differs from the previous successful check. The alert payload carries the added offers and removed offers as lists, so the message can say what appeared/disappeared. Fires independently of price movement (UC-5's effective-price case).
5. **Back-in-stock (FR-3.5).** Fires on the transition out-of-stock → in-stock across successful checks. Unknown stock status never participates in transitions (no alert into or out of unknown). Out-of-stock → out-of-stock and first-check-in-stock are silent.
6. **Auto-pause (FR-3.6).** Emitted by the scheduler (WP-1.5) through the same alert record path so it appears in the alert log with delivery status like every other alert.
7. **Alert content (FR-3.7).** Every alert record persists: product, alert type, old value, new value, percentage change where applicable, timestamp, channel, delivery lifecycle. The record is self-sufficient — messages are renderable from the record alone (needed for the Milestone 2 alert log and Milestone 3 digest).
8. **Multi-condition checks.** One check may satisfy several rules (a drop that crosses target _and_ exceeds threshold _and_ changes offers): each fires as its own typed alert record; delivery-layer batching of simultaneous alerts for one product into one message is a presentation concern (WP-1.8), not an evaluation concern.

**Edge-case catalogue (each a named unit test):** first-ever check; previous check failed; previous stock unknown; price unchanged but MRP changed (silent unless offers changed); price rise (silent unless any-change on); target equal to current price at registration; threshold override of zero (disabled) vs. unset (inherit global); simultaneous target+threshold+offer conditions; alert evaluation after resume from pause (compares against last successful pre-pause check).

**Acceptance criteria:** 100% branch coverage on the evaluator; the full edge-case catalogue green; property-based test asserting evaluator determinism (same inputs → same outputs, no hidden state).

**Estimate:** 4 days. **Depends on:** WP-1.1 (snapshot shape); independent of live scraping (fully testable with synthetic snapshots).

---

### WP-1.8 — Telegram Delivery Channel

**Objective:** reliable, observable delivery of every alert to the configured Telegram chat (FR-4.1), with the outcome of every send recorded (FR-4.2), behind a channel abstraction that keeps FR-4.6 honest.

**Detailed functional scope:**

1. **Channel abstraction.** A notification-channel contract (send an alert, return a delivery result) with Telegram as the sole Phase 1 implementation; alert records carry the channel name so future channels coexist in one log.
2. **Message content specification — per alert type**, each including product name, marketplace, the direct listing link, and timestamp (FR-3.7), formatted for at-a-glance mobile reading:

| Alert type        | Message must convey                                                                  |
| ----------------- | ------------------------------------------------------------------------------------ |
| Target price      | Old price → new price, the target that was crossed, % below target                   |
| Threshold drop    | Old → new price, % drop, applicable threshold                                        |
| Any-change        | Old → new price, direction, % change                                                 |
| Offer change      | Offers added and offers removed, current price for context                           |
| Back in stock     | Now available, current price, how long it was out (from history)                     |
| Auto-paused       | Product, failure category in user phrasing, consecutive-failure count, how to resume |
| Test notification | Confirms configuration works; shows configured chat and app identity                 |

3. **Delivery pipeline.** Pending alert records are dispatched in order; sends respect Telegram rate limits with spacing and honour service back-pressure signals with waits; transient failures retried with backoff up to a bounded attempt count; terminal failures recorded as failed with the reason (invalid token, chat not found, blocked bot, service unavailable). Delivery status lifecycle: pending → delivered / failed (Milestone 3 adds held-for-quiet-hours).
4. **Simultaneous-alert grouping.** Multiple alerts arising from the _same check_ of the _same product_ are delivered as one combined message (evaluation records remain separate, per WP-1.7).
5. **Configuration validity behaviour.** Missing/invalid Telegram configuration puts deliveries into failed state with a distinct reason and raises a system-health condition (NFR-2) — alerts are never silently dropped; the test-notification path (FR-4.3) exists precisely to verify configuration and is exposed via bot command and API now, and the settings screen in Milestone 2.

**Acceptance criteria:** contract tests against a mock Telegram server covering success, each failure class, rate-limit back-off, and retry exhaustion; every send outcome visible on the alert record; combined-message grouping verified; live smoke test to the real configured chat.

**Estimate:** 3 days. **Depends on:** WP-1.7 (alert records).

---

### WP-1.9 — Telegram Bot: Milestone 1 Operator Interface

**Objective:** enough two-way bot capability that the milestone is genuinely operable and demonstrable through Telegram alone, establishing the interaction foundations that Milestone 3 completes (FR-4.4/4.5).

**Detailed functional scope:**

1. **Security model.** The bot responds only to the configured chat (allowlist); all other traffic is ignored and logged. Binding flow on first start specified.
2. **Command set (Milestone 1):**

| Command                   | Behaviour                                                                                                                                                                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| start                     | Greets, confirms binding, lists available commands                                                                                                                                                                                                         |
| add (with URL)            | Runs the full preview flow (WP-1.6): shows the parsed snapshot as a preview message with Confirm/Cancel buttons; Confirm registers and schedules; Cancel discards; duplicate and rejection messages identical in substance to the API's (FR-4.4 semantics) |
| list                      | Paginated catalogue: name, marketplace, current price, stock, status, last-checked relative time; page navigation buttons                                                                                                                                  |
| check (product reference) | Triggers an on-demand check of that product; replies with the outcome when done (FR-2.4)                                                                                                                                                                   |
| checkall                  | Triggers a paced on-demand run over the catalogue; replies with a completion summary                                                                                                                                                                       |
| status                    | System health snapshot: products tracked/active/paused, last cycle time and success counts, 7-day success rate, worker heartbeat freshness (UC-9 via Telegram)                                                                                             |
| test                      | Sends the test notification (FR-4.3)                                                                                                                                                                                                                       |
| help                      | Command reference                                                                                                                                                                                                                                          |

3. **Interaction conventions.** Product references by short index from the last list shown (with stable identifiers under the hood); confirmations for anything destructive; graceful, instructive handling of malformed commands and unknown input; long outputs paginated, never truncated silently.
4. **Registration parity rule.** Bot registration and API registration go through the identical service path — validation, duplicates, first-history-row, scheduling — so there is exactly one behaviour to test and maintain.

**Acceptance criteria:** scripted conversation tests for every command including pagination, confirm/cancel branches, duplicate and unsupported-URL replies, and allowlist rejection of a foreign chat; a live end-to-end demonstration: register → automatic checks → forced alert → auto-pause of a bad URL → status, all from a phone.

**Estimate:** 4 days. **Depends on:** WP-1.6, WP-1.8.

---

### WP-1.10 — Minimal Authenticated API Surface

**Objective:** the JSON API that operates the Milestone 1 system and — unchanged — powers the Milestone 2 dashboard.

**Detailed functional scope:**

1. **Authentication (functional level).** Login with the seeded account issuing an HTTP-only session; all other endpoints require it. (Hardening — rate limiting, CSRF, password change — is WP-2.1; the session design is final now so nothing reworks.)
2. **Capability inventory** (described functionally; all consumed by WP-1.9 and Milestone 2):
   - Preview a URL; register a product; fetch one product; list/search products with the FR-5.3 filter dimensions (marketplace, tag, stock, status, health) — built now because the bot's list command and the soak analysis need them.
   - Edit product fields; pause; resume; delete (two-step).
   - Trigger on-demand check (one/all); read a product's history (paginated, with failure detail); read the alert log (filterable) with delivery status.
   - Read and update settings (interval, thresholds, toggles, Telegram credentials, failure limit); send test notification.
   - Read system status (the WP-1.5 bookkeeping) — the future dashboard health banner reads exactly this.
3. **Contract discipline.** All request/response shapes defined in the shared package; OpenAPI document auto-published; validation errors follow one uniform, field-addressed format (the Milestone 2 forms will map them directly onto inputs).

**Acceptance criteria:** integration-test suite against a real database covering every capability, auth enforcement on every route, and the uniform error format; OpenAPI document reviewed and committed as the Milestone 2 frontend contract.

**Estimate:** 3 days. **Depends on:** WP-1.5–1.8 (runs concurrently as their surfaces stabilise).

---

### WP-1.11 — Milestone Hardening, Soak & Acceptance

**Objective:** prove the milestone against the BRD's measurable success criteria under real conditions, and tune the politeness/escalation realities discovered.

**Detailed functional scope:**

1. **72-hour soak** on staging with 100+ real products from the client's sample list (D-5), mixed across both marketplaces, at the default interval. Measured: check success rate (target ≥ 95%, Success Criterion 1); alert latency within one cycle (NFR-3); memory/CPU envelope (ER-8 headroom); failure-category distribution per marketplace.
2. **Tuning pass** from soak evidence: pacing gaps, concurrency caps, escalation thresholds, header profiles; documented before/after rates.
3. **Contingency decision point (plan §10).** If a marketplace's tier-1 success rate is structurally poor, flip that marketplace to browser-primary and re-soak; if IP-level blocking persists, invoke the R-2 conversation with the client (proxy / commercial data provider as a chargeable change) — with data.
4. **Simulation harness delivery (§8.1).** The scriptable mock marketplace adapter (drivable price/offer/stock sequences) plus prepared scenario scripts for each alert type — the tool that makes BRD acceptance item 4's "controlled simulation" and all future regression demos possible on demand.
5. **Milestone acceptance dry run** of BRD §14 items 1 (via bot/API), 3, 4, 5, and 8; results recorded; client demo session conducted per BRD §13.

**Acceptance criteria:** soak report showing ≥ 95% success over 72 h; every alert type demonstrated live or via simulation; auto-pause demonstrated with a deliberately invalid URL (BRD item 5); demo accepted by client.

**Estimate:** 5 days spread across the final two weeks (soak runs unattended). **Depends on:** all prior WPs.

---

## 4. Milestone-Level Testing Plan

| Layer              | Coverage in this milestone                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit               | Alert engine (full edge-case catalogue, 100% branch); URL canonicalisation; offer normalization/hash stability; snapshot validation; failure categorisation                               |
| Fixture regression | ≥ 30 marketplace pages (15 per adapter) exercised in CI on every change; zero live marketplace calls in CI                                                                                |
| Integration        | Registration lifecycle; scheduler with fake clock (interval change, auto-pause, recovery); pipeline fault injection; Telegram against mock server; full API surface against real database |
| Conversation       | Scripted bot flows including security rejection                                                                                                                                           |
| Soak               | 72-hour live run per WP-1.11 with quantified criteria                                                                                                                                     |

---

## 5. Deliverables Checklist

- [ ] Adapter framework + Amazon India + Flipkart adapters with fixture suites in CI.
- [ ] Scrape pipeline with politeness layer and failure taxonomy.
- [ ] Scheduler with live interval change, on-demand checks, auto-pause, recovery, health bookkeeping.
- [ ] Registration/management service with preview, duplicates, delete-with-confirmation.
- [ ] Alert engine with full rule set and edge-case catalogue.
- [ ] Telegram delivery channel with per-type message templates and delivery records.
- [ ] Telegram bot with the Milestone 1 command set.
- [ ] Authenticated API surface + published OpenAPI contract.
- [ ] Simulation harness and scenario scripts.
- [ ] Soak report, tuning notes, and accepted client demo.

---

## 6. Exit Criteria

1. All work-package acceptance criteria pass; CI fully green including fixture suites.
2. Soak: ≥ 95% scheduled-check success over 72 hours at 100+ real products (Success Criterion 1); qualifying changes alerted within one cycle (NFR-3, Success Criterion 2).
3. BRD acceptance items 1, 3, 4, 5, 8 demonstrated to and accepted by the client (via Telegram/API, per BRD §13 milestone gating).
4. No known defect that loses history data, sends a wrong alert, or fails silently (Success Criterion 5).

---

## 7. Milestone-Specific Risks

| Risk                                              | Handling in this milestone                                                                                                |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Marketplace anti-bot pressure worse than expected | Earliest possible live contact (weeks 2–4); browser-primary contingency lever; R-2 escalation with soak data              |
| Alert-rule subtleties produce wrong/missed alerts | Pure-function engine, named edge-case catalogue, simulation harness demos before client acceptance                        |
| Telegram limits under alert bursts                | Grouping per check, paced dispatch, back-pressure handling — tested against mock server before live                       |
| Soak reveals capacity issues on 4 GB VPS          | Browser pool caps + tier telemetry identify the pressure source; interval and concurrency are tunable without code change |

---

_— End of Milestone 1 Implementation Document —_
