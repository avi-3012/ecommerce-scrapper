import type { UrlRecognition } from '../adapter.js';

export const AMAZON_DOMAINS = ['amazon.in', 'amzn.in'] as const;

const ASIN = '([A-Z0-9]{10})';
/** Path shapes that carry an ASIN, across desktop, mobile, and app-share URLs. */
const ASIN_PATTERNS: RegExp[] = [
  new RegExp(`/dp/${ASIN}(?:[/?]|$)`),
  new RegExp(`/gp/product/${ASIN}(?:[/?]|$)`),
  new RegExp(`/gp/aw/d/${ASIN}(?:[/?]|$)`), // mobile
  new RegExp(`/product/${ASIN}(?:[/?]|$)`),
];

export function extractAsin(url: URL): string | null {
  for (const pattern of ASIN_PATTERNS) {
    const match = url.pathname.match(pattern);
    if (match?.[1]) return match[1];
  }
  // Some share links carry the ASIN as a query parameter
  const fromQuery = url.searchParams.get('asin');
  if (fromQuery && new RegExp(`^${ASIN}$`).test(fromQuery)) return fromQuery;
  return null;
}

/**
 * Canonical form: https://www.amazon.in/dp/{ASIN} — identical for any two
 * links to the same listing regardless of slugs, ref tags, or tracking
 * parameters (the FR-1.5 duplicate-prevention primitive).
 *
 * Note: short links (amzn.in/...) need an HTTP redirect resolution before
 * recognition — the fetch layer resolves them; recognize() sees final URLs.
 */
export function recognizeAmazon(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
  const asin = extractAsin(url);
  if (!asin) return { kind: 'not_a_listing', marketplace: 'amazon_in' };
  return {
    kind: 'listing',
    marketplace: 'amazon_in',
    canonicalUrl: `https://www.amazon.in/dp/${asin}`,
    productId: asin,
  };
}
