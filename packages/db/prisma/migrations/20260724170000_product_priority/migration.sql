-- Per-product list priority: a positive integer, lower = shown first (1 = top).
-- The whole catalogue defaults to 1; raising a product's number sinks it.
ALTER TABLE "products" ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "products" ADD CONSTRAINT "products_priority_positive" CHECK ("priority" > 0);

-- Catalogue ordering (priority first, then a secondary sort).
CREATE INDEX "products_priority_idx" ON "products" ("priority");
