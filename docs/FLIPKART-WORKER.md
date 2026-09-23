# The Flipkart worker

Flipkart refuses AWS addresses on first contact, so Flipkart products are not
scraped by the worker on EC2. They are scraped by a **second worker** that runs
on a connection Flipkart serves — your home line — and reports into the same
database.

The two workers are fully separate:

| | Amazon worker (EC2) | Flipkart worker (home) |
|---|---|---|
| Scrapes | Amazon only | Flipkart only |
| Role | primary — also runs Telegram, alert delivery, housekeeping | secondary — only scrapes |
| Status row | 1 | 2 |
| Scraping config | `config/scraping.local.json` | `config/scraping.flipkart.json` |
| Interval & product limit | Settings → Amazon | Settings → Flipkart |
| Identities, budget, backoff | its own | its own |

Nothing either worker does can reach the other's request budget. Until the
Flipkart worker is running, Flipkart products simply wait: the dashboard says
so, and each shows a *"no Flipkart worker running"* badge.

## 1. Deploy the change on EC2 first

The AWS worker now scrapes Amazon only. Pull and rebuild as usual; the
`migrate` service applies the new migration before anything starts:

```bash
cd ~/ecommerce-scrapper && git pull
docker compose --env-file deploy/.env.aws \
  -f deploy/docker-compose.aws.yml -f deploy/docker-compose.egress.yml up -d --build
```

The worker's first log line now reads
`Worker scope: amazon_in · role primary · status row 1`.

## 2. Open the database tunnel on the home machine

The home worker reaches Postgres over SSH; Postgres stays bound to EC2's
loopback and is never exposed.

```bash
ssh -N -L 15432:127.0.0.1:5432 -i pricepulse.pem ubuntu@<ELASTIC_IP>
```

Keep it running (a terminal, `tmux`, or `autossh -M 0 …` to reconnect on its
own). If it drops, the worker's heartbeat stops and the dashboard shows the
Flipkart scraper as *not reporting*.

## 3. Configure and start the Flipkart worker

```bash
cp deploy/.env.worker.example deploy/.env.worker
```

Fill in `DATABASE_URL` (the password from `deploy/.env.aws`) and
`SETTINGS_ENC_KEY` (byte-identical to the one in `deploy/.env.aws`). Then:

```bash
docker compose --env-file deploy/.env.worker -f deploy/docker-compose.worker.yml up -d --build
docker compose --env-file deploy/.env.worker -f deploy/docker-compose.worker.yml logs -f worker
```

Expect `Worker scope: flipkart · role secondary · status row 2` and
`Telegram bot: handled by the primary worker`.

## 4. Set Flipkart's limits

Dashboard → **Settings** → **Flipkart**:

- **Check interval** — blank means the same as Amazon's.
- **Products checked at once** — blank means every active Flipkart product.
  Start small (say 50) and raise it once the Flipkart scraper panel shows no
  blocks. Highest-priority products are scraped first.

Changes take effect on the next cycle; no restart.

## Sizing

The home line is also your household's own connection to Flipkart. The
worker's budget in `config/scraping.flipkart.json` starts at 3 requests/min and
learns up to 6. At roughly one request per check, that is:

```
products ≈ requests/min × interval(min)
  3/min × 30 min ≈  90 products     6/min × 30 min ≈ 180 products
```

Raise `ipCap.adaptive.maxPerMin` in small steps, a day at a time, watching the
Flipkart panel's block count. Restart the worker after editing the file.

## Before Flipkart prices are trustworthy

A test from a home connection found two Flipkart pipeline issues that are
independent of where the worker runs:

- **Pincode localisation** did not verify for any of 9 products. With a
  delivery pincode set, in-stock Flipkart products fail rather than record an
  unlocalised price.
- **Price parsing** failed on 3 of 9 new phone listings. Laptops looked fine in
  a smaller sample.

Both need fixing before Flipkart reaches Amazon's success rate.
