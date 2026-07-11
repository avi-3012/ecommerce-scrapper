-- Milestone 3 additive migration (ADR-0002 discipline):
-- 1. 'suppressed' delivery status for cooldown-withheld alerts (WP-3.1) —
--    still recorded, delivery withheld; never silently dropped.
ALTER TYPE "delivery_status" ADD VALUE IF NOT EXISTS 'suppressed';

-- 2. Deal-quality context columns, maintained incrementally (FR-5.5).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "all_time_low" DECIMAL(12,2);
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "all_time_high" DECIMAL(12,2);

-- 3. Digest bookkeeping (FR-3.10).
ALTER TABLE "system_status" ADD COLUMN IF NOT EXISTS "last_digest_at" TIMESTAMPTZ(6);

-- Backfill low/high from existing history (successful checks only).
UPDATE "products" p SET
  "all_time_low"  = s.lo,
  "all_time_high" = s.hi
FROM (
  SELECT product_id, min(price) AS lo, max(price) AS hi
  FROM "price_history" WHERE success AND price IS NOT NULL GROUP BY product_id
) s
WHERE s.product_id = p.id;
