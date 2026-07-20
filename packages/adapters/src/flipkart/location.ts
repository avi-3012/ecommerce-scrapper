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
  price: number;
  mrp: number | null;
  stockStatus: 'in_stock' | 'out_of_stock' | 'unknown';
  pincode: string;
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
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    return null;
  }
  const pc = ((state as Record<string, unknown>)?.RESPONSE as Record<string, unknown>)?.pageData as
    Record<string, unknown> | undefined;
  const pageContext = pc?.pageContext as Record<string, unknown> | undefined;
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

  // A buyable buy-box price means in stock; only override if the product context
  // explicitly flags otherwise (accessories live in slots, not pageContext).
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
    raw: {
      source,
      finalPrice: numOf(pricing?.finalPrice),
      fsp: numOf(pricing?.fsp),
      mrp: numOf(pricing?.mrp),
      psiFinalPrice: numOf(psi?.finalPrice),
      psiFsp: numOf(psi?.fsp),
      psiMrp: numOf(psi?.mrp),
    },
    seller: extractSeller(pageContext),
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
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    return { pincode: null, city: null };
  }
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
 * Retries a few times: a transient failure here would otherwise let the parser
 * fall back to the IP-default price, and since the proxy IP's region varies
 * between checks that produces flapping price-change alerts.
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
        const detail = extractApiPricingDetailed(res.body);
        // Capture the source-of-truth trail on every 200, even when unverified,
        // so a rejected/flapping check is still fully explainable from the audit.
        if (detail) {
          raw = detail.raw;
          seller = detail.seller;
        }
        sample = pricingSample(res.body) ?? sample;
        // Only trust the price when Flipkart confirms it applied OUR pincode.
        // If the resolved pincode differs (silently used the IP default) — or
        // can't be confirmed — retry; never record an unverified price.
        const loc = extractAppliedLocation(res.body);
        applied = loc.pincode;
        city = loc.city;
        if (detail && applied === pincode) {
          return {
            pricing: {
              price: detail.price,
              mrp: detail.mrp,
              stockStatus: detail.stockStatus,
              pincode,
            },
            status,
            applied,
            city,
            attempts,
            raw,
            seller,
            sample,
          };
        }
      }
    } catch {
      // retry
    }
  }
  return { pricing: null, status, applied, city, attempts, raw, seller, sample };
}

export function injectPincodePricing(html: string, pricing: PincodePricing): string {
  const json = JSON.stringify(pricing).replace(/</g, '\\u003c');
  return `${html}\n<script type="application/json" id="${FLIPKART_PINCODE_MARKER}">${json}</script>`;
}
