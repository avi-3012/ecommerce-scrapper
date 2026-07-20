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

/** Extract the product price/MRP/stock from a page/fetch JSON response. */
export function extractApiPricing(json: string): Omit<PincodePricing, 'pincode'> | null {
  let state: unknown;
  try {
    state = JSON.parse(json);
  } catch {
    return null;
  }
  // Read the AUTHORITATIVE buy-box price for the selected product, not a scan of
  // every finalPrice on the page: the response also carries accessory prices
  // (₹269/₹999, …) and per-variant/EMI figures, and picking among them by
  // heuristic makes the extracted price flap between checks.
  const pc = ((state as Record<string, unknown>)?.RESPONSE as Record<string, unknown>)?.pageData as
    Record<string, unknown> | undefined;
  const pageContext = pc?.pageContext as Record<string, unknown> | undefined;
  if (!pageContext) return null;

  const pricing = pageContext.pricing as Record<string, unknown> | undefined;
  const psi = (
    ((pageContext.fdpEventTracking as Record<string, unknown>)?.events as Record<string, unknown>)
      ?.psi as Record<string, unknown>
  )?.ppd as Record<string, unknown> | undefined;

  const price =
    numOf(pricing?.finalPrice) ?? numOf(pricing?.fsp) ?? numOf(psi?.finalPrice) ?? numOf(psi?.fsp);
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

  return { price, mrp, stockStatus: stock };
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
): Promise<PincodePricing | null> {
  const proxyUrl = scraperProxyUrl();
  for (let attempt = 0; attempt < 3; attempt++) {
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
      if (res.statusCode === 200) {
        const pricing = extractApiPricing(res.body);
        if (pricing) return { ...pricing, pincode };
      }
    } catch {
      // retry
    }
  }
  return null;
}

export function injectPincodePricing(html: string, pricing: PincodePricing): string {
  const json = JSON.stringify(pricing).replace(/</g, '\\u003c');
  return `${html}\n<script type="application/json" id="${FLIPKART_PINCODE_MARKER}">${json}</script>`;
}
