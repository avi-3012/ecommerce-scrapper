# The Flipkart worker

Flipkart refuses AWS addresses on first contact, so Flipkart products are not
sent from the instance's own IPs. They are scraped by a **second worker on the
same EC2 box** that sends every request through **static ISP proxies**. One
box, one database, one deploy command.

The two workers are fully separate:

| | Amazon worker | Flipkart worker |
|---|---|---|
| Compose service | `worker` | `worker-flipkart` |
| Scrapes | Amazon only | Flipkart only |
| Sends from | the instance's Elastic IPs | the proxies in its config |
| Role | primary — also runs Telegram, alert delivery, housekeeping | secondary — only scrapes |
| Status row | 1 | 2 |
| Scraping config | `config/scraping.local.json` | `config/scraping.flipkart.local.json` |
| Interval & product limit | Settings → Amazon | Settings → Flipkart |
| Identities, budget, backoff | its own | its own, one budget per proxy |

Nothing either worker does can reach the other's request budget. Until the
Flipkart worker is running, Flipkart products wait: the dashboard says so, and
each shows a *"no Flipkart worker running"* badge.

## 1. Buy proxies

**Static (long-term) ISP proxies, HTTP with username/password**, India location
if the vendor offers it. Each proxy is one route with its own budget, so the
number you need follows from the load, using the ~3.5 requests/min per address
that Amazon's routes sustain until Flipkart's own number is measured:

```
requests/min ≈ products ÷ interval(min) × 1.1

  50 laptops at 30 min   ≈  1.9/min   →  1 proxy
 300 laptops at 30 min   ≈ 11/min     →  3–4 proxies
 300 laptops at  5 min   ≈ 66/min     → ~19 proxies
```

Not supported: SOCKS proxies (the HTTP client cannot tunnel HTTP/2 through
them). The config refuses them at load rather than at the first request.

## 2. Configure

On the EC2 box:

```bash
cd ~/ecommerce-scrapper
cp config/scraping.flipkart.json config/scraping.flipkart.local.json
```

Edit `config/scraping.flipkart.local.json`:

```json
"proxies": ["http://user:pass@1.2.3.4:8080", "http://user:pass@5.6.7.8:8080"],
"identities": { "count": 24, ... }
```

`identities.count` should be about **12 per proxy**. The file is gitignored
because it holds credentials; the worker reads only this copy and refuses to
start if it is missing.

## 3. Deploy — one command

```bash
git pull
docker compose --env-file deploy/.env.aws \
  -f deploy/docker-compose.aws.yml \
  -f deploy/docker-compose.egress.yml \
  -f deploy/docker-compose.flipkart.yml up -d --build
```

The third `-f` adds the Flipkart worker. Keep all three on every later compose
command for this stack (`logs`, `restart`, `down`). The `migrate` service
applies the database migration before either worker starts.

## 4. Verify

```bash
C="docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml -f deploy/docker-compose.egress.yml -f deploy/docker-compose.flipkart.yml"
$C logs worker-flipkart | head -40
```

Expect, in order:

```
Worker scope: flipkart · role secondary · status row 2
  connection      office, 2 proxies (1.2.3.4:8080, 5.6.7.8:8080), each with its own budget and backoff
Telegram bot: handled by the primary worker
```

Proxies appear by `host:port` only — the credentials are never written to a
log, a status row or a diagnostics bundle. One governor file per proxy:

```bash
$C exec worker-flipkart ls /repo/data/identities/ | grep governor
```

The dashboard shows a second scraper panel, **Scraper — Flipkart**, with a row
per proxy: its allowance, usage, blocks and backoff. Its first few checks are
warm-ups, so give it ten minutes before reading anything into the numbers.

The Amazon worker's first log line should still read
`Worker scope: amazon_in · role primary · status row 1`; nothing about it
changed.

## 5. Set Flipkart's limits

Dashboard → **Settings** → **Flipkart**:

- **Check interval** — blank means the same as Amazon's.
- **Products checked at once** — blank means every active Flipkart product.
  **Set this before importing 300 laptops**: start at 50, and raise it once the
  Flipkart panel shows no blocks. Highest-priority products are scraped first.

Changes take effect on the next cycle; no restart.

## Replacing a proxy

Edit `config/scraping.flipkart.local.json` and restart only the Flipkart
worker — the Amazon worker is untouched:

```bash
$C up -d worker-flipkart
```

Identities bound to a removed proxy are re-homed onto the remaining ones over
a few minutes; identities for a new proxy are created gradually.

## Before Flipkart prices are trustworthy

A test from a non-AWS connection found two Flipkart pipeline issues that no
proxy fixes:

- **Pincode localisation** did not verify for any of 9 products. With a
  delivery pincode set, in-stock Flipkart products fail rather than record an
  unlocalised price.
- **Price parsing** failed on 3 of 9 new phone listings. Laptops looked fine in
  a smaller sample.

Both need fixing before Flipkart reaches Amazon's success rate.
