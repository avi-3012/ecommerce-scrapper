# Business Requirements Document (BRD)

## PricePulse — E-Commerce Price Tracking & Alert Application

|                      |                                              |
| -------------------- | -------------------------------------------- |
| **Document Version** | 1.0 (Draft)                                  |
| **Date**             | 10 July 2026                                 |
| **Prepared By**      | Rishika Jat, Independent Software Consultant |
| **Prepared For**     | [Client Name]                                |
| **Status**           | Draft — pending client review and sign-off   |

---

## 1. Executive Summary

PricePulse is a price tracking and alerting application that continuously monitors product listings on Indian e-commerce marketplaces — initially **Amazon India** and **Flipkart** — and notifies the user through **Telegram** the moment prices, promotional offers, or stock availability change.

The user registers any product they wish to watch. From that point, the application checks the product automatically at a regular interval, records every observed price into a historical record, evaluates the user's alert rules, and sends instant notifications when those rules are met. A web dashboard gives the user a live view of their entire watched catalogue, with price-history charts, filters, and full control over alert behaviour.

The initial release serves a **single user**, but the product is specified so that additional users and additional marketplaces can be added in future phases without redesign.

---

## 2. Business Objectives

| #    | Objective                                      | Business Value                                                                                                                                   |
| ---- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| BO-1 | Eliminate manual price checking                | The user currently checks listings by hand; the application converts "I must keep checking" into "I will be told."                               |
| BO-2 | Capture time-sensitive price drops             | Marketplace prices change frequently and flash deals last hours; automated monitoring captures savings a human would miss.                       |
| BO-3 | Enable evidence-based buying decisions         | Recorded price history reveals whether a "sale" price is genuinely low, what a product's normal price band is, and when the best time to buy is. |
| BO-4 | Monitor effective price, not just listed price | In the Indian market the real purchase price includes bank offers and coupons; the application tracks these alongside the listed price.          |
| BO-5 | Support catalogue-scale monitoring             | The user can watch a large list of products (bulk-imported) with the same effort as watching one.                                                |

### Success Criteria (measurable)

1. A registered product is checked automatically at the configured interval with **≥ 95% of scheduled checks completing successfully** in a normal week.
2. A qualifying price change results in a Telegram notification **within one monitoring cycle** of the change being observed.
3. The user can register a new product and receive confirmation of its current price in **under one minute**.
4. Every product displays a price history chart from its very first check onward, with **no gaps other than recorded failed checks**.
5. Zero "silent failures": if the application cannot monitor a product, the user is explicitly informed.

---

## 3. Background & Problem Statement

Prices on Indian e-commerce marketplaces move constantly due to algorithmic repricing, flash sales, seasonal events (e.g. Big Billion Days, Prime Day), and bank-partnership promotions. A buyer who wants the best price must:

- check multiple listings across multiple platforms, repeatedly, at unpredictable times;
- judge whether a displayed "discount" is genuine without any historical reference;
- notice short-lived offers (bank instant discounts, coupons) that appear and disappear independently of the listed price;
- track stock availability for products that sell out.

This is impractical to do manually beyond a handful of products. Existing global tools cover this only partially for the Indian market (limited Flipkart coverage, no bank-offer awareness). PricePulse addresses this gap as a personal, self-managed tracking application.

---

## 4. Scope

### 4.1 In Scope (Phase 1)

- Monitoring of product listings on **Amazon India (amazon.in)** and **Flipkart (flipkart.com)**.
- Product registration by pasting a product listing URL, with an immediate preview of the detected product before saving.
- Automated, recurring price checks at a user-configurable interval.
- Capture of: product name, current selling price, listed MRP, calculated discount percentage, active promotional/bank offers, and stock availability.
- Permanent price history per product.
- Configurable alert rules and instant **Telegram notifications**.
- Two-way Telegram interaction (register and manage products from within Telegram).
- Web dashboard: catalogue view, price-history charts, alert log, settings.
- Bulk import of products from a spreadsheet file; export of data.
- Application self-monitoring with explicit user-facing health status.

### 4.2 Out of Scope (Phase 1)

- Marketplaces other than Amazon India and Flipkart (roadmap item).
- Notification channels other than Telegram (email/WhatsApp are roadmap items).
- Multiple user accounts and public sign-up (the design must allow it later; it is not delivered in Phase 1).
- Purchasing, cart, or checkout automation of any kind.
- Price _prediction_ / machine-learning forecasting (roadmap item).
- Mobile applications (the web dashboard must be usable on a mobile browser).
- Product search by name/keyword across marketplaces (Phase 2 candidate — Phase 1 registration is by URL).

---

## 5. Stakeholders & Users

| Role                       | Description                                                                                                    | Interest                                                   |
| -------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **Product Owner / Client** | Commissions and owns the application                                                                           | Business value, delivery timeline, running cost            |
| **Primary User**           | The single end user of Phase 1 — an individual buyer or a small trader/reseller monitoring a product catalogue | Reliable alerts, trustworthy history, minimal effort       |
| **Developer / Maintainer** | Builds and maintains the application                                                                           | Clear requirements, maintainability, defined support scope |

### User Persona (Phase 1)

**"The Catalogue Watcher"** — an individual who tracks anywhere from 5 to 200+ products (typically electronics such as mobile phones and laptops) across Amazon India and Flipkart. They may be buying for themselves or trading commercially. They live on their phone, prefer Telegram as their notification channel, and want to act within minutes of a price movement. They are not technical and must never need to look at logs or configuration files to know whether the system is working.

---

## 6. Use Cases

| ID   | Use Case                         | Description                                                                                                                                                           |
| ---- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| UC-1 | **Buy at target price**          | User sets a target price on a product; when the price drops to or below the target, they are notified immediately and can purchase at the desired price.              |
| UC-2 | **Catch flash deals**            | Short-lived deals are detected within one monitoring cycle, letting the user act before the deal expires.                                                             |
| UC-3 | **Verify discount authenticity** | Before buying during a "sale", the user consults the price history chart to confirm the offer price is genuinely lower than the product's normal price band.          |
| UC-4 | **Compare platforms**            | The user tracks the same product on both marketplaces and sees at a glance which one is cheaper now and which is cheaper historically.                                |
| UC-5 | **Catch offer changes**          | A bank instant-discount or coupon appears on a listing without the price changing; the user is notified because the _effective_ price improved.                       |
| UC-6 | **Back-in-stock purchase**       | A watched out-of-stock product returns to availability; the user is notified within one monitoring cycle.                                                             |
| UC-7 | **Catalogue onboarding**         | A user with a large product list imports it in one step from a spreadsheet rather than registering items one by one.                                                  |
| UC-8 | **Timing intelligence**          | Over weeks of accumulated history, the user identifies pricing patterns (e.g. month-end drops, event pricing) and times purchases accordingly.                        |
| UC-9 | **Hands-off assurance**          | The user glances at the dashboard and immediately knows the system is healthy: what is being watched, when it was last checked, and whether anything needs attention. |

---

## 7. Functional Requirements

Requirements are prioritised using MoSCoW: **M** = Must have (Phase 1), **S** = Should have (Phase 1 if budget permits), **C** = Could have (Phase 2 candidate).

### 7.1 Product Registration & Management

| ID     | Requirement                                                                                                                                                                                                                                                                                      | Priority |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- |
| FR-1.1 | The user shall be able to register a product for tracking by providing its listing URL from a supported marketplace.                                                                                                                                                                             | M        |
| FR-1.2 | On registration, the application shall automatically detect which marketplace the URL belongs to and reject URLs from unsupported sites with a clear message.                                                                                                                                    | M        |
| FR-1.3 | Before saving, the application shall display a **live preview** of the detected product — name, current price, MRP, offers, stock status — so the user can confirm the correct product was identified.                                                                                           | M        |
| FR-1.4 | The user shall be able to set, per product: an optional **target price**, an optional **price-drop threshold percentage** (overriding the global default), free-text notes, and one or more category tags.                                                                                       | M        |
| FR-1.5 | The application shall prevent duplicate registration of the same listing URL and inform the user the product is already tracked.                                                                                                                                                                 | M        |
| FR-1.6 | The user shall be able to edit, pause/resume, and delete any tracked product. Deleting a product shall remove its history and alerts after an explicit confirmation.                                                                                                                             | M        |
| FR-1.7 | The user shall be able to bulk-register products by uploading a spreadsheet (Excel/CSV) containing at minimum a URL column, and optionally name, target price, threshold, and notes columns. The import shall report how many rows were imported, skipped as duplicates, or rejected as invalid. | M        |
| FR-1.8 | The user shall be able to link two listings (one per marketplace) as the **same product**, enabling side-by-side comparison.                                                                                                                                                                     | S        |
| FR-1.9 | The user shall be able to register a product by typing its name and choosing from matching listings found on the supported marketplaces.                                                                                                                                                         | C        |

### 7.2 Automated Monitoring

| ID     | Requirement                                                                                                                                                                                                                           | Priority |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-2.1 | The application shall automatically check every active product at a recurring interval. The interval shall be user-configurable (default: every 30 minutes) and changes shall take effect without restarting the application.         | M        |
| FR-2.2 | Each check shall capture: selling price, MRP, calculated discount %, list of active promotional/bank offers, stock availability, and the check timestamp.                                                                             | M        |
| FR-2.3 | Every check — successful or failed — shall be recorded in the product's history. Failed checks shall record the reason.                                                                                                               | M        |
| FR-2.4 | The user shall be able to trigger an immediate check of a single product or of all products on demand, in addition to the automatic schedule.                                                                                         | M        |
| FR-2.5 | Monitoring shall be polite to the marketplaces: checks shall be paced and randomised so that monitoring activity does not resemble abusive traffic.                                                                                   | M        |
| FR-2.6 | If a product fails a defined number of consecutive checks (default: 5), the application shall automatically pause it and notify the user, stating the product and the reason. Monitoring of other products shall continue unaffected. | M        |
| FR-2.7 | A product listing that is temporarily out of stock shall be treated as a _successful_ check (recording the stock status), not as a monitoring failure.                                                                                | M        |
| FR-2.8 | The user shall be able to designate high-priority products to be checked at a shorter interval during major sale events.                                                                                                              | C        |

### 7.3 Alert Rules

| ID      | Requirement                                                                                                                                                                                                                       | Priority |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-3.1  | **Target price alert:** notify when a product's price drops to or below its target price. The alert shall fire only when the price _crosses_ the target (i.e. it was previously above), not repeatedly on every subsequent check. | M        |
| FR-3.2  | **Threshold drop alert:** notify when the price drops by at least the applicable threshold percentage (per-product value if set, otherwise the global default).                                                                   | M        |
| FR-3.3  | **Any-change alert:** optionally notify on every price movement (rise or drop). This behaviour shall be a global on/off setting.                                                                                                  | M        |
| FR-3.4  | **Offer-change alert:** notify when the set of promotional/bank offers on a listing changes, even if the listed price is unchanged. This behaviour shall be a global on/off setting.                                              | M        |
| FR-3.5  | **Back-in-stock alert:** notify when a watched product transitions from out of stock to available.                                                                                                                                | M        |
| FR-3.6  | **Monitoring-health alert:** notify when a product is auto-paused due to repeated failures (per FR-2.6).                                                                                                                          | M        |
| FR-3.7  | Every alert notification shall state: product name, marketplace, old and new values, percentage change where applicable, and a direct link to the listing.                                                                        | M        |
| FR-3.8  | **Alert hygiene:** the application shall not send a duplicate alert for the same product and same condition within a configurable cooldown window.                                                                                | S        |
| FR-3.9  | **Quiet hours:** the user shall be able to define a daily time window during which alerts are held and delivered as a summary afterwards.                                                                                         | S        |
| FR-3.10 | **Digest:** the user shall be able to receive a daily or weekly summary of all price movements across their catalogue.                                                                                                            | S        |

### 7.4 Telegram Notifications & Bot Interaction

| ID     | Requirement                                                                                                                                                | Priority |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-4.1 | All alerts shall be delivered to the user's configured Telegram chat/channel.                                                                              | M        |
| FR-4.2 | The delivery outcome of every alert (delivered / failed, with reason) shall be recorded and visible in the alert log.                                      | M        |
| FR-4.3 | The user shall be able to send a **test notification** from the settings screen to verify their Telegram configuration.                                    | M        |
| FR-4.4 | The user shall be able to register a product by sending its URL directly to the Telegram bot, receiving the same preview/confirmation as in the dashboard. | S        |
| FR-4.5 | The user shall be able to list, pause, resume, and set a target price on tracked products through Telegram bot commands.                                   | S        |
| FR-4.6 | Additional notification channels (email, WhatsApp) shall be supportable in future without redesign.                                                        | C        |

### 7.5 Dashboard & Visualisation

| ID     | Requirement                                                                                                                                                                                          | Priority |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-5.1 | The dashboard shall show summary statistics: total products tracked, alerts fired in the last 24 hours, price drops in the last 24 hours, and the time of the last completed monitoring run.         | M        |
| FR-5.2 | The catalogue view shall show each product as a card/row with: name, marketplace, current price, MRP and discount, change since previous check, stock status, last-checked time, and current offers. | M        |
| FR-5.3 | The user shall be able to search the catalogue by name/URL and filter by marketplace, category tag, price-drop status, stock status, and monitoring-health status.                                   | M        |
| FR-5.4 | Each product shall have a **price history chart** over a selectable time window (e.g. 7 / 30 / 90 days), plotting selling price over time.                                                           | M        |
| FR-5.5 | Each product shall display **deal-quality context**: its all-time lowest, average, and highest recorded price, and a clear indication when the current price is at or near its recorded low.         | S        |
| FR-5.6 | Linked cross-platform products (FR-1.8) shall have a comparison view showing both marketplaces' current prices and both price histories on a single chart.                                           | S        |
| FR-5.7 | An **alert log** screen shall list all fired alerts (filterable by product), showing what fired, when, the values involved, and Telegram delivery status.                                            | M        |
| FR-5.8 | The dashboard shall reflect newly observed prices without requiring a manual page refresh.                                                                                                           | S        |
| FR-5.9 | The dashboard shall be usable on a mobile browser.                                                                                                                                                   | M        |

### 7.6 Settings & Administration

| ID     | Requirement                                                                                                                                                                     | Priority |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| FR-6.1 | The user shall be able to configure from the settings screen: Telegram credentials, monitoring interval, global default drop threshold, and on/off toggles for each alert type. | M        |
| FR-6.2 | All settings changes shall take effect immediately without technical intervention.                                                                                              | M        |
| FR-6.3 | The user shall be able to export their tracked-product list and full price history to a spreadsheet file.                                                                       | S        |
| FR-6.4 | Access to the application shall be protected by a login, and the design shall accommodate multiple user accounts in a future phase without restructuring stored data.           | M        |

---

## 8. Non-Functional Requirements

| ID    | Requirement                                                                                                                                                                                     |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-1 | **Reliability:** the monitoring service shall run continuously and unattended. Failure of any single product check shall never interrupt monitoring of other products.                          |
| NFR-2 | **Transparency:** the system shall never fail silently. Every product visibly shows when it was last successfully checked, and any condition requiring user attention generates a notification. |
| NFR-3 | **Timeliness:** qualifying changes shall be notified within one monitoring cycle of being observed.                                                                                             |
| NFR-4 | **Data retention:** price history shall be retained indefinitely by default (it is the product's core long-term value) unless the user deletes a product.                                       |
| NFR-5 | **Capacity (Phase 1):** the application shall comfortably handle at least 500 tracked products for a single user at a 30-minute interval.                                                       |
| NFR-6 | **Usability:** all routine operations (register, edit, pause, review history, change settings) shall be achievable by a non-technical user through the dashboard or Telegram alone.             |
| NFR-7 | **Data protection:** credentials (login, Telegram) shall be stored securely; the application and its data shall not be accessible without authentication.                                       |
| NFR-8 | **Maintainability:** support for a new marketplace shall be addable as a self-contained extension without changes to registration, alerting, history, or dashboard behaviour.                   |
| NFR-9 | **Recoverability:** application data shall be backed up on a regular schedule, with a documented restore procedure.                                                                             |

---

## 9. Data Requirements

The application shall maintain, at minimum, the following business data:

1. **Tracked Product** — listing URL, marketplace, display name, category tags, notes, target price, drop threshold, active/paused state, current price/MRP/offers/stock snapshot, last-checked and last-changed timestamps.
2. **Price History** — one record per check per product: price, MRP, discount %, offers, stock status, timestamp, success/failure and failure reason.
3. **Alert Record** — one record per fired alert: product, alert type, old/new values, change %, timestamp, delivery channel, delivery outcome.
4. **Settings** — all user-configurable values in Section 7.6.
5. **User Account** — login identity and notification configuration (single account in Phase 1; structure must permit more).

---

## 10. Assumptions

1. The marketplaces do not offer suitable public data interfaces for this use case; price data will be gathered by automated observation of public product pages. The client accepts this approach and its inherent characteristics (see Risks).
2. The client will provide (or approve creation of) the Telegram bot and destination chat/channel used for notifications.
3. The application is for the client's **personal / internal business use** by a single user in Phase 1; it will not be resold or offered publicly without a further agreement.
4. The client will provide the hosting environment or approve a hosting arrangement and bear its running costs.
5. Product listing URLs supplied by the user are valid public listing pages on the supported marketplaces.
6. Monitoring frequency defaults are chosen to balance freshness against the risk of the marketplaces restricting automated access.

---

## 11. Constraints

1. **Two marketplaces at launch** — Amazon India and Flipkart only; others are chargeable extensions.
2. **Marketplace dependence** — the marketplaces control their own websites; changes on their side can temporarily interrupt data collection until maintenance is performed (see Risks and Support).
3. **Notification dependency** — alert delivery depends on the availability of the Telegram service.
4. **Single user at launch** — no public registration; one authenticated account.

---

## 12. Risks & Mitigations

| #   | Risk                                                                    | Likelihood           | Impact                                         | Mitigation                                                                                                                                                          |
| --- | ----------------------------------------------------------------------- | -------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R-1 | Marketplace website changes break data collection for one or both sites | **High (recurring)** | Tracking gaps until fixed                      | Resilient multi-layer data extraction; automatic failure detection with user notification (FR-2.6, NFR-2); **ongoing maintenance agreement** covering prompt repair |
| R-2 | Marketplace restricts or blocks automated access                        | Medium               | Checks fail or slow down                       | Polite pacing (FR-2.5); configurable interval; documented fallback options (e.g. commercial data providers) available as a chargeable change                        |
| R-3 | Marketplace terms of service disallow automated collection              | Accepted by client   | Legal/ToS exposure rests with the client's use | Application is single-user and personal-use scale; risk formally acknowledged in this document at sign-off                                                          |
| R-4 | Alert fatigue — too many notifications reduce user trust                | Medium               | User ignores alerts, value lost                | Per-type toggles, thresholds, crossing semantics, cooldowns, quiet hours, digest (Section 7.3)                                                                      |
| R-5 | Incorrect price extracted (wrong variant/seller on a listing page)      | Low–Medium           | False alerts                                   | Registration preview (FR-1.3) confirms correct detection; alert messages always link to the live listing for verification                                           |
| R-6 | Hosting outage                                                          | Low                  | Missed monitoring cycles                       | Automatic restart/recovery; backups (NFR-9); missed cycles resume automatically                                                                                     |
| R-7 | Scope growth during build                                               | Medium               | Timeline/cost overrun                          | This BRD is the agreed scope; changes follow the change-control process in Section 15                                                                               |

---

## 13. Phased Delivery

| Phase                                                         | Contents                                                                                                                                                                                 | Outcome                                               |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| **Milestone 1 — Core Tracking**                               | Registration with preview, automated monitoring, price history, target/threshold/stock alerts, Telegram delivery, health self-monitoring (all Section 7 items marked M except dashboard) | Working tracker demonstrable end-to-end via Telegram  |
| **Milestone 2 — Dashboard**                                   | Full dashboard, charts, alert log, settings screens, bulk import, login                                                                                                                  | Complete Phase 1 application, ready for daily use     |
| **Milestone 3 — Experience Enhancements** (Should-have items) | Two-way Telegram bot commands, deal-quality context, cross-platform comparison, alert hygiene (cooldown/quiet hours/digest), export, live dashboard updates                              | Polished product matching mature tracker expectations |
| **Phase 2 (separately scoped)**                               | Additional marketplaces, name-based product search, additional notification channels, multi-user accounts, sale-event fast-checking, price-trend insights                                | Growth roadmap                                        |

Acceptance of each milestone occurs against the acceptance criteria below before the next begins.

---

## 14. Acceptance Criteria (Phase 1)

The application will be considered accepted when the client verifies, in a joint review session:

1. Registering one Amazon India and one Flipkart product by URL shows a correct preview and begins tracking (FR-1.1–1.3).
2. Prices are checked automatically at the configured interval, and each check appears in the product's history and chart (FR-2.1–2.3, FR-5.4).
3. Lowering a product's target price to just above the current price and observing a subsequent drop produces a Telegram alert within one cycle; the alert does not repeat on later unchanged checks (FR-3.1, NFR-3).
4. A threshold-percentage drop, an offer change, and a back-in-stock transition each produce their respective alert (FR-3.2, 3.4, 3.5) — demonstrated live or via a controlled simulation agreed with the client.
5. A deliberately invalid product URL fails visibly and, after the configured consecutive failures, the product auto-pauses with a Telegram notification (FR-2.6, FR-3.6).
6. Bulk import of a sample spreadsheet of at least 20 mixed rows reports imported / duplicate / invalid counts correctly (FR-1.7).
7. Dashboard statistics, search, filters, alert log with delivery status, and settings changes (including interval change taking live effect) all function as specified (Sections 7.5–7.6).
8. The test-notification button delivers a Telegram message (FR-4.3).
9. All of the above performed by the client through the dashboard/Telegram alone, with no technical assistance (NFR-6).

---

## 15. Change Control

Any requirement not stated in this document is out of scope. Requested additions or modifications after sign-off will be assessed and quoted separately as change requests, each with its own effort, cost, and timeline impact, and will proceed only on written approval.

---

## 16. Support & Maintenance (post-delivery)

Because data collection depends on third-party websites that change without notice (Risk R-1), a **monthly maintenance agreement** is recommended and quoted separately, covering: repair of data-collection breakages, monitoring of application health, backup verification, and minor adjustments. Without an active agreement, breakage repairs are handled as ad-hoc chargeable work on a best-effort timeline.

---

## 17. Glossary

| Term                         | Meaning                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| **Listing**                  | A single product page on a marketplace, identified by its URL                                 |
| **MRP**                      | Maximum Retail Price printed/declared for the product                                         |
| **Selling price**            | The price actually offered on the listing at check time                                       |
| **Offer**                    | A promotional condition on a listing (bank instant discount, coupon, exchange bonus, etc.)    |
| **Check / monitoring cycle** | One automated observation of a listing at the scheduled interval                              |
| **Target price**             | User-defined price at or below which they wish to be alerted                                  |
| **Threshold**                | Percentage drop between consecutive observed prices that triggers an alert                    |
| **Crossing**                 | The transition of a price from above to at-or-below a target, used to prevent repeated alerts |
| **Auto-pause**               | Automatic suspension of monitoring for a product after repeated consecutive failures          |
| **Digest**                   | A scheduled summary notification aggregating multiple changes                                 |

---

_— End of Document —_
