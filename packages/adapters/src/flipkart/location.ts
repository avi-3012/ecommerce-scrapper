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
  const candidates: Array<{ price: number; mrp: number }> = [];
  let stock: PincodePricing['stockStatus'] = 'unknown';
  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const o = n as Record<string, unknown>;
    if (typeof o.availabilityStatus === 'string') {
      if (/IN_STOCK/i.test(o.availabilityStatus)) stock = 'in_stock';
      else if (/OUT_OF_STOCK|SOLD_OUT|UNSERVICEABLE|COMING_SOON/i.test(o.availabilityStatus))
        stock = 'out_of_stock';
    }
    // The product pricing object carries finalPrice AND mrp together.
    const fp = numOf(o.finalPrice);
    const mrp = numOf(o.mrp);
    if (fp !== null && mrp !== null && fp > 0 && mrp >= fp) candidates.push({ price: fp, mrp });
    for (const k of Object.keys(o)) walk(o[k]);
  };
  walk(state);
  if (candidates.length === 0) return null;
  // Largest such pair = the product price (avoids EMI/exchange sub-amounts).
  const best = candidates.reduce((a, b) => (b.price > a.price ? b : a));
  return { price: best.price, mrp: best.mrp, stockStatus: stock };
}

/** Fetch localized price/MRP/stock for a pincode via Flipkart's page/fetch API. */
export async function fetchFlipkartPincodePricing(
  pageUri: string,
  pincode: string,
): Promise<PincodePricing | null> {
  const proxyUrl = scraperProxyUrl();
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
    if (res.statusCode !== 200) return null;
    const pricing = extractApiPricing(res.body);
    return pricing ? { ...pricing, pincode } : null;
  } catch {
    return null;
  }
}

export function injectPincodePricing(html: string, pricing: PincodePricing): string {
  const json = JSON.stringify(pricing).replace(/</g, '\\u003c');
  return `${html}\n<script type="application/json" id="${FLIPKART_PINCODE_MARKER}">${json}</script>`;
}
