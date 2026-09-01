import type { MarketplaceAdapter } from '@pricepulse/adapters';
import { classifySnapshot, toCheckError } from '@pricepulse/adapters';
import type { CheckError, FetchFn, IdentitySession } from '@pricepulse/adapters';
import type { ExtractionTier, ProductSnapshot, ScrapeDebug } from '@pricepulse/shared';

/**
 * Every check ends in exactly one of four classifications:
 *
 *   ok         — parsed, and what it says holds together. Record it.
 *   suspect    — parsed, but the numbers don't add up (a title with no price, a
 *                40%+ jump). A flagged session gets served subtly wrong data at
 *                HTTP 200, so this is the only signal that catches it. Do NOT
 *                record; re-ask a different identity later and require agreement.
 *   blocked    — the IP was refused or challenged. Back off; never re-ask now.
 *   error      — an ordinary failure (timeout, listing gone, parse drift).
 */
export type CheckClassification = 'ok' | 'suspect' | 'blocked' | 'error';

export type CheckOutcome =
  | {
      ok: true;
      classification: 'ok';
      snapshot: ProductSnapshot;
      tier: ExtractionTier;
      durationMs: number;
      debug: ScrapeDebug;
    }
  | {
      ok: false;
      classification: 'suspect';
      /** What the page said, kept so a second identity can be asked to confirm it. */
      snapshot: ProductSnapshot;
      suspectReason: string;
      error: CheckError;
      tier: ExtractionTier;
      durationMs: number;
      debug: ScrapeDebug;
    }
  | {
      ok: false;
      classification: 'blocked' | 'error';
      error: CheckError;
      tier: ExtractionTier;
      durationMs: number;
      debug: ScrapeDebug;
    };

export interface PipelineOptions {
  /** Product this check belongs to, recorded alongside a failure capture. */
  productId?: string | null;
  /**
   * The browser identity this check runs as. Required: it owns the headers,
   * the cookie jar, the referer chain and the pacing, and it is the only route
   * an adapter has to the network.
   */
  session: IdentitySession;
  /**
   * Tier-2 fetch (headless browser) bound to the SAME identity's persistent
   * profile. Optional: absent means no escalation.
   */
  browserFetch?: FetchFn;
  /** Delivery pincode for location-aware scraping (threaded from settings). */
  pincode?: string | null;
  /** The last price we accepted for this product, for the 40%-jump check. */
  lastAcceptedPrice?: number | null;
}

/**
 * Failures that justify a browser retry.
 *
 * Blocks are NOT on this list any more, and that is the point. Under rotating
 * proxies, "blocked at tier 1 → try again with a browser" was reasonable: the
 * retry left from a different exit IP. On one ISP line the retry leaves from
 * the same address that was just refused, seconds later — which is not a
 * workaround, it is a second data point confirming we are flagged. Blocks now
 * cool the identity and feed the global backoff instead.
 *
 * `parse_failed` remains: that is a client-rendered page we could not read, and
 * a real browser genuinely can read it.
 */
const ESCALATABLE: ReadonlySet<string> = new Set(['parse_failed']);

/**
 * One check = one outcome, always. This function never throws: every failure
 * path returns a categorised outcome so the caller can keep the
 * guaranteed-history-write contract.
 */
export async function performCheck(
  adapter: MarketplaceAdapter,
  canonicalUrl: string,
  options: PipelineOptions,
): Promise<CheckOutcome> {
  const started = Date.now();
  // A single diagnostics sink for the whole check, passed by reference into the
  // adapter so partial progress survives a thrown fetch. Attached to every
  // outcome for the scrape-audit trail.
  const debug: ScrapeDebug = {};
  debug.identityId = options.session.id;

  const tier1 = await attempt(() => fetchAndParse(adapter, canonicalUrl, options, debug));
  if (tier1.ok) {
    return finish(tier1.value, 'http', started, debug, options);
  }

  if (options.browserFetch && ESCALATABLE.has(tier1.error.reason)) {
    const tier2 = await attempt(async () => {
      // Route the browser fetch THROUGH the adapter, not around it: the adapter
      // fetches the main page with the browser (reading the client-rendered
      // page tier-1 could not) while still applying its location logic
      // (Flipkart page/fetch API, Amazon glow cookie). Calling the browser fetch
      // directly here used to skip that, recording the unlocalised IP-default
      // price and flapping price alerts.
      const page = await adapter.fetch(canonicalUrl, {
        session: options.session,
        pincode: options.pincode,
        debug,
        pageFetch: options.browserFetch,
      });
      return adapter.parse(page);
    });
    if (tier2.ok) {
      return finish(tier2.value, 'browser', started, debug, options);
    }
    return failure(tier2.error, 'browser', started, debug, options);
  }

  return failure(tier1.error, 'http', started, debug, options);
}

/**
 * Turn a parsed snapshot into an outcome, applying the suspicion checks that a
 * clean HTTP 200 cannot rule out on its own.
 */
function finish(
  snapshot: ProductSnapshot,
  tier: ExtractionTier,
  started: number,
  debug: ScrapeDebug,
  options: PipelineOptions,
): CheckOutcome {
  const verdict = classifySnapshot({
    name: snapshot.name,
    price: snapshot.price,
    lastAcceptedPrice: options.lastAcceptedPrice ?? null,
    outOfStock: snapshot.stockStatus === 'out_of_stock',
  });
  const durationMs = Date.now() - started;

  if (verdict.classification === 'suspect') {
    debug.classification = 'suspect';
    debug.classificationReason = verdict.reason;
    // A suspect page is exactly the one worth keeping: it parsed, so it is not
    // an obvious block, and something about it is still wrong.
    debug.capturePath = options.session.captureLastResponse(
      `suspect_${verdict.reason}`,
      verdict.detail,
      options.productId,
    );
    options.session.noteSuspect();
    return {
      ok: false,
      classification: 'suspect',
      snapshot,
      suspectReason: verdict.reason,
      error: toCheckError(new Error(verdict.detail)),
      tier,
      durationMs,
      debug,
    };
  }

  debug.classification = 'ok';
  return { ok: true, classification: 'ok', snapshot, tier, durationMs, debug };
}

function failure(
  error: CheckError,
  tier: ExtractionTier,
  started: number,
  debug: ScrapeDebug,
  options: PipelineOptions,
): CheckOutcome {
  const blocked = error.reason === 'fetch_blocked' || error.reason === 'captcha';
  debug.classification ??= blocked ? 'hard_block' : 'error';
  // Keep the bytes for EVERY failed check, not just blocks. A parse failure is
  // the case where the response is most needed and least reproducible: asking
  // the marketplace again to see what it sent is both slow and, on a flagged
  // IP, actively harmful. A block was already captured at fetch time.
  debug.capturePath ??= blocked
    ? null
    : options.session.captureLastResponse(error.reason, error.message, options.productId);
  // A page we could not read is counted separately from congestion: it may be
  // our parser, and throttling the connection would fix nothing while hiding it.
  if (error.reason === 'parse_failed') options.session.noteUnreadable();
  return {
    ok: false,
    classification: blocked ? 'blocked' : 'error',
    error,
    tier,
    durationMs: Date.now() - started,
    debug,
  };
}

async function fetchAndParse(
  adapter: MarketplaceAdapter,
  canonicalUrl: string,
  options: PipelineOptions,
  debug: ScrapeDebug,
): Promise<ProductSnapshot> {
  const page = await adapter.fetch(canonicalUrl, {
    session: options.session,
    pincode: options.pincode,
    debug,
  });
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
