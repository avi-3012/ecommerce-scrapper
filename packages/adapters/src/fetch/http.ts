import type { Marketplace, ScrapeDebug, ProxyRequestKind } from '@pricepulse/shared';
import type { RawPage } from '../adapter.js';

export interface HttpFetchOptions {
  timeoutMs?: number;
  /** Extra request headers, merged over the identity's stored headers (e.g. XHR headers for AJAX endpoints). */
  headers?: Record<string, string>;
  /** Bandwidth-accounting sink + label for this request (optional). */
  debug?: ScrapeDebug;
  kind?: ProxyRequestKind;
}

export type FetchFn = (url: string, options?: HttpFetchOptions) => Promise<RawPage>;

/**
 * Marketplace page fetches do NOT live here any more.
 *
 * Every request to amazon.in / flipkart.com now goes out as a specific browser
 * identity — see `identity/session.ts`. A `FetchFn` is obtained from an
 * `IdentitySession`, which owns the stored headers, the cookie jar, the referer
 * chain, the pacing and the IP-level caps. There is deliberately no
 * module-level default fetch left: an anonymous marketplace request with
 * freshly generated headers is precisely the pattern this layer replaced.
 *
 * What remains here is the `FetchFn` contract itself, plus short-link
 * resolution — which does not fetch anything on its own either. It walks
 * redirects through a transport the CALLER supplies, so the request goes out as
 * a real identity wherever one is available.
 */

/**
 * One resolution hop: a GET that does NOT follow redirects, reporting the
 * status and `Location` it saw. Injected rather than implemented here, because
 * who makes the request — and under whose pacing and budget — is the caller's
 * decision, not this module's.
 */
export type ResolveHop = (
  url: string,
  timeoutMs: number,
) => Promise<{ statusCode: number; location?: string }>;

/** Short-link hosts each marketplace operates itself. */
const OPERATED_SHORTLINKS: ReadonlyArray<[Marketplace, readonly string[]]> = [
  ['amazon_in', ['amzn.in', 'amzn.to', 'a.co']],
  ['flipkart', ['fkrt.co', 'fkrt.it', 'dl.flipkart.com']],
];

/**
 * Which marketplace runs this short-link host, or null for a third-party
 * shortener (pwap.in, bilty.co, bit.ly, …).
 *
 * The distinction decides which identity should follow the link. `fkrt.co` is
 * Flipkart's own infrastructure: a request to it is a request to Flipkart, it
 * sets Flipkart cookies, and it counts against whatever budget Flipkart is
 * granting this address. Resolving it as a stranger — fresh headers, no jar,
 * unpaced — is the same mistake as fetching a product page that way.
 */
export function shortLinkMarketplace(url: string): Marketplace | null {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
  for (const [marketplace, hosts] of OPERATED_SHORTLINKS) {
    if (hosts.some((h) => host === h || host.endsWith(`.${h}`))) return marketplace;
  }
  return null;
}

/**
 * Follow HTTP redirects until the URL is a recognized product listing (per the
 * caller's `isListing` predicate) or redirects stop. Turns short/affiliate
 * links (fkrt.co, amzn.in, amzn.to, pwap.in, bilty.co, dl.flipkart.com, …) into
 * real marketplace URLs.
 *
 * It stops the moment the URL recognizes as a listing, so the heavy marketplace
 * page is NEVER downloaded — fast, and cheap on bandwidth. What it does NOT do
 * is avoid the marketplace: most share links are marketplace-operated hosts,
 * which is why `hop` is required rather than defaulted. There is no anonymous
 * fallback here on purpose — a caller with no identity to spend must decline to
 * resolve, not quietly resolve as a stranger.
 *
 * Returns the best-effort final URL (may not be a listing — the caller decides).
 */
export async function resolveListingUrl(
  rawUrl: string,
  isListing: (url: string) => boolean,
  opts: { hop: ResolveHop; maxHops?: number; timeoutMs?: number },
): Promise<string> {
  const maxHops = opts.maxHops ?? 6;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let current = rawUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    if (isListing(current)) return current;
    let result;
    try {
      result = await opts.hop(current, timeoutMs);
    } catch {
      break; // network error while resolving — return best effort
    }
    if (result.statusCode >= 300 && result.statusCode < 400 && result.location) {
      try {
        current = new URL(result.location, current).href; // absolutise relative redirects
      } catch {
        break;
      }
      continue;
    }
    break; // not a redirect (200/4xx/5xx) — stop
  }
  return current;
}
