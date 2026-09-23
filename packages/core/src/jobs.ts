import { MARKETPLACES } from '@pricepulse/shared';
import type { Marketplace } from '@pricepulse/shared';

/** pg-boss queue names and payloads (web → worker contract, plan §3.6). */
export const JOB_QUEUES = {
  checkProduct: 'check_product',
  checkAll: 'check_all',
  testNotification: 'test_notification',
  /**
   * Registration preview. The API used to fetch the listing itself, which meant
   * two processes scraping the same marketplaces from one IP with two identity
   * pools and two views of the request budget — and, once the API moved to a
   * cloud host, from a datacenter address the marketplaces refuse outright.
   * Preview is now a job: the worker owns every outbound request, wherever the
   * API happens to run.
   */
  previewProduct: 'preview_product',
  /**
   * Bulk-import short-link resolution, for the same reason as `previewProduct`.
   * Following a share link is a request to the marketplace that issued it, so
   * it belongs to the process that owns the identity pool and the IP budget —
   * not to the API, which has neither and was resolving six at a time with
   * freshly generated headers.
   */
  resolveLinks: 'resolve_links',
} as const;

/**
 * Queues that belong to a marketplace. Each is published per marketplace, as
 * `<base>.<marketplace>`, and consumed only by a worker that scrapes it.
 *
 * With two workers on one shared queue, pg-boss hands each job to whichever
 * worker asks first — and an Amazon worker handed a Flipkart check would send
 * it from an address Flipkart refuses, then count the refusal against the
 * budget Amazon runs on. The unsuffixed names in JOB_QUEUES are still consumed
 * by a worker that scrapes every marketplace, so a single-worker deployment
 * behaves exactly as before.
 */
export const MARKETPLACE_QUEUES = {
  checkProduct: JOB_QUEUES.checkProduct,
  previewProduct: JOB_QUEUES.previewProduct,
  resolveLinks: JOB_QUEUES.resolveLinks,
} as const;

export type MarketplaceQueue = (typeof MARKETPLACE_QUEUES)[keyof typeof MARKETPLACE_QUEUES];

/** The queue carrying `base` jobs for one marketplace. */
export function marketplaceQueue(base: MarketplaceQueue, marketplace: Marketplace): string {
  return `${base}.${marketplace}`;
}

/** Every queue name in use, for idempotent creation at startup. */
export function allQueueNames(): string[] {
  return [
    ...Object.values(JOB_QUEUES),
    ...Object.values(MARKETPLACE_QUEUES).flatMap((base) =>
      MARKETPLACES.map((marketplace) => marketplaceQueue(base, marketplace)),
    ),
  ];
}

export interface CheckProductJob {
  productId: string;
}

export interface PreviewProductJob {
  /** Raw user input — a listing URL or a share/short link. */
  url: string;
}

export interface ResolveLinksJob {
  /** Raw URLs from the import file, in file order. */
  urls: string[];
}

export interface ResolveLinksResult {
  /**
   * Index-aligned with the request. An entry is the resolved URL, or null when
   * the link could not be followed (no identity free, blocked, unreachable) —
   * which the caller reports rather than papering over.
   */
  resolved: Array<string | null>;
}
