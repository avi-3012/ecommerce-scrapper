import { gotScraping } from 'got-scraping';
import type { RawPage } from '../adapter.js';
import { CheckError } from '../errors.js';

export interface HttpFetchOptions {
  timeoutMs?: number;
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
  let response;
  try {
    response = await gotScraping({
      url,
      timeout: { request: timeoutMs },
      throwHttpErrors: false,
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
