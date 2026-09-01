-- Failure capture: point an audit row at the full response body that caused it.
--
-- The bytes themselves are gzipped to disk under IDENTITY_DIR/failures/, not
-- stored here — an Amazon product page is roughly 2 MB of HTML, which is not a
-- database column and would make `debug` unqueryable. This is the join key.
ALTER TABLE "scrape_audit" ADD COLUMN "capture_path" TEXT;
