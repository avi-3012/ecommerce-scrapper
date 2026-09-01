import { DEFAULT_SCRAPING_CONFIG, loadScrapingConfig } from '@pricepulse/adapters';
import type { ScrapingConfig } from '@pricepulse/adapters';

/**
 * The scraping config, as the API sees it.
 *
 * The API does not scrape — the worker owns every outbound request — but it
 * does enforce the product cap, because refusing at registration is far kinder
 * than letting the catalogue outgrow the connection and discovering it later
 * from a block rate. Cached: this is a small file read, and it is on the
 * request path for adding a product.
 */
let cached: { at: number; config: ScrapingConfig } | null = null;
const TTL_MS = 30_000;

export function loadScrapingConfigSafely(): ScrapingConfig {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.config;
  let config: ScrapingConfig;
  try {
    config = loadScrapingConfig();
  } catch (err) {
    console.error(
      `Scraping config unreadable, using defaults: ${err instanceof Error ? err.message : err}`,
    );
    config = DEFAULT_SCRAPING_CONFIG;
  }
  cached = { at: Date.now(), config };
  return config;
}
