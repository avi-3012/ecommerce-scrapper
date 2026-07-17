import { gotScraping } from 'got-scraping';
import type { RawPage } from '../adapter.js';
import { CheckError } from '../errors.js';
import { scraperProxyUrl } from './proxy.js';

export interface HttpFetchOptions {
  timeoutMs?: number;
  /** Extra request headers, merged over the generated browser headers (e.g. XHR headers for AJAX endpoints). */
  headers?: Record<string, string>;
}

export type FetchFn = (url: string, options?: HttpFetchOptions) => Promise<RawPage>;

/**
 * Tier-1 fetch (WP-1.4): browser-impersonating HTTP via got-scraping
 * (generated browser headers, HTTP/2, TLS profile). Follows redirects, so
 * short links (amzn.in, dl.flipkart.com) resolve to full listing URLs.
 * All failure modes map onto the fixed failure taxonomy.
 */
export const httpFetch: FetchFn = async (url, options = {}) => {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const proxyUrl = scraperProxyUrl();
  let response;
  try {
    response = await gotScraping({
      url,
      timeout: { request: timeoutMs },
      throwHttpErrors: false,
      // Route through the residential proxy when configured (R-2). Most HTTP
      // proxies can't tunnel HTTP/2, which surfaces as "Protocol error" — so
      // force HTTP/1.1 whenever a proxy is in the path.
      ...(proxyUrl ? { proxyUrl, http2: false } : {}),
      ...(options.headers ? { headers: options.headers } : {}),
      headerGeneratorOptions: {
        devices: ['desktop'],
        locales: ['en-IN', 'en-US'],
        operatingSystems: ['windows', 'macos'],
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/timeout/i.test(message)) {
      throw new CheckError('fetch_timeout', `Request timed out after ${timeoutMs}ms`);
    }
    throw new CheckError('http_error', `Network error: ${message}`);
  }

  const status = response.statusCode;
  if (status === 404 || status === 410) {
    throw new CheckError('listing_removed', `Listing returned HTTP ${status}`);
  }
  if (status === 403 || status === 429 || status === 503) {
    throw new CheckError('fetch_blocked', `Marketplace refused the request (HTTP ${status})`);
  }
  if (status >= 400) {
    throw new CheckError('http_error', `Unexpected HTTP ${status}`);
  }

  return {
    url: response.url ?? url, // final URL after redirects
    body: response.body,
    tier: 'http',
    fetchedAt: new Date(),
  };
};

/** Resolve a short/share link to its final URL without parsing the body. */
export async function resolveFinalUrl(url: string, fetchFn: FetchFn = httpFetch): Promise<string> {
  const page = await fetchFn(url);
  return page.url;
}

/**
 * Follow HTTP redirects until the URL is a recognized product listing (per the
 * caller's `isListing` predicate) or redirects stop. Turns short/affiliate
 * links (fkrt.co, amzn.in, amzn.to, pwap.in, bilty.co, dl.flipkart.com, …) into
 * real marketplace URLs for bulk import.
 *
 * It stops the moment the URL recognizes as a listing, so the heavy marketplace
 * page is NEVER downloaded — fast, cheap on proxy bandwidth, and it sidesteps
 * the marketplace anti-bot during resolution. Routes through the proxy when set.
 * Returns the best-effort final URL (may not be a listing — the caller decides).
 */
export async function resolveListingUrl(
  rawUrl: string,
  isListing: (url: string) => boolean,
  opts: { maxHops?: number; timeoutMs?: number } = {},
): Promise<string> {
  const maxHops = opts.maxHops ?? 6;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const proxyUrl = scraperProxyUrl();
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
        timeout: { request: timeoutMs },
        // HTTP/1.1 through proxies (HTTP/2-over-proxy → "Protocol error").
        ...(proxyUrl ? { proxyUrl, http2: false } : {}),
        headerGeneratorOptions: { devices: ['desktop'], locales: ['en-IN', 'en-US'] },
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
