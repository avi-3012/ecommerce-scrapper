import type { MarketplaceAdapter } from '@pricepulse/adapters';
import { toCheckError } from '@pricepulse/adapters';
import type { CheckError } from '@pricepulse/adapters';
import type { FetchFn } from '@pricepulse/adapters';
import type { ExtractionTier, ProductSnapshot, ScrapeDebug } from '@pricepulse/shared';

export type CheckOutcome =
  | {
      ok: true;
      snapshot: ProductSnapshot;
      tier: ExtractionTier;
      durationMs: number;
      debug: ScrapeDebug;
    }
  | { ok: false; error: CheckError; tier: ExtractionTier; durationMs: number; debug: ScrapeDebug };

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
  // A single diagnostics sink for the whole check, passed by reference into the
  // adapter so partial progress survives a thrown fetch. Attached to every
  // outcome for the scrape-audit trail.
  const debug: ScrapeDebug = {};

  const tier1 = await attempt(() => fetchAndParse(adapter, canonicalUrl, options.pincode, debug));
  if (tier1.ok) {
    return {
      ok: true,
      snapshot: tier1.value,
      tier: 'http',
      durationMs: Date.now() - started,
      debug,
    };
  }

  if (options.browserFetch && ESCALATABLE.has(tier1.error.reason)) {
    const tier2 = await attempt(async () => {
      // Route the browser fetch THROUGH the adapter, not around it: the adapter
      // fetches the main page with the browser (dodging the tier-1 block) while
      // still applying its location logic (Flipkart page/fetch API, Amazon glow
      // cookie). Calling the browser fetch directly here used to skip that,
      // recording the unlocalised IP-default price and flapping price alerts.
      const page = await adapter.fetch(canonicalUrl, {
        pincode: options.pincode,
        debug,
        pageFetch: options.browserFetch,
      });
      return adapter.parse(page);
    });
    if (tier2.ok) {
      return {
        ok: true,
        snapshot: tier2.value,
        tier: 'browser',
        durationMs: Date.now() - started,
        debug,
      };
    }
    return {
      ok: false,
      error: tier2.error,
      tier: 'browser',
      durationMs: Date.now() - started,
      debug,
    };
  }

  return { ok: false, error: tier1.error, tier: 'http', durationMs: Date.now() - started, debug };
}

async function fetchAndParse(
  adapter: MarketplaceAdapter,
  canonicalUrl: string,
  pincode: string | null | undefined,
  debug: ScrapeDebug,
): Promise<ProductSnapshot> {
  const page = await adapter.fetch(canonicalUrl, { pincode, debug });
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
