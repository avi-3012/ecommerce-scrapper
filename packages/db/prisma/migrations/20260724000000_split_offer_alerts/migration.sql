-- Split the single offer_change alert into offer_added / offer_removed so
-- additions and removals can be toggled and templated independently.

-- New enum values. offer_change is retained for existing rows (never emitted again).
-- ADD VALUE cannot run inside a transaction with other statements on the new value,
-- so the column work below only reads the pre-existing enum values — safe together.
ALTER TYPE "alert_type" ADD VALUE IF NOT EXISTS 'offer_added';
ALTER TYPE "alert_type" ADD VALUE IF NOT EXISTS 'offer_removed';

-- Replace the single offer toggle with two, seeded from the old preference so a
-- user who had offer alerts off keeps both off.
ALTER TABLE "settings" ADD COLUMN "alert_offer_added" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "settings" ADD COLUMN "alert_offer_removed" BOOLEAN NOT NULL DEFAULT true;
UPDATE "settings"
  SET "alert_offer_added" = "alert_offer_change",
      "alert_offer_removed" = "alert_offer_change";
ALTER TABLE "settings" DROP COLUMN "alert_offer_change";
