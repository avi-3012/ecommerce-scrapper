import { gotScraping } from 'got-scraping';
import { scraperProxyUrl } from '../fetch/proxy.js';

/**
 * Flipkart location-aware pricing (pincode). Flipkart's PDP price/stock is
 * derived from the delivery location, which the site resolves via a Google
 * Places + map flow that can't be replayed over stateless HTTP. But the page
 * data itself is fetched from an API that accepts the pincode directly:
 *
 *   POST rome.api.flipkart.com/api/4/page/fetch
 *   { pageUri, locationContext: { pincode, changed: true } }
 *
 * We call that with the configured pincode and read the localized price / MRP /
 * stock from the JSON — no browser, cookies or Google Places needed. Detailed
 * bank offers are NOT in this response, so they keep coming from the HTML page;
 * only price/MRP/stock are overridden.
 */

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** Marker the adapter injects into the HTML so the parser can apply the override. */
export const FLIPKART_PINCODE_MARKER = 'pp-flipkart-pincode';

export interface PincodePricing {
  /** Null when the listing is not buyable — an out-of-stock item has no price. */
  price: number | null;
  mrp: number | null;
  stockStatus: 'in_stock' | 'out_of_stock' | 'unknown';
  pincode: string;
}

/**
 * Flipkart's own buyability verdict for the selected listing, read from the
 * authoritative `pageContext…psi.pls` node.
 *
 * This is what distinguishes "we failed to localize the price" from "there is
 * no price to localize". Flipkart populates the delivery/pincode component
 * ONLY for a buyable listing: an out-of-stock item comes back with
 * `pincodeComponent.value: null`, so the pincode echo we verify against is
 * simply absent — which is a statement about stock, not a scrape failure.
 */
export interface ListingAvailability {
  /** Flipkart's buyability flag for this listing. */
  isAvailable: boolean | null;
  /** IN_STOCK / OUT_OF_STOCK / COMING_SOON / … */
  availabilityStatus: string | null;
  /** Why it isn't buyable, when stated (e.g. "NotAvailable", "OTHERS"). */
  unserviceabilityReason: string | null;
  /** Listing lifecycle, e.g. "current", "comingback". */
  listingState: string | null;
}

const NO_AVAILABILITY: ListingAvailability = {
  isAvailable: null,
  availabilityStatus: null,
  unserviceabilityReason: null,
  listingState: null,
};

const UNBUYABLE_STATUS = /OUT_OF_STOCK|SOLD_OUT|UNSERVICEABLE|COMING_SOON/i;

/** Whether Flipkart says this listing cannot be bought right now. */
export function isUnbuyable(availability: ListingAvailability): boolean {
  if (availability.isAvailable === false) return true;
  return (
    availability.availabilityStatus !== null &&
    UNBUYABLE_STATUS.test(availability.availabilityStatus)
  );
}

/**
 * The full result of a pincode-pricing fetch, including the trail we need for
 * the scrape-audit even when the price is NOT trusted: the HTTP status, the
 * pincode Flipkart actually resolved, and how many attempts we made. `pricing`
 * is non-null only when the resolved pincode matches the one we requested.
 */
export interface PincodeFetchResult {
  pricing: PincodePricing | null;
  status: number | null;
  applied: string | null;
  city: string | null;
  attempts: number;
  /** True only when Flipkart echoed back OUR pincode (the price is location-trusted). */
  verified: boolean;
  /** Flipkart's buyability verdict, whether or not a price was resolved. */
  availability: ListingAvailability | null;
  /** The exact pricing-node fields used and their JSON path (source-of-truth trail). */
  raw: Record<string, unknown> | null;
  /** Buy-box seller the price came from, when identifiable. */
  seller: { id: string | null; name: string | null; count: number | null } | null;
  /** Bounded raw JSON snippet around the pricing node — the source bytes. */
  sample: string | null;
}

/** Detailed pricing extraction: the value plus the raw fields/path it came from. */
export interface ApiPricingDetail {
  price: number;
  mrp: number | null;
  stockStatus: PincodePricing['stockStatus'];
  raw: Record<string, unknown>;
  seller: { id: string | null; name: string | null; count: number | null } | null;
}

type Node = Record<string, unknown>;

/** Parse a page/fetch body once; null when it isn't JSON. */
function parseResponse(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return null;
  }
}

function pageContextOf(root: unknown): Node | undefined {
  const pageData = ((root as Node)?.RESPONSE as Node)?.pageData as Node | undefined;
  return pageData?.pageContext as Node | undefined;
}

function numOf(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return numOf(o.value ?? o.amount ?? o.decimalValue);
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Detailed price/MRP/stock extraction from a page/fetch JSON response, plus the
 * exact source fields and buy-box seller for the audit trail.
 *
 * Reads the AUTHORITATIVE buy-box price for the selected product, not a scan of
 * every finalPrice on the page: the response also carries accessory prices
 * (₹269/₹999, …) and per-variant/EMI figures, and picking among them by
 * heuristic makes the extracted price flap between checks.
 */
export function extractApiPricingDetailed(json: string): ApiPricingDetail | null {
  return pricingDetailOf(parseResponse(json));
}

/**
 * Flipkart's buyability verdict for the selected listing, from
 * `pageContext.fdpEventTracking.events.psi.pls` — the same node the site's own
 * front end uses to decide whether to render a buy button.
 */
export function extractListingAvailability(json: string): ListingAvailability {
  return availabilityOf(parseResponse(json));
}

function availabilityOf(root: unknown): ListingAvailability {
  const events = (pageContextOf(root)?.fdpEventTracking as Node)?.events as Node | undefined;
  const pls = (events?.psi as Node)?.pls as Node | undefined;
  if (!pls) return NO_AVAILABILITY;
  const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return {
    isAvailable: typeof pls.isAvailable === 'boolean' ? pls.isAvailable : null,
    availabilityStatus: str(pls.availabilityStatus),
    unserviceabilityReason: str(pls.unserviceabilityReason),
    listingState: str(pls.listingState),
  };
}

function pricingDetailOf(root: unknown): ApiPricingDetail | null {
  const pageContext = pageContextOf(root);
  if (!pageContext) return null;

  const pricing = pageContext.pricing as Record<string, unknown> | undefined;
  const psi = (
    ((pageContext.fdpEventTracking as Record<string, unknown>)?.events as Record<string, unknown>)
      ?.psi as Record<string, unknown>
  )?.ppd as Record<string, unknown> | undefined;

  // Track which field/path produced the price so the audit shows the source.
  let source: string | null = null;
  let price: number | null = null;
  for (const [candidate, path] of [
    [numOf(pricing?.finalPrice), 'pageContext.pricing.finalPrice'],
    [numOf(pricing?.fsp), 'pageContext.pricing.fsp'],
    [numOf(psi?.finalPrice), 'pageContext…psi.ppd.finalPrice'],
    [numOf(psi?.fsp), 'pageContext…psi.ppd.fsp'],
  ] as Array<[number | null, string]>) {
    if (candidate !== null) {
      price = candidate;
      source = path;
      break;
    }
  }
  if (price === null || price <= 0) return null;

  const rawMrp = numOf(pricing?.mrp) ?? numOf(psi?.mrp);
  const mrp = rawMrp !== null && rawMrp >= price ? rawMrp : null;

  // Stock: Flipkart's own `pls` verdict is authoritative when present. Only when
  // it is absent do we fall back to scanning the product context for an
  // out-of-stock flag. A buyable buy-box price otherwise means in stock
  // (accessories live in slots, not pageContext).
  const availability = availabilityOf(root);
  if (isUnbuyable(availability)) {
    return {
      price,
      mrp,
      stockStatus: 'out_of_stock',
      raw: rawPricingFields(pricing, psi, source),
      seller: extractSeller(pageContext),
    };
  }
  let stock: PincodePricing['stockStatus'] = 'in_stock';
  const findOos = (n: unknown): void => {
    if (stock === 'out_of_stock' || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(findOos);
      return;
    }
    const o = n as Record<string, unknown>;
    if (
      typeof o.availabilityStatus === 'string' &&
      /OUT_OF_STOCK|SOLD_OUT|UNSERVICEABLE|COMING_SOON/i.test(o.availabilityStatus)
    ) {
      stock = 'out_of_stock';
      return;
    }
    for (const k of Object.keys(o)) findOos(o[k]);
  };
  findOos(pageContext);

  return {
    price,
    mrp,
    stockStatus: stock,
    raw: rawPricingFields(pricing, psi, source),
    seller: extractSeller(pageContext),
  };
}

/** The exact pricing-node fields consulted, for the audit's source-of-truth trail. */
function rawPricingFields(
  pricing: Node | undefined,
  psi: Node | undefined,
  source: string | null,
): Record<string, unknown> {
  return {
    source,
    finalPrice: numOf(pricing?.finalPrice),
    fsp: numOf(pricing?.fsp),
    mrp: numOf(pricing?.mrp),
    psiFinalPrice: numOf(psi?.finalPrice),
    psiFsp: numOf(psi?.fsp),
    psiMrp: numOf(psi?.mrp),
  };
}

/** Extract the product price/MRP/stock from a page/fetch JSON response. */
export function extractApiPricing(json: string): Omit<PincodePricing, 'pincode'> | null {
  const detail = extractApiPricingDetailed(json);
  return detail ? { price: detail.price, mrp: detail.mrp, stockStatus: detail.stockStatus } : null;
}

/** Best-effort buy-box seller lookup (id/name/count) for the audit trail. */
function extractSeller(
  pageContext: Record<string, unknown>,
): { id: string | null; name: string | null; count: number | null } | null {
  let found: { id: string | null; name: string | null; count: number | null } | null = null;
  const walk = (n: unknown): void => {
    if (found || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const o = n as Record<string, unknown>;
    if (typeof o.sellerId === 'string' || typeof o.sellerName === 'string') {
      found = {
        id: typeof o.sellerId === 'string' ? o.sellerId : null,
        name: typeof o.sellerName === 'string' ? o.sellerName : null,
        count: numOf(o.sellerCount),
      };
      return;
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(pageContext);
  return found;
}

/** A bounded raw JSON snippet around the pricing node — the source-of-truth bytes. */
function pricingSample(body: string): string | null {
  const idx = body.indexOf('"pricing"');
  if (idx === -1) return null;
  return body.slice(Math.max(0, idx - 40), idx + 600);
}

/**
 * The delivery pincode Flipkart actually RESOLVED for this response (not the one
 * we asked for). It's carried in the "pincode component" — an object holding
 * the pincode alongside seller/city info. Comparing it to our requested pincode
 * lets us detect the rare case where the API returns a 200 but silently used
 * the IP-default location instead of ours.
 */
export function extractAppliedLocation(json: string): {
  pincode: string | null;
  city: string | null;
} {
  return appliedLocationOf(parseResponse(json));
}

function appliedLocationOf(state: unknown): { pincode: string | null; city: string | null } {
  let found: { pincode: string | null; city: string | null } | null = null;
  const walk = (n: unknown): void => {
    if (found !== null || !n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const o = n as Record<string, unknown>;
    if (
      o.pincode !== undefined &&
      (o.sellerCount !== undefined || o.singleSeller !== undefined || o.city !== undefined)
    ) {
      const p = String(o.pincode);
      if (/^\d{6}$/.test(p)) {
        found = { pincode: p, city: typeof o.city === 'string' ? o.city : null };
        return;
      }
    }
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(state);
  return found ?? { pincode: null, city: null };
}

export function extractAppliedPincode(json: string): string | null {
  return extractAppliedLocation(json).pincode;
}

/**
 * Fetch localized price/MRP/stock for a pincode via Flipkart's page/fetch API.
 *
 * Two terminal answers, in this order:
 *  1. The listing is not buyable → an out-of-stock result, WITHOUT requiring the
 *     pincode echo. Flipkart only populates the delivery/pincode component for a
 *     buyable listing, so demanding the echo here would reject a legitimate
 *     out-of-stock observation forever (and auto-pause the product). There is no
 *     price to get wrong, so there is nothing for the echo to protect.
 *  2. The listing IS buyable → the price is trusted only once Flipkart confirms
 *     it applied OUR pincode; otherwise retry, and never record an unverified
 *     price (the proxy exit region varies between checks, which flaps prices).
 */
export async function fetchFlipkartPincodePricing(
  pageUri: string,
  pincode: string,
): Promise<PincodeFetchResult> {
  const proxyUrl = scraperProxyUrl();
  let status: number | null = null;
  let applied: string | null = null;
  let city: string | null = null;
  let raw: Record<string, unknown> | null = null;
  let seller: { id: string | null; name: string | null; count: number | null } | null = null;
  let sample: string | null = null;
  let availability: ListingAvailability | null = null;
  let attempts = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    attempts++;
    try {
      const res = await gotScraping({
        url: 'https://1.rome.api.flipkart.com/api/4/page/fetch?cacheFirst=false',
        method: 'POST',
        timeout: { request: 25_000 },
        throwHttpErrors: false,
        ...(proxyUrl ? { proxyUrl, http2: false } : {}),
        headers: {
          'content-type': 'application/json',
          origin: 'https://www.flipkart.com',
          referer: `https://www.flipkart.com${pageUri}`,
          'x-user-agent': `${UA} FKUA/website/42/website/Desktop`,
        },
        body: JSON.stringify({
          pageUri,
          pageContext: { trackingContext: {} },
          locationContext: { pincode: Number(pincode), changed: true },
        }),
      });
      status = res.statusCode;
      if (res.statusCode === 200) {
        const root = parseResponse(res.body);
        const detail = pricingDetailOf(root);
        // Capture the source-of-truth trail on every 200, even when unverified,
        // so a rejected/flapping check is still fully explainable from the audit.
        if (detail) {
          raw = detail.raw;
          seller = detail.seller;
        }
        sample = pricingSample(res.body) ?? sample;
        const loc = appliedLocationOf(root);
        applied = loc.pincode;
        city = loc.city;
        availability = availabilityOf(root);

        const trail = { status, applied, city, attempts, raw, seller, sample, availability };

        // (1) Not buyable — terminal, and location-independent. Retrying cannot
        // produce a pincode echo Flipkart never sends for an unbuyable listing.
        if (isUnbuyable(availability) || detail?.stockStatus === 'out_of_stock') {
          return {
            ...trail,
            pricing: { price: null, mrp: null, stockStatus: 'out_of_stock', pincode },
            verified: applied === pincode,
          };
        }

        // (2) Buyable — the price counts only once our pincode is confirmed.
        if (detail && applied === pincode) {
          return {
            ...trail,
            pricing: { price: detail.price, mrp: detail.mrp, stockStatus: 'in_stock', pincode },
            verified: true,
          };
        }
      }
    } catch {
      // retry
    }
  }
  return {
    pricing: null,
    status,
    applied,
    city,
    attempts,
    raw,
    seller,
    sample,
    availability,
    verified: false,
  };
}

export function injectPincodePricing(html: string, pricing: PincodePricing): string {
  const json = JSON.stringify(pricing).replace(/</g, '\\u003c');
  return `${html}\n<script type="application/json" id="${FLIPKART_PINCODE_MARKER}">${json}</script>`;
}
