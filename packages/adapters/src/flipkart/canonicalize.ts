import type { UrlRecognition } from '../adapter.js';

export const FLIPKART_DOMAINS = ['flipkart.com', 'dl.flipkart.com'] as const;

/** Flipkart item IDs look like itm0123456789abc (16 chars total). */
const ITEM_ID = /\/p\/(itm[0-9a-zA-Z]{13})(?:[/?]|$)/;
/** Product IDs (pid query param) are 16 uppercase alphanumerics. */
const PID = /^[A-Z0-9]{16}$/;

export function extractFlipkartIds(url: URL): { itemId: string; pid: string | null } | null {
  const match = url.pathname.match(ITEM_ID);
  if (!match?.[1]) return null;
  const pidParam = url.searchParams.get('pid');
  return { itemId: match[1], pid: pidParam && PID.test(pidParam) ? pidParam : null };
}

/**
 * Canonical form: https://www.flipkart.com/product/p/{itemId}?pid={PID}
 * (pid retained when present — it selects the exact variant, which matters
 * per BRD R-5; the slug is display-only and dropped).
 *
 * dl.flipkart.com share links redirect to full URLs — resolved by the fetch
 * layer before recognition, as with Amazon short links.
 */
export function recognizeFlipkart(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
  const ids = extractFlipkartIds(url);
  if (!ids) return { kind: 'not_a_listing', marketplace: 'flipkart' };
  const pidSuffix = ids.pid ? `?pid=${ids.pid}` : '';
  return {
    kind: 'listing',
    marketplace: 'flipkart',
    canonicalUrl: `https://www.flipkart.com/product/p/${ids.itemId}${pidSuffix}`,
    productId: ids.pid ?? ids.itemId,
  };
}
