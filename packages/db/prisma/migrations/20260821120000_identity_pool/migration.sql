-- Identity pool migration: residential proxies are gone; all traffic now leaves
-- from this machine's own ISP connection as one of a small pool of synthetic
-- browser identities.
--
-- What a fetch is attributed to changes accordingly. There is no longer an exit
-- node to name, so `exit_ip` and `proxy_session` are replaced by `identity_id`
-- — which browser persona made the request — plus how the response was
-- classified, which is the signal the IP-level backoff runs on.

-- One row per check: which identity observed this price.
ALTER TABLE "price_history" ADD COLUMN "identity_id" TEXT;

-- Per-check diagnostics trail.
ALTER TABLE "scrape_audit" ADD COLUMN "identity_id" TEXT;
ALTER TABLE "scrape_audit" ADD COLUMN "classification" TEXT;
ALTER TABLE "scrape_audit" ADD COLUMN "classification_reason" TEXT;

-- The proxy-era attribution columns. Historical rows keep their values by being
-- migrated into the identity column where they carry meaning: a stored proxy
-- session is the closest thing the old rows have to "who was this", so it is
-- preserved with a `proxy:` prefix rather than dropped on the floor.
UPDATE "scrape_audit"
   SET "identity_id" = 'proxy:' || "proxy_session"
 WHERE "proxy_session" IS NOT NULL;

ALTER TABLE "scrape_audit" DROP COLUMN "exit_ip";
ALTER TABLE "scrape_audit" DROP COLUMN "proxy_session";

-- "Show me everything one identity did" is the query the status command and any
-- block post-mortem run first.
CREATE INDEX "scrape_audit_identity_id_created_at_idx"
    ON "scrape_audit" ("identity_id", "created_at");
