# Deploying PricePulse to Render

PricePulse ships as a [Render Blueprint](../render.yaml): one PostgreSQL database, the **API** web
service (which also serves the dashboard), and the always-on **worker**. Both services build from a
single Docker image ([deploy/Dockerfile.render](../deploy/Dockerfile.render)) based on the official
Playwright image, so the tier-2 browser fallback (Flipkart / anti-bot pages) works in production.

---

## What you need first

- A **Render account** with a payment method (the worker is a background service — Render has no
  free tier for those; it needs at least a Starter instance).
- This repository pushed to a **GitHub/GitLab** repo Render can access.
- Two secrets you generate yourself (below).

## One-time: generate the secrets

```bash
# Encryption key for the Telegram token at rest — must be 32 bytes hex (64 chars).
openssl rand -hex 32        # → SETTINGS_ENC_KEY

# Choose a strong login password for the single app account.
# → SEED_USER_PASSWORD
```

`JWT_SECRET` is generated automatically by Render (`generateValue`), so you don't set it.

---

## Deploy steps

1. **Push the repo** (including `render.yaml`, `deploy/Dockerfile.render`, `.dockerignore`).
2. In the Render dashboard: **New ▸ Blueprint**, pick this repo. Render reads `render.yaml` and shows
   the DB + two services it will create.
3. Render prompts for the values marked `sync: false`:
   - **SETTINGS_ENC_KEY** (the `pricepulse-shared` env group) — paste the `openssl rand -hex 32`
     value. It's shared to both services automatically.
   - **SEED_USER_EMAIL** (API) — the email you'll log in with.
   - **SEED_USER_PASSWORD** (API) — the password from above.
4. **Apply**. Render provisions the database, builds the image, runs the API's pre-deploy command
   (`prisma migrate deploy` + seed), then starts both services.
5. Open the API service URL. The dashboard loads; sign in with the seed email/password.

That's it. The `render.yaml` wires `DATABASE_URL` from the managed database into both services, so
there's nothing else to connect.

---

## After it's live

- **Telegram:** the app deploys without a bot token (alerts record but show "delivery failed"). To
  enable delivery, open **Settings ▸ Telegram** in the dashboard, paste your BotFather token, and
  send `/start` to the bot to bind the chat. (Stored encrypted with `SETTINGS_ENC_KEY`.)
- **First run:** on the very first deploy the worker may log a few DB errors for up to a minute while
  the API's pre-deploy migration/seed finishes — it self-recovers, no action needed.
- **Add products** by URL or bulk import as usual; the worker begins checking on its schedule.

## Operational notes

- **Migrations** run automatically on every deploy via the API `preDeployCommand`. New migrations you
  add to `packages/db/prisma/migrations` apply on the next deploy. `price_history` partitions are
  created by the migration and topped up daily by the worker.
- **Region** is set to `singapore` (closest Render region to India and the marketplaces). Change it
  in `render.yaml` if you prefer another — keep the DB and both services in the same region so
  `DATABASE_URL` uses the fast internal network.
- **Database plan** is `free` in the blueprint (a 30-day trial DB). For anything beyond evaluation,
  change `databases[0].plan` to a paid tier (e.g. `basic-256mb`) before it expires — back up first
  per [docs/runbooks/backup-restore.md](runbooks/backup-restore.md).
- **Cost shape:** managed Postgres + one Starter web (API) + one Starter worker. The API could run on
  a free web instance if you accept cold starts, but the worker must stay paid/always-on for
  monitoring to run continuously (NFR-1).
- **Scaling:** keep the worker at **one instance** — the scheduler assumes a single monitor loop.
  Scale the API independently if dashboard traffic ever needs it.
- **Backups:** Render's managed Postgres has its own backups on paid plans; the app's own
  `pg_dump` script ([deploy/scripts/backup.sh](../deploy/scripts/backup.sh)) is for the self-hosted
  VPS path and isn't needed on Render.

## Updating

Push to the deployment branch → Render rebuilds the image, runs pre-deploy migrations, and rolls both
services. To roll back, use **Manual Deploy ▸ redeploy a previous commit** in the dashboard.
