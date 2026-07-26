-- Per-check proxy bandwidth accounting (wire/compressed bytes), for per-product
-- cost attribution. Nullable so historical rows (before instrumentation) are
-- simply blank.
ALTER TABLE "scrape_audit" ADD COLUMN "bytes_wire" INTEGER;
ALTER TABLE "scrape_audit" ADD COLUMN "proxy_requests" INTEGER;
ALTER TABLE "scrape_audit" ADD COLUMN "proxy_retries" INTEGER;
