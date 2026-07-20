-- Per-check scrape audit trail (debugging observability). One row per check,
-- pruned by the worker after a short retention window. Enums already exist.

CREATE TABLE "scrape_audit" (
    "id" BIGSERIAL NOT NULL,
    "product_id" UUID NOT NULL,
    "marketplace" "marketplace" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "success" BOOLEAN NOT NULL,
    "tier" "extraction_tier",
    "failure_reason" "failure_reason",
    "failure_detail" TEXT,
    "duration_ms" INTEGER,
    "name" TEXT,
    "price" DECIMAL(12,2),
    "mrp" DECIMAL(12,2),
    "stock_status" "stock_status",
    "price_source" TEXT,
    "offers_count" INTEGER,
    "offers_hash" TEXT,
    "pincode_requested" TEXT,
    "pincode_applied" TEXT,
    "pincode_verified" BOOLEAN,
    "pincode_api_status" INTEGER,
    "api_price" DECIMAL(12,2),
    "html_price" DECIMAL(12,2),
    "exit_ip" TEXT,
    "proxy_session" TEXT,
    "debug" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "scrape_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "scrape_audit_product_id_created_at_idx" ON "scrape_audit" ("product_id", "created_at");
CREATE INDEX "scrape_audit_created_at_idx" ON "scrape_audit" ("created_at");

ALTER TABLE "scrape_audit"
    ADD CONSTRAINT "scrape_audit_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
