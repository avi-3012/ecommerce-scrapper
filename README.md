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

## Identity pool & IP caps

PricePulse used to route scraping through rotating residential proxies. It no
longer does. **Every request now leaves from this machine's own ISP connection:
one IP, no proxies of any kind.** Keeping that single IP healthy is the job of
the identity layer, and it works by being boring rather than by being clever.

### What an identity is

A pool of **8 synthetic browser identities** (default) stands in for the proxy
pool. An identity is one internally consistent, long-lived persona:

| Part          | What it means                                                                                                  |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| TLS profile   | got-scraping impersonates Chromium at the handshake. This is why the pool is Chromium-family only.             |
| Headers       | Generated **once**, at creation, and replayed verbatim — order included — for the rest of the identity's life. |
| Client hints  | `sec-ch-ua` names the same brand and major version as the User-Agent; `sec-ch-ua-platform` matches the OS.     |
| Cookie jar    | One per identity per site, persisted to disk, accumulating over weeks.                                         |
| Referer chain | Each fetch arrives from the last page that identity saw on that site.                                          |
| Pacing        | A `minGapMs` of 60–150 s, randomized once per identity, plus 2–4 away periods a day of 20–90 minutes.          |

The rule underneath all of it: **nothing about a live identity is ever
regenerated.** A rotating User-Agent over a fixed TLS handshake is not
camouflage, it is a contradiction — the handshake says Chrome 145 on Windows,
the header says Firefox on Linux, and only an automated client produces that
pair. So `assertIdentityConsistent()` runs at creation _and_ on load, and refuses
to admit a persona that disagrees with itself.

Identities live for weeks. About one is replaced per 7 days as background churn;
an identity is retired early only after **3 hard blocks in 24 hours**. A single
block sends it to `cooling` for 45–120 minutes and it comes back — a pool that
only ever discards members looks synthetic, which is the thing being avoided.

### Two profiles

Two configs ship, and they encode genuinely different bets:

|                  | `config/scraping.json` (local, default) | `config/scraping.conservative.json` |
| ---------------- | --------------------------------------- | ----------------------------------- |
| Identities       | 50                                      | 8                                   |
| Rotation         | `per-request`                           | `sticky`                            |
| Per-identity gap | 20–40 s                                 | 60–150 s                            |
| Budget           | `adaptive`, 30 → 120/min                | `fixed`, 6/min                      |
| Cycle            | 55–70 s                                 | 120–180 s                           |
| Concurrency      | 12                                      | 2                                   |

Point `SCRAPING_CONFIG` at whichever you want. The local profile is built for
many products on a short interval; the conservative one for a handful of deep,
long-lived personas that each accumulate weeks of real history.

### Capacity: three ceilings, and the lowest one wins

```
budget ceiling  = whatever ipCap allows, per minute
pool ceiling    = identities.count × (60s ÷ average minGapMs)
marketplace     = unknown, unpublished, and the one that actually matters

maxProducts ≈ min(all three) × cycleMinutes
```

The **pool ceiling** is the one people trip over. Fifty identities at a 30-second
average gap top out near 100/min no matter what the budget says — so raising
`ipCap` past that changes nothing, and the startup warning will tell you so:

```
WARN  the pool, not the budget, is the ceiling: 8 identities at a 105s average
      gap top out near 5/min, far below the 240/min budget — so raising the
      budget will do nothing. To actually reach 240/min you need about 420
      identities at this gap, or a gap of about 2s at this count.
```

The **marketplace ceiling** cannot be configured, only measured — see
[`ramp`](#finding-the-real-ceiling) below.

When the products don't fit the budget, the cycle **stretches** rather than the
budget being exceeded, and the log says so once:

```
[identity] WARN 200 products at 30/min → effective cycle 6.7 min
```

That is arithmetic, not a bug. If the stretch exceeds 3× the requested cycle the
worker refuses to start; set `limits.refuseWhenStretched: false` (as the local
profile does) or pass `--force` when a long cycle is expected and understood.

### Adaptive rate: the budget you don't have to guess

`ipCap.mode: "adaptive"` replaces a number somebody guessed with one that gets
discovered. It is TCP congestion control aimed at an anti-bot system: **additive
increase** (+1/min per clean interval), **multiplicative decrease** (×
`decreaseFactor` when blocks become a proportion of traffic).

The subtlety worth knowing about is `tolerateBlockRatio`. Cutting the rate on
_every_ block sounds cautious and is the opposite of useful: a cut is a large
multiplicative step and a recovery is one additive step per interval, so with any
background failure rate at all the controller ratchets itself down to nothing.
Against a simulated 60/min ceiling, cutting per-block parked the rate at ~15/min;
cutting on a 2% block _ratio_ settles at 58/min with a 0.67% block rate. So one
refusal among three hundred good responses is treated as noise, which is what it
is.

Watch it work, offline, in seconds:

```
pnpm --filter @pricepulse/worker dryrun --products 200 --ceiling 60 --cycles 16
```

### Finding the real ceiling

```
pnpm --filter @pricepulse/worker ramp --start 10 --step 10 --hold 120 --max 200
```

Walks the request rate up against your real listings, stops at the first hard
block, and reports the last clean rate plus what it implies:

```
Last clean rate:  70/min
First blocked at: 80/min

At 70/min sustained:
  1-minute checks   → about 70 products
  5-minute checks   → about 350 products
  15-minute checks  → about 1050 products

Set ipCap.adaptive.maxPerMin near 56 (80% of the last clean rate).
```

Run it once before committing to a catalogue size, and again if blocks start
rising — the number moves.

### Check intervals

Per-product and global intervals go down to **1 minute**. There is no floor in
the validators, deliberately: what the connection can sustain is decided by the
budget and discovered by `ramp`, and a validator that forbids _asking_ for a
1-minute interval only hides the arithmetic instead of doing it. If the interval
you ask for exceeds what the budget can carry, the cycle stretches and the
banner says by how much.

### Home vs office

`connection.type` describes the line, and the honest number of identities
follows from it:

| Line     | Identities     | Why                                                                                                                                |
| -------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `home`   | **up to 8–12** | A household has a handful of devices. Above 12 you get a startup WARN, because a home IP that hosts twenty browsers is not a home. |
| `office` | **20–40**      | An office line genuinely carries dozens of real users, and the marketplaces know it.                                               |

### Configuration

Everything lives in [config/scraping.json](config/scraping.json):

```json
{
  "connection": { "type": "home" },
  "identities": { "count": 8 },
  "cycle": { "minSec": 120, "maxSec": 180 },
  "ipCap": { "dayPerMin": 6, "nightPerMin": 2 },
  "night": { "startIST": "00:00", "endIST": "07:00" },
  "noiseRatio": 0.1,
  "maxConcurrent": 2
}
```

Two environment variables matter: `IDENTITY_DIR` (where identities, cookie jars
and backoff state are persisted — **must be durable storage**) and `PAUSE`.
`SCRAPING_CONFIG` selects which config file to read.

**Rotation does not hide the IP.** It is the join key either way, and no amount
of header variety changes how many requests arrive from one address. What
rotation changes is what the traffic from that address _looks like_: one
household's few devices, or a CGNAT-style block of many. Both are real patterns;
neither raises the ceiling.

### Operating it

```
pnpm --filter @pricepulse/worker status     # pool state, learned rate, backoff — reads storage, works while the daemon runs
pnpm --filter @pricepulse/worker banner     # the startup banner + the capacity refusal, without starting
pnpm --filter @pricepulse/worker once <url> # one URL, one identity, prints classification + parsed result
pnpm --filter @pricepulse/worker ramp       # walk the rate up against real listings until the first block
pnpm --filter @pricepulse/worker dryrun     # the whole machine against saved fixtures, offline
```

**Kill switch.** `PAUSE=1` in the environment, or a file named `PAUSE` in
`IDENTITY_DIR` or the working directory. Both are re-checked before every
request, so `touch data/identities/PAUSE` stops fetching within a second.

### Detection and backoff

Every response is classified `ok`, `suspect`, or `hard_block`.

- **`hard_block`** — Amazon's 503/CAPTCHA/robot-check pages, its 403/429; any
  Flipkart non-200 (529 has been seen in the wild), or a Flipkart 200 with no
  product in it. The identity cools; the IP-level counter increments. A blocked
  URL is **never** immediately retried, and a block no longer escalates to the
  browser tier — under proxies that retry left from a different exit node, but
  here it leaves from the same address seconds later.
- **`suspect`** — a title with no price, a price ≤ 0, or a move of more than 40%
  against the last accepted price. **Nothing is recorded.** The product is
  re-asked ≥ 10 minutes later by a _different_ identity, and the price is
  accepted only when two identities agree. A flagged session gets served
  plausible-looking wrong data at HTTP 200; a single reading cannot tell that
  apart from a real price move.
- **IP-level** — 2 hard blocks in 15 minutes, or 3 in an hour, trigger a global
  pause on an exponential ladder: **10 → 20 → 40 → 80 minutes, capped at 3
  hours**. Afterwards `dayPerMin` runs at half for 6 hours. The event logs at
  ERROR and fires a `system_health` alert through the existing Telegram path.
  The ladder resets after 6 clean hours.

### Failure capture

**Every failed check writes the full response it received to disk**, gzipped,
under `$IDENTITY_DIR/failures/<date>/`. Each capture is a `.html.gz` plus a
`.json` sidecar (URL, identity, reason, status, headers, sha256), and one line
is appended to `failures/index.jsonl`. The path is recorded on the audit row as
`scrape_audit.capture_path`, so a row and its bytes always join back up.

The bytes are on disk rather than in Postgres because an Amazon product page is
~2 MB of HTML — not a database column, and it would make `debug` unqueryable.
Compression gets that to roughly a tenth. The directory is pruned daily by age
(7 days) and then by total size (512 MB), because debug output that grows
without bound is a disk-full incident waiting for the week nobody is watching.

```
pnpm --filter @pricepulse/worker failures                  # newest 20
pnpm --filter @pricepulse/worker cli failures --n 50 --reason parse_failed
gunzip -c data/identities/failures/2026-08-27/<file>.html.gz > /tmp/page.html
```

This matters most for `parse_failed`: it is the case where the response is most
needed and least reproducible, because asking the marketplace again to see what
it sent is slow and, on a flagged IP, actively harmful.

The first three block bodies per marketplace are additionally saved to
`$IDENTITY_DIR/fixtures/<marketplace>/` as 2 KB heads — that is the set the
detectors get tuned against.

### Runbook: blocks are rising

Work down this list **in order**. Each step costs less than the one after it.

1. **`status` first.** Which identities are blocked — one, or all of them? A
   single identity taking blocks is that persona being burned, and it will
   retire itself after three. Blocks spread evenly across the pool mean the _IP_
   is flagged, and nothing you do to the pool will help.
2. **Lower the budget.** In `adaptive` mode, drop `ipCap.adaptive.maxPerMin` —
   the controller is already cutting on its own, and this lowers the ceiling it
   climbs back to. In `fixed` mode, `ipCap.dayPerMin: 6 → 4`. Either way this is
   the highest-value change: it directly reduces how busy the line looks, and it
   costs you nothing but a longer cycle. Re-run `ramp` to see where the ceiling
   moved to.
3. **Shrink the pool.** `identities.count: 8 → 5`. Fewer devices on one line is
   a more ordinary household. Do this _after_ lowering the caps — a smaller pool
   at the same cap just makes each identity work harder, which is the wrong
   direction.
4. **Lengthen the cycle.** `cycle.minSec/maxSec: 120/180 → 300/420`. Slower is
   safer, always. Do this last only because the earlier steps already lengthen
   the effective cycle for free.

If blocks continue through all four, stop and wait. `PAUSE` for a few hours. An
IP that has been flagged recovers on its own clock, and continuing to probe it
is how a temporary flag becomes a persistent one.

> **Anyone else sharing this connection will see CAPTCHAs too.** The IP is the
> unit the marketplaces flag, not the process. If this line gets flagged,
> everyone on it — the same household, the same office — hits "verify you're not
> a robot" on Amazon and Flipkart in their ordinary browsers, and it is not
> obvious to them why. That is the real cost of setting the caps too high, and
> it is a cost borne by people who did not choose it.

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
- **Environment config vs. user settings:** env vars are for infrastructure (DB URL, keys, ports); anything the user can change lives in the database and applies live (FR-6.2). Scraping shape — pool size, cycle, IP caps — is neither: it is a property of the _connection_, so it lives in [config/scraping.json](config/scraping.json).
- **Nothing reaches a marketplace except through an identity session.** There is deliberately no module-level default fetch: an anonymous request with freshly generated headers is the exact pattern the identity layer replaced.
- Root `.env` is the single env file for local dev; apps load it themselves. Real environments set real environment variables.
