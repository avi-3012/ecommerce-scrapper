import { gotScraping } from 'got-scraping';
import type { ScrapeDebug, ProxyRequestKind } from '@pricepulse/shared';
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
 * resolution, which never loads a marketplace page.
 */

/**
 * Follow HTTP redirects until the URL is a recognized product listing (per the
 * caller's `isListing` predicate) or redirects stop. Turns short/affiliate
 * links (fkrt.co, amzn.in, amzn.to, pwap.in, bilty.co, dl.flipkart.com, …) into
 * real marketplace URLs for bulk import.
 *
 * It stops the moment the URL recognizes as a listing, so the heavy marketplace
 * page is NEVER downloaded — fast, cheap on bandwidth, and it sidesteps the
 * marketplace anti-bot during resolution. This is the one request path that is
 * not identity-bound: it only ever touches link shorteners, and it stops before
 * the marketplace itself, so there is no session for it to be consistent with.
 * Returns the best-effort final URL (may not be a listing — the caller decides).
 */
export async function resolveListingUrl(
  rawUrl: string,
  isListing: (url: string) => boolean,
  opts: { maxHops?: number; timeoutMs?: number } = {},
): Promise<string> {
  const maxHops = opts.maxHops ?? 6;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  let current = rawUrl;

  for (let hop = 0; hop <= maxHops; hop++) {
    if (isListing(current)) return current;
    let response;
    try {
      response = await gotScraping({
        url: current,
        method: 'GET',
        followRedirect: false,
        throwHttpErrors: false,
        retry: { limit: 0 },
        timeout: { request: timeoutMs },
        headerGeneratorOptions: { devices: ['desktop'], locales: ['en-IN', 'en'] },
      });
    } catch {
      break; // network error while resolving — return best effort
    }
    const status = response.statusCode;
    const raw = response.headers['location'];
    const location = Array.isArray(raw) ? raw[0] : raw;
    if (status >= 300 && status < 400 && location) {
      try {
        current = new URL(location, current).href; // absolutise relative redirects
      } catch {
        break;
      }
      continue;
    }
    break; // not a redirect (200/4xx/5xx) — stop
  }
  return current;
}
