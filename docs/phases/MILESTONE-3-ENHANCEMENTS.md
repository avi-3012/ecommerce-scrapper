# PricePulse — Milestone 3 Implementation Document: Experience Enhancements

|                        |                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document Version**   | 1.0                                                                                                                                                                                                                                      |
| **Date**               | 10 July 2026                                                                                                                                                                                                                             |
| **Parent Documents**   | BRD-PricePulse.md v1.0; IMPLEMENTATION-PLAN.md v1.1                                                                                                                                                                                      |
| **Milestone Duration** | 3–4 weeks (+ 1 week final acceptance & handover)                                                                                                                                                                                         |
| **BRD Definition**     | Should-have items: two-way Telegram commands, deal-quality context, cross-platform comparison, alert hygiene (cooldown / quiet hours / digest), export, live dashboard updates — "polished product matching mature tracker expectations" |
| **Milestone Outcome**  | Full Phase 1 scope (Must + Should) in daily unattended use; alert fatigue engineered away (R-4); project handed over with runbooks, credentials, and maintenance-agreement scope confirmed.                                              |

---

## 1. Purpose and Position of This Milestone

Milestones 1 and 2 delivered a complete, correct tracker. Milestone 3 makes it _pleasant to live with_: the difference between a tool that alerts and a tool the user trusts after three months of real use. Its unifying themes are **signal quality** (hygiene features against alert fatigue — BRD Risk R-4), **judgment support** (deal-quality context and cross-platform comparison — UC-3, UC-4, UC-8), and **frictionlessness** (full bot control, live dashboard, export).

**Budget note (binding):** every work package in this milestone is Should-have priority and independently deliverable. They are sequenced below by value, so the milestone can be cut short at any package boundary against remaining budget (per BRD §7's "if budget permits") without stranded work. WP-3.7 (hardening & handover) is the only non-optional package and executes regardless of which features precede it.

### Entry Criteria

- Milestone 2 exit criteria met and signed off; production in daily use; the Milestone 2 browser end-to-end pack green (it is this milestone's regression floor).

---

## 2. Scope Summary

### 2.1 In Scope

- FR-3.8 cooldown, FR-3.9 quiet hours, FR-3.10 digest.
- FR-4.4 / FR-4.5 complete two-way Telegram management.
- FR-5.5 deal-quality context; FR-1.8 + FR-5.6 cross-platform linking and comparison.
- FR-6.3 export; FR-5.8 live dashboard updates.
- Final regression, alert-fatigue scenario validation, documentation completion, and project handover.

### 2.2 Out of Scope

- Everything BRD-designated Phase 2 (new marketplaces, name search, new channels, multi-user, sale-event fast-checking, trend prediction). Where this milestone touches an area with a Phase 2 seam (e.g. digest rendering vs. future channels), the seam is respected but not built.

---

## 3. Work Packages (in delivery order)

### WP-3.1 — Alert Hygiene: Cooldown, Quiet Hours & Digest

_Sequenced first: it protects the user's trust in every other feature (R-4)._

**Objective:** the user receives every alert that matters and is never spammed — with precisely specified interactions between the three mechanisms and the Milestone 1 alert semantics.

**Detailed functional scope:**

1. **Cooldown (FR-3.8).**
   - Rule: after an alert of a given type fires for a given product, further alerts of the _same type for the same product_ are suppressed for the configured window (global setting; sensible default; zero disables the mechanism).
   - Suppressed alerts are still evaluated and **still recorded** (marked suppressed-by-cooldown, visible in the alert log with the suppressing window shown) — history and audit are never sacrificed for hygiene; only delivery is withheld.
   - Type-specific exemptions specified: auto-pause and back-in-stock alerts are exempt (each firing is inherently meaningful); target-price alerts are naturally rate-limited by crossing semantics and interact with cooldown as specified in the interaction table below.
2. **Quiet hours (FR-3.9).**
   - A daily window (start/end in the user's timezone, spanning midnight correctly) during which alert delivery is **held**, not discarded: alerts enter a held state (the delivery-status lifecycle slot reserved in Milestone 1).
   - At window end, held alerts are delivered as **one consolidated summary message**, grouped by product, ordered by significance (target crossings first, then largest drops), with each item carrying its essential FR-3.7 content and listing link; if nothing was held, nothing is sent.
   - Exemption rule specified and user-visible: monitoring-health alerts (auto-pause, system health) are delivered immediately even during quiet hours by default, with a setting to hold them too — the NFR-2 trade-off made explicit and user-owned.
3. **Digest (FR-3.10).**
   - Frequency: daily (configurable send time) or weekly (configurable day + time), or off.
   - Content: catalogue-wide movement summary since the previous digest — products dropped / risen (with old → new and percentage), offer changes, stock transitions, products newly at or near all-time low (once WP-3.3 lands, the digest consumes it), auto-paused products needing attention, and a one-line system-health statement; empty periods produce a brief "no changes" digest (configurable to skip instead).
   - The digest is a _summary_, not an alert replacement: it never suppresses real-time alerts, and its content is computed from recorded history and alert records — introducing no new evaluation logic.
4. **Interaction semantics (the correctness heart of this package)** — a specified decision table, exhaustively unit-tested, covering at minimum: alert inside quiet hours _and_ inside a cooldown window (suppressed by cooldown; does not appear in the quiet-hours summary); crossing-latch re-arm during quiet hours (latch behaviour unchanged — hygiene never alters evaluation, only delivery); cooldown window expiring during quiet hours; quiet-hours summary itself failing to deliver (subject to the standard retry path and visible in the log); settings changed while alerts are held (held alerts honour the rules in force when they were held).
5. **Settings UI:** the reserved hygiene block in Settings (WP-2.8) filled in — cooldown duration, quiet-hours window with timezone display, health-alert exemption toggle, digest frequency/time — each with a one-line consequence description; the alert log gains filters for suppressed and held states.

**Acceptance criteria:** decision-table tests green with full branch coverage; a scripted high-churn scenario (simulation harness: a product whose price and offers oscillate rapidly across quiet hours) yields exactly the specified deliveries and log states; digest content verified item-by-item against seeded history; the BRD alert-fatigue scenario (WP-3.7) depends on this package passing.

**Estimate:** 5 days.

---

### WP-3.2 — Full Two-Way Telegram Bot

**Objective:** complete FR-4.4/FR-4.5 — the catalogue fully manageable from a phone with no browser, building on the Milestone 1 command foundation.

**Detailed functional scope:**

1. **Management commands completing FR-4.5:** pause and resume by product reference; set / change / clear target price (validation and crossing-re-arm explanation parity with the dashboard edit path); remove a product (two-step with explicit history-loss confirmation, parity with FR-1.6); search the catalogue by text (returns the same referencing scheme as list).
2. **Interactive affordances:** list results carry per-product inline action buttons (check now, pause/resume, set target) so common actions are one tap, not typed commands; multi-page navigation retained; every action replies with a confirmation of what changed.
3. **Registration flow polish (FR-4.4):** the Milestone 1 add-with-preview flow gains the optional configuration step (set target price and tags at registration time via a short guided exchange, skippable); duplicate flow offers open-in-dashboard and resume actions inline.
4. **Conversational robustness:** unknown commands answered with contextual help; partially valid input (e.g. a target-price command with a malformed number) answered with the precise fix; every command usable via both typed form and button affordances; command reference in help regenerated to the final set.
5. **Parity rule (binding, carried from Milestone 1):** every bot action executes the same service path as its dashboard equivalent — one behaviour, one validation, one audit trail; the settings-change journal (WP-2.8) records bot-originated changes identically, attributed to the Telegram channel.
6. **Security posture re-verified:** allowlist enforcement re-audited across all new commands and callback buttons (buttons are inputs too).

**Acceptance criteria:** scripted conversation tests for every command, button path, confirmation branch, and malformed input; parity spot-checks (same action via bot and dashboard produces identical records); live phone-only demonstration: register, set target, pause, resume, remove — no browser touched.

**Estimate:** 4 days.

---

### WP-3.3 — Deal-Quality Context

**Objective:** FR-5.5 / UC-3 / UC-8 — the recorded history turned into judgment: is _this_ price actually good?

**Detailed functional scope:**

1. **Per-product statistics:** all-time lowest, average, and highest recorded price — maintained **incrementally** on each successful check (never recomputed by scanning history at read time; NFR-5 discipline), with a one-off backfill computed from existing history at rollout; definition rules specified (successful checks only; the average is time-weighted rather than check-weighted so irregular check density doesn't skew it; behaviour when history is short is honest — "based on N days of tracking").
2. **"At/near low" designation:** a product whose current price is within a configurable percentage (global setting, sensible default) of its all-time low carries a prominent badge — on catalogue cards, product detail, and in alert messages ("this is the lowest price PricePulse has ever recorded for this product" or "within X% of its recorded low"). The claim is always phrased as _recorded_ low — the system never overstates what it knows.
3. **Chart enrichment:** the reserved low/average/high reference bands added to the price chart; the all-time-low point marked; the statistics displayed alongside the chart with their basis period.
4. **Alert enrichment:** target-price and threshold-drop alert messages gain the deal-quality line where applicable; the digest's "at or near low" section (WP-3.1) activates.
5. **Filter/sort integration:** catalogue gains an "at/near recorded low" filter and a "closest to recorded low" sort — turning UC-3 from per-product inspection into a catalogue-wide shopping view.

**Acceptance criteria:** statistics verified against hand-computed values over seeded histories (including irregular check density, failure gaps, and out-of-stock spans); badge thresholds behave at boundaries; backfill verified on a copy of production data; incremental maintenance verified to never drift from a full recomputation (property test comparing the two over randomized histories).

**Estimate:** 3 days.

---

### WP-3.4 — Cross-Platform Linking & Comparison

**Objective:** FR-1.8 / FR-5.6 / UC-4 — the same product watched on both marketplaces, compared in one view.

**Detailed functional scope:**

1. **Linking model:** the user links exactly two tracked products — one Amazon India, one Flipkart — as "the same product". Linking is explicit and user-driven (no automatic matching in Phase 1); validation prevents linking two products from the same marketplace, linking an already-linked product (a product belongs to at most one pair), or self-linking. Unlinking is always available; deleting one side severs the link (rule pre-specified in Milestone 1, now exercised).
2. **Linking UX:** from a product's detail page — "link to its listing on the other marketplace" — offering a picker over existing tracked products of the other marketplace (searchable) or a paste-URL path that runs the standard registration preview and registers-then-links in one flow.
3. **Comparison view (FR-5.6):** for a linked pair — side-by-side current state (price, MRP, discount, offers, stock, last-checked) with the currently-cheaper side clearly indicated and the difference in rupees and percent; **both price histories on a single chart** (two series, marketplace-coloured per the design-system tokens, shared time axis, the standard window selector) with per-series inspection; "cheaper now" vs. "cheaper historically" summarised (which side has been cheaper for what share of the overlapping tracked period, and by how much on average) — UC-4's two questions answered literally.
4. **Catalogue integration:** linked products carry a pair badge; an optional grouped display mode shows pairs as single rows with both prices; filters treat each side as an individual product (monitoring semantics are entirely unchanged by linking — a link is presentation, not behaviour).
5. **Alert independence preserved:** each side keeps its own targets, thresholds, and alerts; alert messages for a linked product append the other side's current price as context (one line, no new alert types).

**Acceptance criteria:** all linking validation rules enforced; both linking paths (pick existing, register-and-link) work end-to-end; comparison chart verified over seeded divergent histories including one side out-of-stock; cheaper-now/cheaper-historically computations verified against hand-worked examples; deletion severs correctly; monitoring behaviour provably unchanged by linking (regression on a linked pair).

**Estimate:** 4 days.

---

### WP-3.5 — Data Export

**Objective:** FR-6.3 — the user's data is theirs, in spreadsheet form, at any scale the system holds.

**Detailed functional scope:**

1. **Export scopes:** the tracked-product list (all current-state fields, configuration, tags, notes, statistics from WP-3.3); full price history (whole catalogue or a single product, with an optional date range); the alert log (with delivery outcomes). Each scope selectable from the relevant screen (Settings hosts the master export section; product detail offers that product's history directly).
2. **Formats:** Excel and CSV; column sets documented and versioned; the products export is **round-trip compatible** with the bulk-import template (WP-2.9) — export, edit offline, re-import is an intended workflow and is tested as one.
3. **Scale behaviour (NFR-4/NFR-5):** exports stream server-side — a multi-year, million-row history export completes without exhausting memory or timing out; large exports run as background jobs with progress indication and a retrievable download (same pattern as import), while small exports download immediately; size estimates shown before starting a large export.
4. **Fidelity rules:** timestamps exported in the user's timezone with the zone stated in the file; prices as numbers (not formatted text); offers rendered both as a human-readable summary column and a structured column; failed checks included in history exports with their reason (the export is as honest as the UI).
5. **Access control:** exports require an authenticated session like everything else; export events recorded in the audit journal.

**Acceptance criteria:** each scope/format verified for content fidelity against ground truth; the million-row streaming case completes within recorded resource bounds; product-list export re-imports cleanly (round-trip test); background-export progress and retrieval verified.

**Estimate:** 3 days.

---

### WP-3.6 — Live Dashboard Updates

**Objective:** FR-5.8 — the dashboard reflects reality without the user refreshing; the Milestone 2 polling stopgap retired.

**Detailed functional scope:**

1. **Event channel:** a server-sent-events stream from the API, fed by worker-side notifications (the LISTEN/NOTIFY path provisioned in the architecture), authenticated like any route; automatic reconnection with backoff, and a full data refetch on reconnect so missed events can never leave the UI stale (correctness never depends on event delivery).
2. **Event vocabulary (specified, versioned in the shared package):** check completed for a product (with the new current-state summary); alert fired; alert delivery-status changed; system-status/heartbeat updated; import progress (upgrading WP-2.9's progress from polling); auto-pause occurred.
3. **UI integration:** catalogue cards and open product-detail views patch in place (price, change indicator, last-checked, stock) with a brief visual acknowledgment on change; a subtle "checking now" indicator while a product's check is in flight; Dashboard statistics, activity feed, and the health banner update live (the red stalled state now also arises from the _stream itself_ going quiet past a threshold — an additional NFR-2 signal); the alert log gains new rows live when open.
4. **Restraint rules:** updates never yank the user's context (no scroll jumps, no reordering under the pointer mid-interaction; re-sorting waits for an idle moment or offers a "new data — refresh view" affordance when the current sort is affected); update bursts (e.g. an on-demand check-all) are coalesced client-side so the UI stays calm.
5. **Fallback:** environments where the stream cannot hold (aggressive proxies) degrade automatically to the Milestone 2 polling behaviour — feature-detected, logged, invisible to the user.

**Acceptance criteria:** each event type observed live end-to-end (worker action → browser update) with latency recorded (target: visible within a few seconds of the check); reconnect-with-refetch verified by killing the stream mid-session; restraint rules verified during a forced check-all burst over the 500-product dataset; fallback mode verified by blocking the stream.

**Estimate:** 4 days.

---

### WP-3.7 — Final Hardening, Regression & Project Handover _(non-optional)_

**Objective:** prove the complete Phase 1 product end-to-end, validate the R-4 alert-fatigue posture, and hand the system over in a state a successor maintainer could pick up cold.

**Detailed functional scope:**

1. **Full regression:** the Milestone 2 browser end-to-end pack (all nine BRD criteria) re-run green on production topology with all Milestone 3 features enabled; the Milestone 1 soak repeated for 72 hours at the client's real full catalogue with hygiene features active, re-verifying the ≥ 95% success criterion and one-cycle alert latency under the final configuration.
2. **Alert-fatigue scenario validation (R-4, BRD-referenced):** the scripted high-churn scenario — a volatile product across quiet hours with cooldown and digest configured — executed on staging via the simulation harness with the client's chosen settings; delivered messages compared line-by-line against the WP-3.1 specification; the client reviews the actual message stream and confirms it matches how they want to be spoken to (the subjective half of R-4, tested with the only judge who counts).
3. **Should-have acceptance session:** joint client demonstration of each Milestone 3 feature against its FR (bot management phone-only; hygiene behaviours; deal-quality badges and chart bands; a linked pair's comparison view; export round-trip; live updates side-by-side with a check firing) — recorded item-by-item as in Milestone 2.
4. **Documentation completion:** user guide extended to every Milestone 3 feature; operations runbook finalised (deploy, upgrade, backup/restore, secret rotation, **the marketplace-breakage repair procedure** — capture failing page, add fixture, repair extraction, fixtures green, deploy — per §8.6 of the plan); developer documentation finalised (architecture overview, adapter-authoring guide as the NFR-8 extension path, ADR set complete including all deviations accumulated during the build).
5. **Handover package:** credentials inventory transferred (VPS, registry, bot, backup storage, application account) with rotation performed at handover; monitoring/alerting posture documented (what pings whom when things break, including the external liveness check); open-items register (any accepted-as-is quirks, deferred niceties); Phase 2 seams walked through against implementation-plan §14 so future scoping starts warm.
6. **Maintenance-agreement grounding (BRD §16):** the recommended monthly agreement's concrete scope confirmed against reality — what "repair of data-collection breakages" means operationally (the fixture-repair procedure and its typical turnaround, informed by any breakages actually experienced during the build), backup verification cadence, health-review cadence — so the client signs an agreement describing real, rehearsed activities.

**Acceptance criteria:** regression and soak green with reports; fatigue scenario accepted by the client; all Should-have demonstrations accepted; documentation reviewed; handover checklist countersigned; Phase 1 closure recorded per BRD §13/§14.

**Estimate:** 5 days (+ joint sessions).

---

## 4. Milestone-Level Testing Plan

| Layer        | Coverage in this milestone                                                                                                                                                         |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit         | Hygiene decision table (full branch); deal-statistics incremental-vs-recompute property tests; linking validation matrix; event-vocabulary contract tests                          |
| Integration  | Held/suppressed delivery lifecycles against the mock Telegram server; digest assembly from seeded history; streaming export over million-row data; SSE fan-out from worker actions |
| Conversation | Full bot command/button/confirmation matrix including security re-audit                                                                                                            |
| End-to-end   | Milestone 2 pack (regression floor) + new flows: link-and-compare, export round-trip, live-update observation, phone-only management                                               |
| Scenario     | High-churn alert-fatigue script (the R-4 proof); final 72-hour production-configuration soak                                                                                       |

---

## 5. Deliverables Checklist

- [ ] Cooldown, quiet hours, and digest with specified interaction semantics, settings UI, and log visibility.
- [ ] Complete two-way Telegram management with inline actions and dashboard parity.
- [ ] Deal-quality statistics, badges, chart bands, alert/digest enrichment, catalogue filter/sort.
- [ ] Cross-platform linking with comparison view and dual-series chart.
- [ ] Streamed exports (products / history / alerts; Excel + CSV) with import round-trip.
- [ ] Live dashboard updates with reconnect-refetch, restraint rules, and polling fallback.
- [ ] Full regression + final soak reports; alert-fatigue scenario accepted.
- [ ] Completed user guide, runbooks, developer docs, ADRs.
- [ ] Handover package with credential rotation; maintenance-agreement scope confirmed.

---

## 6. Exit Criteria

1. All delivered work-package acceptance criteria pass; any budget-dropped packages are explicitly recorded as descoped with client agreement (never silently absent).
2. Milestone 2 regression pack and final 72-hour soak green under full Phase 1 configuration.
3. All Should-have demonstrations accepted by the client; alert-fatigue scenario approved.
4. Handover complete: documentation, credentials, runbooks, maintenance scope — Phase 1 formally closed per BRD §13; Phase 2 items remain governed by BRD §15 change control.

---

## 7. Milestone-Specific Risks

| Risk                                                                   | Handling in this milestone                                                                                                                                             |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hygiene-feature interactions create missed alerts (worse than fatigue) | Decision-table specification before implementation; suppression never touches evaluation or records; the log shows every suppressed/held alert so nothing is invisible |
| Live updates introduce UI instability                                  | Restraint rules are specified requirements, not polish; correctness never depends on the stream (refetch-on-reconnect); polling fallback retained                      |
| Budget pressure truncates the milestone                                | Value-ordered packages, each independently shippable; WP-3.7 handover executes regardless, sized to whatever shipped                                                   |
| Long-running features (digest, quiet hours) hide timezone defects      | All schedule computation in the user's timezone with explicit midnight-spanning tests; final soak runs across real quiet-hours boundaries                              |

---

_— End of Milestone 3 Implementation Document —_
