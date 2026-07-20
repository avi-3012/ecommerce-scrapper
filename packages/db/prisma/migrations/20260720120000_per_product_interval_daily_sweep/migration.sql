-- AlterTable
ALTER TABLE "products" ADD COLUMN "check_interval_minutes" INTEGER;

-- AlterTable
ALTER TABLE "settings" ADD COLUMN "daily_check_time" TEXT;

-- AlterTable
ALTER TABLE "system_status" ADD COLUMN "last_daily_sweep_at" TIMESTAMPTZ(6);
