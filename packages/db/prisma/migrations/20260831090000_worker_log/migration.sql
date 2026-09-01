-- Worker log ring, so worker output can reach the dashboard.
--
-- The worker and the API are separate processes sharing a database and nothing
-- else, so a "download diagnostics" button in the browser can only see worker
-- output if it travels through here. Bounded and pruned by the worker.
CREATE TABLE "worker_log" (
    "id"      BIGSERIAL      NOT NULL,
    "at"      TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level"   TEXT           NOT NULL,
    "message" TEXT           NOT NULL,
    CONSTRAINT "worker_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "worker_log_at_idx" ON "worker_log" ("at");
