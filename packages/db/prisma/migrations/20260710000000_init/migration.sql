-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "marketplace" AS ENUM ('amazon_in', 'flipkart');

-- CreateEnum
CREATE TYPE "product_status" AS ENUM ('active', 'paused_user', 'paused_auto');

-- CreateEnum
CREATE TYPE "stock_status" AS ENUM ('in_stock', 'out_of_stock', 'unknown');

-- CreateEnum
CREATE TYPE "alert_type" AS ENUM ('target_price', 'threshold_drop', 'price_change', 'offer_change', 'back_in_stock', 'auto_paused', 'system_health');

-- CreateEnum
CREATE TYPE "delivery_status" AS ENUM ('pending', 'delivered', 'failed', 'held_quiet_hours');

-- CreateEnum
CREATE TYPE "failure_reason" AS ENUM ('fetch_blocked', 'fetch_timeout', 'http_error', 'parse_failed', 'listing_removed', 'captcha', 'other');

-- CreateEnum
CREATE TYPE "extraction_tier" AS ENUM ('http', 'browser');

-- CreateEnum
CREATE TYPE "priority_tier" AS ENUM ('normal', 'high');

-- CreateEnum
CREATE TYPE "digest_frequency" AS ENUM ('off', 'daily', 'weekly');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "telegram_chat_id" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "products" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "url" TEXT NOT NULL,
    "canonical_url" TEXT NOT NULL,
    "marketplace_product_id" TEXT NOT NULL,
    "display_name" TEXT NOT NULL,
    "image_url" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "notes" TEXT NOT NULL DEFAULT '',
    "target_price" DECIMAL(12,2),
    "drop_threshold_pct" DECIMAL(5,2),
    "status" "product_status" NOT NULL DEFAULT 'active',
    "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
    "linked_product_id" UUID,
    "current_price" DECIMAL(12,2),
    "current_mrp" DECIMAL(12,2),
    "current_discount_pct" DECIMAL(5,2),
    "current_offers" JSONB NOT NULL DEFAULT '[]',
    "current_stock_status" "stock_status" NOT NULL DEFAULT 'unknown',
    "target_crossed" BOOLEAN NOT NULL DEFAULT false,
    "last_checked_at" TIMESTAMPTZ(6),
    "last_success_at" TIMESTAMPTZ(6),
    "last_changed_at" TIMESTAMPTZ(6),
    "next_check_at" TIMESTAMPTZ(6),
    "priority_tier" "priority_tier" NOT NULL DEFAULT 'normal',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "products_pkey" PRIMARY KEY ("id")
);

-- CreateTable
-- HAND-EDITED (ADR-0002): price_history is monthly range-partitioned by
-- checked_at. PostgreSQL requires the partition key in the primary key.
-- There is deliberately NO DEFAULT partition: a missing partition fails
-- inserts loudly rather than silently mis-filing history rows (NFR-2).
CREATE TABLE "price_history" (
    "id" BIGSERIAL NOT NULL,
    "product_id" UUID NOT NULL,
    "checked_at" TIMESTAMPTZ(6) NOT NULL,
    "success" BOOLEAN NOT NULL,
    "price" DECIMAL(12,2),
    "mrp" DECIMAL(12,2),
    "discount_pct" DECIMAL(5,2),
    "offers" JSONB NOT NULL DEFAULT '[]',
    "offers_hash" TEXT,
    "stock_status" "stock_status" NOT NULL DEFAULT 'unknown',
    "failure_reason" "failure_reason",
    "failure_detail" TEXT,
    "extraction_tier" "extraction_tier",
    "duration_ms" INTEGER,

    CONSTRAINT "price_history_pkey" PRIMARY KEY ("id","checked_at")
) PARTITION BY RANGE ("checked_at");

-- Partition-management routine (WP-0.4): creates monthly partitions from the
-- current month through `months_ahead` months out. Idempotent. The worker
-- calls this on a schedule from Milestone 1; the initial call below covers
-- the first months of operation.
CREATE OR REPLACE FUNCTION ensure_price_history_partitions(months_ahead integer DEFAULT 3)
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
    month_start date := date_trunc('month', now())::date;
    part_start  date;
    part_name   text;
    created     integer := 0;
BEGIN
    FOR i IN 0..months_ahead LOOP
        part_start := (month_start + make_interval(months => i))::date;
        part_name  := 'price_history_' || to_char(part_start, 'YYYY_MM');
        IF to_regclass(part_name) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF "price_history" FOR VALUES FROM (%L) TO (%L)',
                part_name,
                part_start,
                (part_start + interval '1 month')::date
            );
            created := created + 1;
        END IF;
    END LOOP;
    RETURN created;
END;
$$;

SELECT ensure_price_history_partitions(3);

-- CreateTable
CREATE TABLE "alerts" (
    "id" UUID NOT NULL,
    "product_id" UUID,
    "user_id" UUID NOT NULL,
    "type" "alert_type" NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "change_pct" DECIMAL(7,2),
    "fired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "channel" TEXT NOT NULL DEFAULT 'telegram',
    "delivery_status" "delivery_status" NOT NULL DEFAULT 'pending',
    "delivery_error" TEXT,
    "delivered_at" TIMESTAMPTZ(6),
    "suppressed_reason" TEXT,

    CONSTRAINT "alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "settings" (
    "user_id" UUID NOT NULL,
    "check_interval_minutes" INTEGER NOT NULL DEFAULT 30,
    "global_drop_threshold_pct" DECIMAL(5,2) NOT NULL DEFAULT 5,
    "consecutive_failure_limit" INTEGER NOT NULL DEFAULT 5,
    "monitoring_paused" BOOLEAN NOT NULL DEFAULT false,
    "alert_target_price" BOOLEAN NOT NULL DEFAULT true,
    "alert_threshold_drop" BOOLEAN NOT NULL DEFAULT true,
    "alert_any_change" BOOLEAN NOT NULL DEFAULT false,
    "alert_offer_change" BOOLEAN NOT NULL DEFAULT true,
    "alert_back_in_stock" BOOLEAN NOT NULL DEFAULT true,
    "cooldown_minutes" INTEGER NOT NULL DEFAULT 0,
    "quiet_hours_start" TEXT,
    "quiet_hours_end" TEXT,
    "quiet_hours_hold_health" BOOLEAN NOT NULL DEFAULT false,
    "digest_frequency" "digest_frequency" NOT NULL DEFAULT 'off',
    "digest_time" TEXT,
    "near_low_threshold_pct" DECIMAL(5,2) NOT NULL DEFAULT 2,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "telegram_bot_token_enc" TEXT,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "settings_pkey" PRIMARY KEY ("user_id")
);

-- CreateTable
CREATE TABLE "import_batches" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "total_rows" INTEGER NOT NULL,
    "imported" INTEGER NOT NULL DEFAULT 0,
    "duplicates" INTEGER NOT NULL DEFAULT 0,
    "invalid" INTEGER NOT NULL DEFAULT 0,
    "row_errors" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_status" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "worker_heartbeat_at" TIMESTAMPTZ(6),
    "last_cycle_started_at" TIMESTAMPTZ(6),
    "last_cycle_ended_at" TIMESTAMPTZ(6),
    "last_cycle_due" INTEGER NOT NULL DEFAULT 0,
    "last_cycle_checked" INTEGER NOT NULL DEFAULT 0,
    "last_cycle_succeeded" INTEGER NOT NULL DEFAULT 0,
    "last_cycle_failed" INTEGER NOT NULL DEFAULT 0,
    "success_rate_7d" DECIMAL(5,2),
    "scraper_health" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "system_status_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "products_linked_product_id_key" ON "products"("linked_product_id");

-- CreateIndex
CREATE INDEX "products_status_next_check_at_idx" ON "products"("status", "next_check_at");

-- CreateIndex
CREATE UNIQUE INDEX "products_user_id_canonical_url_key" ON "products"("user_id", "canonical_url");

-- CreateIndex
CREATE INDEX "price_history_product_id_checked_at_idx" ON "price_history"("product_id", "checked_at");

-- CreateIndex
CREATE INDEX "alerts_user_id_fired_at_idx" ON "alerts"("user_id", "fired_at");

-- CreateIndex
CREATE INDEX "alerts_product_id_fired_at_idx" ON "alerts"("product_id", "fired_at");

-- CreateIndex
CREATE INDEX "alerts_delivery_status_idx" ON "alerts"("delivery_status");

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "products" ADD CONSTRAINT "products_linked_product_id_fkey" FOREIGN KEY ("linked_product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_history" ADD CONSTRAINT "price_history_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "settings" ADD CONSTRAINT "settings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

