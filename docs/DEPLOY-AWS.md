# Deploying PricePulse on AWS

Everything — dashboard, API, database and scraper — on one EC2 instance,
tuned for **50 products at a 1-minute interval, 24/7**.

## The target, and its arithmetic

```
  50 product page loads/min
+  4 /min   search-page approaches (funnelRatio 0.08 adds one load each)
+  2 /min   Amazon glow-cookie mints (cached 20 min per identity)
= ~56 req/min sustained

vs 48 identities × (60s ÷ 40s average gap) = 72/min pool capacity   → 28% headroom
   each identity therefore makes ~1.0 request/min, which is human pacing
```

`limits.maxProducts: 50` is a **hard cap** — registration refuses the 51st
product, before it costs a single marketplace request. Requests per minute is
`products ÷ interval`, so an uncapped catalogue is an uncapped request rate,
arrived at one harmless-looking product at a time.

Whether an AWS IP is _granted_ 56/min is not knowable from here. Step 8 measures
it.

## Before you start: the one trade-off

The scraper has no proxies. Every request leaves from whatever IP the host has,
and on EC2 that is an **AWS datacenter IP**. AWS publishes its own ranges at
[ip-ranges.amazonaws.com/ip-ranges.json](https://docs.aws.amazon.com/vpc/latest/userguide/aws-ip-ranges.html)
— authoritative, refreshed weekly, and consumed by every anti-bot vendor. So
this address is _known_ to be a datacenter.

Measured from a residential line, this system runs at 93–99%. From an AWS IP,
expect materially more blocking. That is a real cost, accepted deliberately in
exchange for having everything in one place.

At 50 products the target is modest enough to be plausible — this is roughly
1.5× what the residential line was sustaining cleanly, not the 10× that 300
products would have needed.

Two things follow:

1. **Run `ramp` on day one** (step 8). It measures what this IP is actually
   granted instead of trusting a number someone guessed.
2. **If it's worse than you can live with**, `deploy/docker-compose.worker.yml`
   moves the scraper to a residential machine without touching anything else.

The two biggest levers if blocking is too high, in order: turn tiering on
(`tiers.*Multiplier > 1` — stop polling static products at the hot rate), then
turn diurnal pacing on (`diurnal.enabled: true` — stop running flat at 4 a.m.).
Both are in `config/scraping.aws.json`, which is bind-mounted, so it's an edit
plus a worker restart.

## Cost

| Item       | Spec                           | Monthly                                       |
| ---------- | ------------------------------ | --------------------------------------------- |
| EC2        | `t3.medium`, 2 vCPU / 4 GB     | ~$30                                          |
| EBS        | 30 GB gp3                      | ~$2.40 (free tier covers 30 GB for 12 months) |
| Elastic IP | attached to a running instance | free                                          |
| Transfer   | well under 100 GB              | free                                          |

**~$32/month → about 3 months on $100 of credits.**

`t3.medium` rather than `t3.small` because the worker now runs here too: 200
identities, up to 24 concurrent fetches, and a Chromium browser tier. `t3.small`
(2 GB) will work for a small catalogue but will be tight. `t3.micro` is free-tier
eligible and the bootstrap script's 2 GB swap makes it _survivable_, but it is
not a sensible host for the scraper.

To stretch the credits: EBS is free for 30 GB in year one, the Elastic IP is
free while attached, and transfer under 100 GB is free. The instance is the
whole bill, so stopping it overnight halves it.

---

## Part 1 — AWS

### 1. Allocate an Elastic IP

EC2 → Network & Security → **Elastic IPs** → Allocate. You want a fixed address
before pointing DNS at it; without one the public IP changes on every stop/start.

### 2. Launch the instance

EC2 → **Launch instance**

| Field     | Value                                            |
| --------- | ------------------------------------------------ |
| Name      | `pricepulse`                                     |
| AMI       | **Ubuntu Server 24.04 LTS**                      |
| Type      | **t3.medium** — the worker runs here too         |
| Key pair  | create one, download the `.pem`, `chmod 400` it  |
| Storage   | 30 GiB gp3 (free-tier limit; captures live here) |
| User data | paste `deploy/aws/user-data.sh`                  |

**Security group** — create new, with exactly three inbound rules:

| Type  | Port | Source                    |
| ----- | ---- | ------------------------- |
| SSH   | 22   | **My IP** (not 0.0.0.0/0) |
| HTTP  | 80   | Anywhere                  |
| HTTPS | 443  | Anywhere                  |

Postgres is **not** in that list, deliberately. Everything that talks to it runs
on this instance, so it binds to loopback and is never reachable from the
internet. (It is still published on `127.0.0.1:5432`, so `psql` over SSH works
for debugging — and so the scraper can be moved to a home machine later over an
SSH tunnel without changing the compose file.)

Launch, then associate the Elastic IP with the instance.

### 3. Point a domain at it

Add an **A record** for your hostname → the Elastic IP. Caddy needs a real
domain to obtain a certificate. Wait for it to resolve:

```bash
dig +short pricepulse.example.com
```

_No domain?_ You can run HTTP-only on the EC2 DNS name for a test: set
`SITE_HOSTNAME=:80` and `COOKIE_SECURE=false`. Do not leave it that way — login
cookies cross the internet in clear text.

### 4. Configure and start

```bash
ssh -i pricepulse.pem ubuntu@<ELASTIC_IP>

# user-data may still be running on first boot:
sudo tail -f /var/log/cloud-init-output.log     # wait for "user-data finished"

cd ~/pricepulse
cp deploy/.env.aws.example deploy/.env.aws
openssl rand -hex 32      # → JWT_SECRET
openssl rand -hex 32      # → SETTINGS_ENC_KEY
nano deploy/.env.aws      # fill everything, set SITE_HOSTNAME

docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml up -d --build
```

First build takes 5–10 minutes (it compiles the whole monorepo). Then:

```bash
docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml ps
curl -s https://pricepulse.example.com/api/health
```

You want `{"status":"ok","db":"up","workerStale":false}`. All five services —
`db`, `migrate` (exited), `api`, `worker`, `caddy` — should be present.

Check the worker came up with the AWS profile:

```bash
docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml logs worker | head -30
```

The startup banner should read `identities 200`, `per-request rotation`,
`adaptive` budget, and an effective cycle near 1 minute.

---

## Part 2 — first run

### 5. Sign in and configure

Open **https://pricepulse.example.com** and log in with `SEED_USER_EMAIL` /
`SEED_USER_PASSWORD` from `.env.aws`.

Then **Settings**:

| Setting                | Why                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Delivery pincode**   | Both marketplaces price by delivery location. Without it you get the IP-default price, which on an AWS instance is not where you live. Set this first. |
| **Check interval**     | Already 1 minute in the AWS profile.                                                                                                                   |
| **Telegram bot token** | Optional. Needed for alerts and for `/add` from the bot.                                                                                               |
| Quiet hours / cooldown | Optional; stops alert floods.                                                                                                                          |

### 6. Add products — up to 50

- **A few:** Products → Add, paste a listing or share link. The API asks the
  worker to preview it, so this works even though the API itself never scrapes.
- **A list:** **Import**. Upload a CSV/XLSX of URLs. Import never loads a
  marketplace page — it resolves short links and creates products named
  `Awaiting first check — <id>`, which the worker fills in on the first check.

The 51st product is refused with a message saying so. Raise
`limits.maxProducts` in `config/scraping.aws.json` only once `ramp` says the
connection can carry the extra rate.

**Also raise the auto-pause threshold.** Settings → _consecutive failure limit_
is 5 by default: five failed checks in a row and a product pauses itself. During
a rough patch on a datacenter IP that can quietly retire half your catalogue.
With only 50 products, 15–20 is a saner number.

### 7. Watch the Scraper panel

The dashboard has a **Scraper** panel showing the live rate, the learned
ceiling, identities in service, and the block / congestion ratios. It turns
amber on congestion and red on blocks or a backoff pause. This is the fastest
way to see whether the AWS IP is coping.

### 8. Measure the real ceiling — do this on day one

```bash
docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml \
  exec worker node apps/worker/dist/ramp.js --start 10 --step 10 --hold 120 --max 200
```

Walks the request rate up against your real listings, stops at the first hard
block, and reports what survived plus what it implies for products-per-interval.
**This number is the whole ballgame on a datacenter IP** — everything else is a
guess until you have it.

Then check whether your catalogue fits:

```bash
docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml \
  exec worker node apps/worker/dist/cli.js plan
```

```
catalogue        300 products @ 1 min
cost, flat       300.0 req/min
cost, tiered     104.8 req/min
learned ceiling   34.6 req/min
DOES NOT FIT — raise the interval to about 9 min, or shrink the catalogue.
```

If it says DOES NOT FIT, the honest options are a longer interval, fewer
products, or turning tiering back on in `config/scraping.aws.json`.

## When something breaks

**Dashboard → Scraper → Download logs.** One file with the last 1–72 hours:
success rate, every failure with its reason and detail, the audit trail, the
scraper's vitals, and the worker's own console output. That is the file to send
when asking for help.

The endpoint is behind the same login as the rest of the dashboard, so download
it from the browser rather than with `curl` (an unauthenticated request gets a
401, by design — the bundle contains product URLs and failure detail).

Captured response **bodies** are not in it — they are megabytes of HTML and stay
on the instance. Each audit row carries a `capturePath`; to read one:

```bash
cd ~/pricepulse
CMP="docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml"

# List recent captures — each line ends with its capturePath
$CMP exec worker node apps/worker/dist/cli.js failures --n 20
$CMP exec worker node apps/worker/dist/cli.js failures --reason parse_failed

# Pull one out to read in a browser
$CMP exec -T worker sh -c 'gunzip -c /repo/data/identities/<capturePath>' > /tmp/page.html
```

Other useful commands (run from `~/pricepulse`):

```bash
CMP="docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml"

$CMP exec worker node apps/worker/dist/cli.js status   # pool, learned rate, backoff
$CMP exec worker node apps/worker/dist/cli.js plan     # does the catalogue fit?
$CMP exec worker node apps/worker/dist/cli.js banner   # config + effective cycle
$CMP exec worker node apps/worker/dist/ramp.js         # measure the real ceiling
$CMP logs -f worker                                    # live output

$CMP exec worker touch /repo/data/identities/PAUSE     # stop fetching within 5s
$CMP exec worker rm /repo/data/identities/PAUSE        # resume
```

Sample output, so you know what healthy looks like:

```
$ ... cli.js plan
catalogue        33 products @ 1 min
tier mix         10 hot / 9 warm / 14 cold
cost, flat       33.0 req/min  (no tiering)
cost, tiered     13.2 req/min
learned ceiling  17.0 req/min
spendable now     4.0 req/min  (after diurnal pacing)
```

## Operating it

```bash
CMP="docker compose --env-file deploy/.env.aws -f deploy/docker-compose.aws.yml"

$CMP ps                    # all five services
$CMP logs -f api worker    # live output
git pull && $CMP up -d --build    # deploy an update; migrations apply on start
```

**Backups.** A nightly dump at 02:15 is installed by the bootstrap script
(`/etc/cron.d/pricepulse-backup`), keeping 30 daily and 12 monthly copies under
`deploy/backups/`. Check it ran:

```bash
tail -20 /var/log/pricepulse-backup.log
ls -lh ~/pricepulse/deploy/backups/daily | tail -3
```

**Those dumps are on the same EBS volume as the database.** They survive a bad
migration or a dropped table; they do not survive the instance dying. For that,
add an **EBS snapshot schedule** (EC2 → Lifecycle Manager → daily, 7-day
retention) — it is a five-minute setup and covers the case local dumps cannot.

**Resource limits.** Containers are capped for a `t3.medium`: db 768M, api 640M,
worker 1792M, caddy 128M, leaving ~700 MB for the OS. If you resize the
instance, revisit `mem_limit` in the compose file — an unbounded worker
evicting the database is the failure mode these prevent.

**Log rotation.** Docker's default json-file driver is unbounded, which fills
the disk on a 24/7 deployment and then fails every check and every write at
once. All services are capped at 10 MB × 3 files.

**Updating.** `git pull` on the instance, then the rebuild command above.
Migrations apply automatically via the `migrate` service on every start.

---

## If blocking is too high

In order of how much they cost you:

1. **Turn tiering on** — `config/scraping.aws.json`, set `warmMultiplier: 4`,
   `coldMultiplier: 15`. Products whose price has not moved in days stop being
   polled every minute. On a typical catalogue this cuts the request rate ~3×
   and costs almost nothing, because static products had nothing to report.
2. **Turn diurnal pacing on** — `diurnal.enabled: true`. Stops the rate being
   flat at 4 a.m., which is the most machine-like property traffic can have.
3. **Lengthen the interval** — `plan` tells you the number that fits.
4. **Move the worker to a residential machine** —
   `deploy/docker-compose.worker.yml`, and drop `worker` from the AWS stack.
   This is the one that actually changes the ceiling rather than working under it.

The identity pool makes traffic from one IP look like a household. It cannot
make an AWS IP look residential — nothing can, because the address itself is
published as Amazon's own.
