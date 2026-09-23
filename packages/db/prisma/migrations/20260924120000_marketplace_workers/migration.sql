-- A worker per marketplace.
--
-- Flipkart gets its own check interval and product limit. Amazon's existing
-- fields keep exactly their current meaning, so this changes nothing for Amazon
-- until someone edits the new Flipkart fields. Both start NULL: interval falls
-- back to Amazon's, and capacity means "no limit".
ALTER TABLE "settings" ADD COLUMN "flipkart_check_interval_minutes" INTEGER;
ALTER TABLE "settings" ADD COLUMN "flipkart_scrape_capacity" INTEGER;

-- Each worker owns a system_status row. Row 1 is the primary and keeps its
-- data; the empty array marks it as covering every marketplace until the
-- worker next reports its scope.
ALTER TABLE "system_status" ADD COLUMN "marketplaces" "marketplace"[] NOT NULL DEFAULT ARRAY[]::"marketplace"[];
