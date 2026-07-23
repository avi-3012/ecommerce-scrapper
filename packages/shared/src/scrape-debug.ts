/**
 * Per-check diagnostic trail (auditing / debugging). A mutable sink threaded
 * through the fetch pipeline: adapters write the decisions they make while
 * resolving a price so we can later explain WHY a recorded price was what it
 * was — WITHOUT re-scraping. The goal is source-of-truth credibility: from one
 * audit row you can reconstruct the exit IP the check used, the pincode
 * requested vs actually applied, every price signal seen (page JSON-LD,
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

export interface ScrapeDebug {
  /** Proxy region/sticky-session token in effect (never credentials). */
  proxySession?: string | null;
  /**
   * The ACTUAL outbound IP this check used (resolved through the same proxy
   * session). The sticky-session token is fixed, but the exit IP rotates and
   * its region drives Flipkart's IP-default price — so this is the field that
   * proves (or disproves) region-based price flapping.
   */
  exitIp?: string | null;
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
