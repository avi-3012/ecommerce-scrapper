-- AlterTable
ALTER TABLE "settings" ADD COLUMN "notification_templates" JSONB NOT NULL DEFAULT '{}';

-- AlterTable
ALTER TABLE "alerts" ADD COLUMN "message" TEXT;
