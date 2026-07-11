# Runbook: Backup & Restore (NFR-9)

**Objectives:** RTO ≤ 4 hours, RPO ≤ 24 hours. Backups are nightly logical dumps
(`pg_dump --format=custom`), 30 daily + 12 monthly retained, with an offsite copy (H-19).

## Backup (automated)

- Cron on the VPS runs [deploy/scripts/backup.sh](../../deploy/scripts/backup.sh) nightly at 02:15 IST.
- The script fails loudly on a suspiciously small dump; cron output goes to `/var/log/pricepulse-backup.log`.
- **Verification duty (maintenance agreement):** check the log weekly; run a rehearsal restore monthly.

## Restore procedure

1. **Stop the applications** (leave the DB up):
   `docker compose --env-file .env.production -f docker-compose.staging.yml stop api worker`
2. **Choose the dump** from `backups/daily/` (or offsite). Confirm its date against the incident time (RPO).
3. **Recreate the database:**
   ```
   docker compose ... exec -T db psql -U $POSTGRES_USER -d postgres \
     -c "DROP DATABASE IF EXISTS ${POSTGRES_DB}_restore" \
     -c "CREATE DATABASE ${POSTGRES_DB}_restore OWNER $POSTGRES_USER"
   docker compose ... exec -T db pg_restore -U $POSTGRES_USER -d ${POSTGRES_DB}_restore --no-owner < dump-file
   ```
4. **Sanity-check the restored data** (row counts, most recent `price_history.checked_at` within RPO):
   `SELECT count(*), max(checked_at) FROM price_history;`
5. **Swap databases:** rename old → `_broken`, restored → live (or point `DATABASE_URL` at the restored DB).
6. **Restart apps** and smoke-check `/api/health`; trigger a test notification.
7. **Record the incident**: what failed, dump used, data window lost.

## Rehearsal restore (monthly, and once during Milestone 2 acceptance — H-20)

Same as above but into `${POSTGRES_DB}_rehearsal` on **staging**, ending at step 4. Log the result.

## What is NOT in backups

- pg-boss queue state (transient by design — pending jobs are re-enqueueable).
- The `.env.*` secret files — keep a secure copy per H-9; without `SETTINGS_ENC_KEY` the stored Telegram token is unrecoverable (re-enter it in Settings after a full-loss restore).
