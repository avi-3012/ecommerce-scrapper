import type { ExtractionTier, Marketplace, ProductSnapshot, ScrapeDebug } from '@pricepulse/shared';

/** Per-check fetch options threaded from user settings. */
export interface FetchOptions {
  /** Delivery pincode for location-aware scraping (Amazon localises by it). */
  pincode?: string | null;
  /**
   * Optional mutable diagnostics sink. When present, the adapter records its
   * price-resolution decisions here (pincode requested/applied, API vs HTML
   * price, proxy session) for the per-check audit trail. Never load-bearing.
   */
  debug?: ScrapeDebug;
}

/** A fetched listing page before parsing. */
export interface RawPage {
  url: string;
  body: string;
  tier: ExtractionTier;
  fetchedAt: Date;
}

/**
 * The result of URL recognition. `unsupported` = no adapter matches the domain
 * (FR-1.2 rejection); `not_a_listing` = a supported marketplace but not a
 * product page (distinct rejection per Milestone 1 doc, WP-1.1).
 */
export type UrlRecognition =
  | { kind: 'listing'; marketplace: Marketplace; canonicalUrl: string; productId: string }
  | { kind: 'not_a_listing'; marketplace: Marketplace }
  | { kind: 'unsupported'; detectedSite: string | null };

/**
 * The plugin boundary of NFR-8: all marketplace-specific knowledge lives
 * behind this interface. Everything else in the system depends only on it
 * and on the normalized ProductSnapshot.
 *
 * Phase 0 ships the contract; Milestone 1 (WP-1.1–1.3) ships the framework
 * internals and the Amazon India / Flipkart implementations.
 */
export interface MarketplaceAdapter {
  readonly marketplace: Marketplace;
  /** Domains (and short-link domains) this adapter claims. */
  readonly domains: readonly string[];

  /** Recognise and canonicalise a URL that belongs to this adapter's domains. */
  recognize(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }>;

  /** Fetch the listing page (tier-1 HTTP; tier-2 escalation handled by the pipeline). */
  fetch(canonicalUrl: string, opts?: FetchOptions): Promise<RawPage>;

  /** Parse a fetched page into the normalized snapshot; throws a categorised error on failure. */
  parse(page: RawPage): ProductSnapshot;
}
