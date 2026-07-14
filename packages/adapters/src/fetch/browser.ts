import type { RawPage } from '../adapter.js';
import type { FetchFn } from './http.js';
import { CheckError } from '../errors.js';
import { playwrightProxy } from './proxy.js';
import type { PlaywrightProxy } from './proxy.js';

const MAX_PAGES_PER_BROWSER = 50;

/**
 * Tier-2 fetch (WP-1.4): headless Chromium via Playwright, loaded lazily so
 * the app runs without it (H-13 documents enabling it). One shared browser,
 * fresh context per fetch, recycled after N pages (plan ER-8).
 *
 * Lives in the adapters package so BOTH the worker (scheduled/on-demand
 * checks) and the API (registration preview) can escalate blocked tier-1
 * fetches to a real browser — otherwise Flipkart's anti-bot page hard-fails
 * a preview even when the browser tier is available (R-2 mitigation).
 *
 * Returns `undefined` when Playwright isn't installed, so callers degrade to
 * tier-1 HTTP only rather than crashing.
 */
export async function createBrowserFetch(): Promise<FetchFn | undefined> {
  const specifier = 'playwright';
  let playwright: {
    chromium: {
      launch(opts: { headless: boolean; proxy?: PlaywrightProxy }): Promise<{
        newContext(opts?: object): Promise<{
          newPage(): Promise<{
            goto(url: string, opts: object): Promise<{ status(): number } | null>;
            content(): Promise<string>;
            url(): string;
          }>;
          close(): Promise<void>;
        }>;
        close(): Promise<void>;
      }>;
    };
  };
  try {
    playwright = await import(specifier);
  } catch {
    return undefined;
  }

  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | null = null;
  let pagesServed = 0;
  const proxy = playwrightProxy();

  const fetchFn: FetchFn = async (url): Promise<RawPage> => {
    if (!browser || pagesServed >= MAX_PAGES_PER_BROWSER) {
      await browser?.close().catch(() => undefined);
      // Route the browser tier through the residential proxy when configured (R-2).
      browser = await playwright.chromium.launch({ headless: true, proxy });
      pagesServed = 0;
    }
    const context = await browser.newContext({
      locale: 'en-IN',
      viewport: { width: 1366, height: 768 },
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      pagesServed += 1;
      const status = response?.status() ?? 0;
      if (status === 404 || status === 410) {
        throw new CheckError('listing_removed', `Listing returned HTTP ${status} (browser)`);
      }
      return {
        url: page.url(),
        body: await page.content(),
        tier: 'browser',
        fetchedAt: new Date(),
      };
    } catch (err) {
      if (err instanceof CheckError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      if (/timeout/i.test(message)) {
        throw new CheckError('fetch_timeout', `Browser navigation timed out: ${message}`);
      }
      throw new CheckError('http_error', `Browser fetch failed: ${message}`);
    } finally {
      await context.close().catch(() => undefined);
    }
  };
  return fetchFn;
}
