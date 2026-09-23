import type { Marketplace } from '@pricepulse/shared';

/**
 * A worker is presumed stopped once its heartbeat is this old. Two missed
 * heartbeats at the default 30 s interval plus slack for a slow database.
 */
export const WORKER_STALE_MS = 120_000;

/** The system_status fields that say which worker a row belongs to. */
export interface WorkerRow {
  workerHeartbeatAt: Date | null;
  /** Empty = the worker scrapes every marketplace. */
  marketplaces: readonly Marketplace[];
}

/** Whether the worker that owns `row` scrapes `marketplace`. */
export function coversMarketplace(
  row: Pick<WorkerRow, 'marketplaces'>,
  marketplace: Marketplace,
): boolean {
  return row.marketplaces.length === 0 || row.marketplaces.includes(marketplace);
}

/** Whether the worker that owns `row` has reported recently enough to count. */
export function isWorkerLive(
  row: Pick<WorkerRow, 'workerHeartbeatAt'>,
  now: number = Date.now(),
): boolean {
  return row.workerHeartbeatAt !== null && now - row.workerHeartbeatAt.getTime() <= WORKER_STALE_MS;
}

/**
 * Whether some live worker is scraping `marketplace`. When none is, that
 * marketplace's products wait indefinitely — which looks exactly like a scraper
 * that has silently stopped, unless something says why.
 */
export function marketplaceHasLiveWorker(
  rows: readonly WorkerRow[],
  marketplace: Marketplace,
  now: number = Date.now(),
): boolean {
  return rows.some((row) => isWorkerLive(row, now) && coversMarketplace(row, marketplace));
}
