/**
 * Per-check diagnostic trail (auditing / debugging). A mutable sink threaded
 * through the fetch pipeline: adapters write the decisions they make while
 * resolving a price so we can later explain WHY a recorded price was what it
 * was — WITHOUT re-scraping. The goal is source-of-truth credibility: from one
 * audit row you can reconstruct which browser identity the check used, the
 * pincode requested vs actually applied, every price signal seen (page JSON-LD,
 * embedded JSON, the localized API, and the raw API bytes), which one won, and
 * whether the page even described the product we expected.
 *
 * Nothing here is load-bearing; it is best-effort observability only.
 */

/** One price signal observed during a check, with where it came from. */
export interface PriceCandidate {
  /** e.g. 'jsonld' | 'embedded-json' | 'price-element' | 'pincode-api'. */
  source: string;
  value: number | null;
}

/**
 * Which request a byte tally belongs to. `warmup` and `noise` are the identity
 * layer's non-product page loads — a fresh identity's first homepage visit, and
 * the occasional homepage/search browse that keeps the traffic from being 100%
 * product detail pages.
 */
export type ProxyRequestKind =
  | 'main_page' // the listing page fetch (tier-1 HTTP or tier-2 browser)
  | 'pincode_api' // Flipkart page/fetch localisation calls
  | 'cookie_mint' // Amazon glow-location cookie mint (seed page)
  | 'side_sheet' // Amazon offer side-sheet AJAX
  | 'warmup' // an identity's first homepage visit to a site
  | 'noise' // a homepage/search browse in place of a product fetch
  | 'resolve'; // short-link redirect resolution

/**
 * Per-check bandwidth tally — wire (compressed) bytes actually transferred.
 * Since the proxy layer was removed these are ISP bytes rather than billed
 * proxy bytes, but per-product attribution is still the number that answers
 * "which products are expensive to watch", so the accounting stays.
 */
export interface ProxyUsage {
  /** Total compressed bytes fetched this check. */
  wireBytes: number;
  /** Number of requests made. */
  requests: number;
  /** How many of those were retries (localisation/cookie re-attempts). */
  retries: number;
  /** Breakdown by request kind. */
  byKind: Partial<Record<ProxyRequestKind, { wireBytes: number; requests: number }>>;
}

export interface ScrapeDebug {
  /** Per-check bandwidth (wire bytes), for cost attribution per product. */
  proxy?: ProxyUsage;
  /**
   * Which synthetic browser identity made this check. The successor to the
   * proxy session token: with one IP there is no exit node to identify, so the
   * question "what did the marketplace think it was talking to" is answered
   * entirely by the identity — its headers, cookie jar and referer chain.
   */
  identityId?: string | null;
  /** How the raw response was classified: ok | suspect | hard_block. */
  classification?: string | null;
  /** Why, when the classification was not `ok` (e.g. 'amazon_captcha'). */
  classificationReason?: string | null;
  /**
   * Where the full response body was written when this check failed, relative
   * to IDENTITY_DIR (e.g. `failures/2026-08-27/…-parse_failed-1a2b3c4d.html.gz`).
   * The bytes live on disk rather than in this blob — an Amazon page is ~2 MB,
   * which is not something to put in a JSON column.
   */
  capturePath?: string | null;
  /** The delivery pincode we asked the marketplace to price for (null = none set). */
  pincodeRequested?: string | null;

  /** The main product-page fetch (before any localized-price override). */
  fetch?: {
    /** Final URL after redirects — reveals a variant/product swap. */
    finalUrl?: string | null;
    /** Response body size in bytes — a tiny body signals a block/interstitial. */
    bodyBytes?: number | null;
    /** Which tier fetched the page. */
    tier?: string | null;
  };

  /** Every price signal seen this check, for divergence analysis. */
  priceCandidates?: PriceCandidate[];
  /** Full field→strategy provenance map from the parser (name/price/mrp/stock…). */
  provenance?: Record<string, string>;
  /** The product name the page returned — detects variant/redirect swaps. */
  name?: string | null;
  /** Offers seen this check (for offer_change flapping). */
  offers?: { count?: number; hash?: string | null; items?: string[] };

  /** Flipkart page/fetch API pincode-pricing trail. */
  pincode?: {
    /** HTTP status of the last page/fetch call. */
    apiStatus?: number | null;
    /** The pincode Flipkart actually resolved for the response. */
    applied?: string | null;
    /** Resolved delivery city, when present. */
    city?: string | null;
    /** True when applied === requested and a price was extracted (trusted). */
    verified?: boolean;
    /** Price the API returned for our pincode (rupees). */
    apiPrice?: number | null;
    /** MRP the API returned. */
    apiMrp?: number | null;
    /** Number of API attempts made. */
    attempts?: number;
    /** The exact pricing node fields used (finalPrice/fsp/mrp) and their path. */
    raw?: Record<string, unknown> | null;
    /** Buy-box seller the price came from, when identifiable. */
    seller?: { id?: string | null; name?: string | null; count?: number | null } | null;
    /** Bounded raw JSON snippet around the pricing node — the source-of-truth bytes. */
    sample?: string | null;
    /**
     * Flipkart's own buyability verdict for the listing. When it says the item
     * is unbuyable the pincode echo is absent BY DESIGN, so the check is
     * recorded as out-of-stock instead of demanding verification.
     */
    availability?: {
      isAvailable?: boolean | null;
      availabilityStatus?: string | null;
      unserviceabilityReason?: string | null;
      listingState?: string | null;
    } | null;
    /**
     * The pincode component's error code (e.g. "NO_SERVICEABLE_SELLER"). Set
     * when Flipkart resolved the pincode but priced the listing from a seller
     * that does not deliver there — the response is rejected and retried.
     */
    locationErrorCode?: string | null;
    /** Whether this check resolved to out-of-stock (no price recorded). */
    outOfStock?: boolean;
  };

  /** Amazon glow-location trail. */
  amazon?: {
    /** Whether the fetched page reflected our pincode. */
    locationApplied?: boolean;
    /** Number of cookie-mint + refetch attempts made. */
    attempts?: number;
    /** The delivery location string the page actually showed (glow ingress). */
    resolvedLocation?: string | null;
    /**
     * Item-level out-of-stock, which is location-independent — the reason a
     * check may be accepted without the pincode having been applied.
     */
    outOfStock?: boolean;
  };

  /** Free-form notes an adapter can add for context. */
  notes?: string[];
}
