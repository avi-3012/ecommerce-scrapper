# PricePulse — Milestone 2 Implementation Document: Dashboard & Administration

|                        |                                                                                                                                                                                                                                         |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document Version**   | 1.0                                                                                                                                                                                                                                     |
| **Date**               | 10 July 2026                                                                                                                                                                                                                            |
| **Parent Documents**   | BRD-PricePulse.md v1.0; IMPLEMENTATION-PLAN.md v1.1                                                                                                                                                                                     |
| **Milestone Duration** | 4–5 weeks (+ up to 1 week acceptance review)                                                                                                                                                                                            |
| **BRD Definition**     | "Complete Phase 1 application, ready for daily use" — full dashboard, charts, alert log, settings, bulk import, login                                                                                                                   |
| **Milestone Outcome**  | A non-technical user operates every routine function — register, review, configure, import — through a browser (desktop or mobile) with no assistance (NFR-6); all nine BRD Phase 1 acceptance criteria pass in a joint client session. |

---

## 1. Purpose and Position of This Milestone

Milestone 1 built the engine; Milestone 2 builds the cockpit. Because the Milestone 1 API surface (WP-1.10) was designed as the dashboard's contract, this milestone is deliberately frontend-dominant and low-risk on the backend: the only new server-side capabilities are authentication hardening, bulk import, and production/backup operations. The design bar throughout is the BRD's persona — a non-technical "Catalogue Watcher" who must _never_ need logs or configuration files to know the system is working (UC-9, NFR-2, NFR-6).

**Design conventions applying to every screen (stated once here, binding everywhere):**

- Responsive from 360-px phones to desktop (FR-5.9): sidebar navigation collapses to bottom navigation on small screens; tables become stacked cards; charts remain legible and touch-operable.
- Every data view has designed loading, empty, and error states; empty states teach the next action ("Track your first product — paste a listing URL").
- All times displayed in the user's timezone (IST default) as relative time with exact timestamp on demand; all prices in rupees with Indian digit grouping.
- Destructive actions always take a confirmation step that states consequences.
- Server validation errors map onto the specific form field they concern (the uniform error contract from WP-1.10).
- Basic accessibility floor: keyboard operability, focus states, labelled controls, WCAG-AA contrast, chart data available as a table alternative.

---

## 2. Scope Summary

### 2.1 In Scope (requirements delivered)

- FR-6.4 login and session protection; NFR-7 hardening.
- FR-5.1, FR-5.2, FR-5.3, FR-5.4, FR-5.7, FR-5.9 (dashboard home, catalogue, search/filters, price chart, alert log, mobile usability).
- FR-1.1 – FR-1.6 browser UI (registration with preview, editing, pause/resume, delete).
- FR-6.1, FR-6.2 settings screens with immediate effect; FR-4.3 test-notification button.
- FR-1.7 bulk import (UC-7).
- NFR-9 backup automation + documented, rehearsed restore; production environment bring-up.
- NFR-6 validated by an unassisted client walkthrough of all nine BRD §14 acceptance criteria.

### 2.2 Out of Scope (this milestone)

- Deal-quality context, comparison view, export, live (refresh-free) updates, cooldown/quiet-hours/digest, extended bot commands — all Milestone 3. Where a Milestone 3 feature will later occupy screen space (e.g. all-time-low badge, live indicator), the layout reserves it now so Milestone 3 adds without redesign.

### 2.3 Entry Criteria

- Milestone 1 exit criteria met and client-accepted; OpenAPI contract stable; sample spreadsheet (dependency D-6) in hand for import design.

---

## 3. Work Packages

### WP-2.1 — Authentication & Session Hardening

**Objective:** the application and its data are inaccessible without authentication (FR-6.4, NFR-7), to a standard appropriate for an internet-facing personal application.

**Detailed functional scope:**

1. **Login screen:** email + password; clear failure messaging that does not disclose which factor was wrong; link-free (single account — no self-service signup, per BRD constraint 4).
2. **Session behaviour:** HTTP-only, secure, same-site session cookie; sliding expiry with an absolute maximum lifetime; logout invalidates server-side; session survives page reloads; expired sessions land on login with a friendly "signed out" notice and return-to-where-you-were after re-login.
3. **Brute-force protection:** rate limiting and progressive lockout on the login route by account and source; lockout state communicated honestly to the user with wait time.
4. **Cross-site request protection** on all mutating operations; security headers (content-security policy, frame denial, referrer policy) served on all responses.
5. **Password management:** password change from settings requiring the current password; strong-password guidance; argon2 hashing parameters documented. Password reset is deliberately operational in Phase 1 (single known user): a documented console procedure in the runbook, surfaced in the login screen's help text ("contact your administrator").
6. **Route protection audit:** every API capability and every SPA route verified to require authentication; the OpenAPI document annotated accordingly; an automated test walks the entire route table unauthenticated and asserts uniform denial.

**Acceptance criteria:** unauthenticated access to any route or API capability is denied; lockout engages and releases as specified; session lifecycle behaviours all demonstrated; security-header presence asserted by automated test.

**Estimate:** 3 days.

---

### WP-2.2 — Frontend Application Shell

**Objective:** the structural frame every screen mounts into — navigation, layout, data-fetching discipline, and the design system — such that subsequent work packages are purely compositional.

**Detailed functional scope:**

1. **Navigation architecture:** five primary destinations — Dashboard, Products, Alerts, Settings, and product detail as a sub-route of Products. Desktop: persistent sidebar with health indicator; mobile: bottom navigation bar with the same destinations; current-location affordance; browser back/forward behave correctly throughout.
2. **Design system:** typographic scale, spacing, colour tokens (including semantic colours for price-drop/rise, stock states, health states — used identically across cards, charts, and badges), form controls, buttons, badges, modals, toasts, skeleton loaders, empty-state and error-state components — all built once, documented in a living style reference page.
3. **Data-layer discipline:** server state via query caching with sensible staleness windows per data class (catalogue vs. settings vs. system status); optimistic updates for pause/resume and edits with rollback on failure; a single API client generated/typed from the shared contract package; global handling for session expiry (redirect to login) and for offline/unreachable states (persistent banner, automatic retry).
4. **Application chrome:** page titles per route; toast conventions (success quiet, failure explicit with retry where meaningful); confirmation-modal convention; keyboard shortcuts deferred (recorded as a possible Milestone 3 nicety, not scoped).
5. **Health surfacing in the chrome:** the shell polls system status at a modest fixed period (Milestone 3 replaces polling with live events) and drives both the sidebar health dot and the Dashboard banner (WP-2.3) from one shared source.

**Acceptance criteria:** navigation and layout verified at 360 px, 768 px, and desktop widths; style reference page complete; session-expiry and offline behaviours demonstrated; all shared components have component tests.

**Estimate:** 4 days.

---

### WP-2.3 — Dashboard Home

**Objective:** UC-9 made literal — one glance answers "is everything okay, and did anything happen?"

**Detailed functional scope:**

1. **Health banner (the centrepiece, NFR-2).** Three states with plain-language content:
   - **Green / all well:** "Monitoring is running normally" with last-cycle time and success count.
   - **Amber / attention:** some products failing or auto-paused — names the count, links to a pre-filtered catalogue view of affected products, explains in user phrasing (failure taxonomy from WP-1.4) what is wrong and what, if anything, the user should do.
   - **Red / stalled:** worker heartbeat stale or last cycle far overdue — states plainly that monitoring is not running, since when, and that the maintainer may be needed (the honest state; still no logs required to _know_).
2. **Statistic cards (FR-5.1):** products tracked (with active/paused split); alerts fired in the last 24 h; price drops observed in the last 24 h; time of last completed monitoring run. Each card links to the corresponding filtered view.
3. **Recent activity feed:** the most recent price drops and alerts (product, change, time), newest first, capped, with a link to the full alert log; designed to make the daily "what happened overnight?" glance sufficient on this one screen.
4. **First-run experience:** with an empty catalogue the dashboard becomes an onboarding surface — a prominent register-a-product invitation and a bulk-import pointer.

**Acceptance criteria:** all three banner states demonstrated (green live; amber and red via simulation harness/heartbeat manipulation); every statistic verified against database ground truth; links land on correctly-filtered views; mobile layout verified.

**Estimate:** 3 days.

---

### WP-2.4 — Catalogue View

**Objective:** the working surface for a 5-to-500-product catalogue (FR-5.2, FR-5.3, NFR-5): find any product in seconds, read its state at a glance, act on it in place.

**Detailed functional scope:**

1. **Product card/row content (FR-5.2):** image thumbnail; display name; marketplace badge; current selling price; MRP struck through with discount percentage; change-since-previous-check indicator (direction arrow, amount, percentage, colour-coded); stock badge; current offers summarised (count with expandable detail); last-checked relative time; status treatment for paused (dimmed, labelled by whom — user vs. automatic — with reason for automatic).
2. **Search (FR-5.3):** free-text across display name and URL, debounced, server-side, usable at 500+ products.
3. **Filters (FR-5.3), combinable:** marketplace; category tag (multi-select from the user's tag vocabulary); price-drop status (dropped today / dropped this week); stock status; monitoring health (healthy / failing / auto-paused / user-paused). Active filters shown as removable chips; filter state encoded in the URL so filtered views are linkable (the Dashboard's banner and cards link here).
4. **Sorting:** biggest drop since last check; most recently changed; most recently checked; name; price (both directions); date added.
5. **In-place actions per product:** check now (with transient checking indicator and outcome toast); pause/resume; edit (opens detail); delete (two-step confirmation stating history/alert loss, per FR-1.6). Bulk selection with bulk pause/resume/delete (same confirmation discipline) — a small extension included because catalogue-scale users (UC-7 persona) will immediately want it.
6. **Scale behaviour (NFR-5):** server-side pagination with virtualised rendering; the full filter/sort/search grammar honoured server-side; interaction remains fluid at 500+ products on a mid-range phone.
7. **Empty and edge states:** empty catalogue (onboarding pointer); filter combination with no matches (clear-filters affordance); products never yet successfully checked (explicit "awaiting first check" treatment rather than misleading zeros).

**Acceptance criteria:** every card field verified against ground truth; all filters/sorts verified singly and in combination against a seeded 500-product dataset; URL-encoded filter state round-trips; in-place and bulk actions behave with correct confirmations; smooth scroll/interaction on a mid-range mobile device over the 500-product set.

**Estimate:** 5 days.

---

### WP-2.5 — Product Registration UI

**Objective:** the FR-1.1–1.5 flow as a browser experience matching the BRD's under-one-minute criterion.

**Detailed functional scope:**

1. **Entry points:** primary action on Dashboard and Catalogue; accepts a pasted URL; tolerant of surrounding whitespace/text (extracts the URL).
2. **Preview step (FR-1.3):** on submit, a preview card renders the live-fetched snapshot — image, name, marketplace, selling price, MRP and discount, offers list, stock status — with an explicit "is this the right product?" framing (the R-5 safeguard). While fetching: progress state with the realistic expectation set ("checking the listing — usually under 15 seconds"). Failure of the live fetch: categorised, user-phrased explanation with retry.
3. **Rejection handling:** unsupported site (FR-1.2) and non-listing page messages rendered inline at the URL field, naming the supported marketplaces; duplicate (FR-1.5) rendered as "already tracking this product" with a link to the existing product and, if paused, an offer to resume.
4. **Configuration step (FR-1.4):** display name (pre-filled, editable); target price (optional; validated positive; a target at/above the current price triggers an informational note explaining crossing behaviour — allowed, since the user may expect a rise first); drop-threshold override (optional; explains inheritance from the global default when blank); notes; tags (create-or-pick from existing vocabulary).
5. **Completion:** save lands on the new product's detail page with its first history point already present (from the preview snapshot) and a success toast confirming monitoring has begun — closing the loop on Success Criterion 3.

**Acceptance criteria:** happy path from paste to detail page in under one minute against live marketplaces; every rejection and failure branch renders its specified message at the specified location; validation rules verified; mobile flow verified end-to-end.

**Estimate:** 3 days.

---

### WP-2.6 — Product Detail & Price History Chart

**Objective:** the evidence surface for UC-3 and UC-8 (FR-5.4): what has this product's price actually done, with zero unexplained gaps (Success Criterion 4).

**Detailed functional scope:**

1. **Header block:** everything from the catalogue card, expanded — full name linking to the live listing (opens marketplace in new tab); status controls (pause/resume, check now, edit, delete) in place.
2. **Price history chart (FR-5.4):**
   - Selling price over time as the primary series; MRP as a reference line; target price (when set) as a labelled horizontal line.
   - Time-window selector: 7 / 30 / 90 days / all time; default 30.
   - Out-of-stock periods visually shaded on the timeline; failed-check periods marked distinctly (so a gap is always _explained_ — the Success Criterion 4 rule made visible).
   - Tap/hover inspection: exact price, offers summary, and stock at that check, with timestamp.
   - Long ranges served pre-downsampled by the API (daily min/max/close beyond a density threshold) with the downsampling honestly disclosed in the UI; raw checks always available in the table below.
   - Layout reserves the Milestone 3 low/average/high reference bands (FR-5.5) so they add without redesign.
3. **Check history table (FR-2.3 made visible):** paginated, newest first: timestamp, outcome, price, MRP, discount, offers summary, stock, and for failures the user-phrased reason; filterable to failures only — this is also the maintainer's first diagnostic view (§8.2 of the plan) without needing logs.
4. **Product alert history:** all alerts for this product with type, values, time, delivery status; links into the global alert log.
5. **Offers panel:** current offers in full text with classification badges; recent offer changes (added/removed at which check) drawn from history.
6. **Edit panel:** all FR-1.4 fields, same validation as registration; target-price edits explain re-arming behaviour inline (WP-1.7 semantics, in user language).

**Acceptance criteria:** chart verified against known seeded history including gaps, failures, and out-of-stock spans; window switching, inspection, and reference lines correct; downsampled and raw views consistent; table pagination and failure filter correct; all interactions usable by touch on mobile.

**Estimate:** 5 days.

---

### WP-2.7 — Alert Log Screen

**Objective:** the audit trail of everything PricePulse has told the user (FR-5.7, FR-4.2) — and the place where delivery problems become visible and actionable.

**Detailed functional scope:**

1. **Log listing:** newest first, paginated: alert type (badged), product (linked), what changed (old → new, percentage where applicable), fired-at, delivery channel, delivery status (delivered / failed / pending — Milestone 3 adds held) with failure reason on inspection.
2. **Filters:** by product; by alert type; by delivery status; by date range; combinable and URL-encoded (the Dashboard "alerts last 24 h" card links here pre-filtered).
3. **Delivery-failure affordances:** failed deliveries visually prominent; per-alert retry action; a bulk "retry all failed" action; persistent Telegram misconfiguration cross-links to Settings with the test-notification path (closing the FR-4.2 → FR-4.3 loop).
4. **Alert detail inspection:** the full record — values, thresholds/targets in force at firing time, delivery attempt trail with timestamps and outcomes.
5. **Empty state:** explains what will appear here and links to alert-rule settings.

**Acceptance criteria:** every alert type renders correctly with its old/new value semantics; filters verified singly and combined; retry paths demonstrated against simulated delivery failures; delivery-attempt trail complete and accurate.

**Estimate:** 3 days.

---

### WP-2.8 — Settings Screens

**Objective:** every FR-6.1 configurable, self-explanatory, applying immediately with no restart (FR-6.2) — and visibly so.

**Detailed functional scope:**

1. **Monitoring section:** check interval (bounded choice list plus custom value with sensible floor — the floor and its politeness rationale explained in plain language); consecutive-failure limit for auto-pause; the global monitoring stop lever (WP-1.4) presented as a clearly-marked emergency pause with obvious resume.
2. **Alert rules section:** global default drop-threshold percentage; per-type toggles — target price, threshold drop, any-change, offer change, back-in-stock (monitoring-health alerts deliberately not disableable, with the NFR-2 reasoning shown); each toggle carries a one-line consequence description. Layout reserves the Milestone 3 hygiene block (cooldown, quiet hours, digest).
3. **Telegram section:** bot token and chat ID entry (masked at rest, revealable during editing; stored encrypted per §8.4); connection state indicator; the **send-test-notification** button (FR-4.3) with inline success/failure feedback including the user-phrased failure reason; setup guidance for a non-technical user (how to find a chat ID, how BotFather issues tokens) written into the screen.
4. **Account section:** password change (WP-2.1 rules); display timezone (IST default) governing all rendered times and, later, quiet hours.
5. **Immediacy made visible (FR-6.2):** saving the interval shows recomputed next-check times taking effect (the BRD acceptance item 7 demonstrable moment); every save confirms with what changed; failed saves map errors onto fields.
6. **Safety:** unsaved-changes guard on navigation; all settings changes journaled (old → new, when) in an audit trail visible in an "about/system" subsection — also useful during acceptance and support.

**Acceptance criteria:** every FR-6.1 value editable and verified effective without restart (interval change observed live in worker behaviour); test notification round-trips against the real bot; encryption-at-rest of Telegram credentials verified; audit journal records all changes.

**Estimate:** 4 days.

---

### WP-2.9 — Bulk Import

**Objective:** UC-7 / FR-1.7 — a 200-row catalogue onboarded in one sitting, with a truthful, row-accurate report.

**Detailed functional scope:**

1. **File intake:** Excel and CSV; drag-drop and picker; a downloadable template file matching the documented column set (URL required; name, target price, threshold, notes, tags optional); size and row-count ceilings stated up front; client sample format (dependency D-6) accommodated by the column-mapping step.
2. **Column mapping step:** detected headers shown against expected fields with auto-matching and manual override; preview of the first rows as mapped; unmapped optional columns simply ignored, stated plainly.
3. **Validation pass (before anything is saved):** per row — URL well-formed; marketplace supported; listing-shaped (adapter recognition); duplicate against the existing catalogue (by canonical URL); duplicate within the file itself (first occurrence wins); numeric fields valid. Output: a **pre-import review** — counts of will-import / duplicate / invalid, with an expandable per-row disposition table stating each row's exact reason. Nothing imports until the user confirms this review.
4. **Execution:** confirmed rows registered through the standard registration service (parity rule from WP-1.9 applies — one code path); initial live fetches processed as a **paced queue** honouring the politeness layer (200 rows is minutes of paced work, not an instant stampede — set as expectation in the UI); progress shown live (imported so far, remaining, recent failures); the user may leave the screen — import continues server-side and its report is retrievable.
5. **Rows whose initial fetch fails** are still registered (as awaiting-first-successful-check, visible per WP-2.4 edge state) — import success is registration success; fetch health is the monitoring system's ongoing job. This rule is stated in the report.
6. **Result report (FR-1.7):** imported / duplicates / invalid counts with per-row reasons; persisted (import-batches record) and listed in an import-history subsection; downloadable as a spreadsheet including an errors-only file for fixing and re-importing (re-import of the fixed file naturally skips the now-duplicate successful rows).
7. **Concurrency and idempotence:** one import runs at a time; re-submitting the same file is safe (duplicates skip); a mid-import crash resumes or reports partial state truthfully — never a silent half-import.

**Acceptance criteria:** the BRD acceptance-item-6 case (20 mixed rows) reports exact correct counts and per-row reasons; a 500-row file imports within politeness constraints with live progress (NFR-5); template round-trips; within-file and against-catalogue duplicate rules verified; interrupted-import behaviour demonstrated; error-file re-import flow works end-to-end.

**Estimate:** 5 days.

---

### WP-2.10 — Production Bring-up, Backups & Milestone Acceptance

**Objective:** the application becomes a _production_ system with recoverable data (NFR-9), then passes all nine BRD acceptance criteria operated by the client alone.

**Detailed functional scope:**

1. **Production environment:** the second compose project on the VPS (own hostname, database, secrets) per the Phase 0 parity rules; deploy pipeline extended with the production target; staging retained for future maintenance work (§16 of the BRD).
2. **Backup automation (NFR-9):** nightly logical database backup, compressed; retention 30 daily + 12 monthly; offsite copy to client-approved storage; backup success/failure surfaced — a failed backup raises a system-health notification (NFR-2 applies to the safety net too).
3. **Restore procedure:** documented step-by-step runbook (RTO ≤ 4 hours, RPO ≤ 24 hours); a **rehearsed restore** performed onto staging from a real production backup as part of this milestone — restore is proven, not assumed; a weekly automated restore-verification job (restore into scratch database, row-count and recency sanity checks) with failures alerting.
4. **User guide (NFR-6, §8.6):** plain-language, screenshot-illustrated coverage of every routine operation — register, import, read a chart, act on an alert, adjust settings, understand every health state and what to do about each; delivered inside the app (help section) and as a standalone document.
5. **Quality passes:** real-device mobile pass (small Android, iPhone, tablet) over all screens; accessibility floor verified; load verification of catalogue, chart, and alert-log endpoints against a 500-product / 1-million-history-row dataset (NFR-5) with response-time targets recorded.
6. **Acceptance execution (BRD §14):** a scripted joint session in which **the client performs** all nine criteria end-to-end through dashboard and Telegram alone — registrations with preview on both marketplaces; automatic checks appearing in history and chart; the target-crossing alert firing once and not repeating; threshold, offer-change, and back-in-stock alerts (live or via the simulation harness per the BRD's allowance); invalid-URL auto-pause with notification; the 20-row import report; statistics, search, filters, alert log, live-effect settings change; the test-notification button. Results recorded item-by-item with evidence; defects triaged and cleared to re-test.

**Acceptance criteria:** production live over HTTPS with restart-on-reboot verified; three consecutive nightly backups with offsite copies and one verified rehearsal restore; user guide reviewed by the client; all nine BRD criteria passed by the client unassisted (NFR-6 proven by construction).

**Estimate:** 5 days (+ the joint session).

---

## 4. Milestone-Level Testing Plan

| Layer                | Coverage in this milestone                                                                                                                                                                   |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Component            | Every shared design-system component; card, chart, filter, form behaviours with mocked data                                                                                                  |
| Integration          | Auth lifecycle end-to-end; import validation matrix (every rejection reason, both duplicate classes); settings immediacy against a running worker                                            |
| End-to-end (browser) | Scripted flows mirroring all nine BRD §14 criteria, run against staging on desktop and mobile viewport profiles — these become the permanent regression pack for Milestone 3 and maintenance |
| Performance          | 500-product / 1M-row dataset: catalogue interactions, chart windows, alert-log filters within recorded targets                                                                               |
| Recovery             | Backup + rehearsal restore on staging; restore-verification job observed green and observed alerting when sabotaged                                                                          |

---

## 5. Deliverables Checklist

- [ ] Hardened login/session layer with full route-protection audit.
- [ ] Application shell + design system + style reference.
- [ ] Dashboard home with three-state health banner and statistics.
- [ ] Catalogue with search, combinable URL-encoded filters, sorting, in-place and bulk actions at 500-product scale.
- [ ] Registration UI with preview and all rejection branches.
- [ ] Product detail with price chart (windows, reference lines, explained gaps) and check-history table.
- [ ] Alert log with delivery status, filters, retry paths.
- [ ] Settings screens with live effect, Telegram test button, audit journal.
- [ ] Bulk import with mapping, pre-import review, paced execution, persistent truthful report.
- [ ] Production environment; automated verified backups; rehearsed restore runbook; user guide.
- [ ] All nine BRD §14 acceptance criteria passed by the client unassisted.

---

## 6. Exit Criteria

1. All work-package acceptance criteria pass; the browser end-to-end pack is green on desktop and mobile profiles.
2. All nine BRD §14 acceptance criteria demonstrated **by the client, unassisted** in the joint session (NFR-6), on production.
3. Backups running and restore rehearsed with evidence (NFR-9).
4. Milestone 2 sign-off recorded per BRD §13, opening Milestone 3.

---

## 7. Milestone-Specific Risks

| Risk                                          | Handling in this milestone                                                                                                                                                                    |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UI scope creep ("while we're at it…")         | The screen inventory above is the scope contract; additions route through BRD §15 change control                                                                                              |
| Chart performance over a growing history      | Server-side downsampling designed in from the first render, tested at 1M rows now, not discovered later                                                                                       |
| Import misuse (huge/odd files, wrong formats) | Stated ceilings, mapping step, pre-import review, and idempotent re-import make misuse safe and self-explanatory                                                                              |
| Non-technical acceptance stalls on usability  | The user guide and empty-state/help-text work is scoped as a deliverable, not left as polish; a mid-milestone informal walkthrough with the client catches friction before the formal session |

---

_— End of Milestone 2 Implementation Document —_
