import type { MarketplaceAdapter } from '@pricepulse/adapters';
import { toCheckError } from '@pricepulse/adapters';
import type { CheckError } from '@pricepulse/adapters';
import type { FetchFn } from '@pricepulse/adapters';
import type { ExtractionTier, ProductSnapshot } from '@pricepulse/shared';

export type CheckOutcome =
  | { ok: true; snapshot: ProductSnapshot; tier: ExtractionTier; durationMs: number }
  | { ok: false; error: CheckError; tier: ExtractionTier; durationMs: number };

export interface PipelineOptions {
  /**
   * Tier-2 fetch (headless browser). Optional: absent means no escalation
   * (H-13 documents enabling Playwright where the worker runs).
   */
  browserFetch?: FetchFn;
  /** Delivery pincode for location-aware scraping (threaded from settings). */
  pincode?: string | null;
}

/** Tier-1 outcomes that justify a browser retry (WP-1.4 escalation policy). */
const ESCALATABLE: ReadonlySet<string> = new Set(['fetch_blocked', 'captcha', 'parse_failed']);

/**
 * One check = one outcome, always (WP-1.4). This function never throws:
 * every failure path returns a categorised outcome so the caller can keep
 * the guaranteed-history-write contract.
 */
export async function performCheck(
  adapter: MarketplaceAdapter,
  canonicalUrl: string,
  options: PipelineOptions = {},
): Promise<CheckOutcome> {
  const started = Date.now();

  const tier1 = await attempt(() => fetchAndParse(adapter, canonicalUrl, options.pincode));
  if (tier1.ok) {
    return { ok: true, snapshot: tier1.value, tier: 'http', durationMs: Date.now() - started };
  }

  if (options.browserFetch && ESCALATABLE.has(tier1.error.reason)) {
    const tier2 = await attempt(async () => {
      const page = await options.browserFetch!(canonicalUrl);
      return adapter.parse({ ...page, tier: 'browser' });
    });
    if (tier2.ok) {
      return { ok: true, snapshot: tier2.value, tier: 'browser', durationMs: Date.now() - started };
    }
    return { ok: false, error: tier2.error, tier: 'browser', durationMs: Date.now() - started };
  }

  return { ok: false, error: tier1.error, tier: 'http', durationMs: Date.now() - started };
}

async function fetchAndParse(
  adapter: MarketplaceAdapter,
  canonicalUrl: string,
  pincode?: string | null,
): Promise<ProductSnapshot> {
  const page = await adapter.fetch(canonicalUrl, { pincode });
  return adapter.parse(page);
}

async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; error: CheckError }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    return { ok: false, error: toCheckError(err) };
  }
}
