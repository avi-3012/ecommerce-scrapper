import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import type { FetchOptions, MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { CheckError } from '../errors.js';
import { httpFetch } from '../fetch/http.js';
import type { FetchFn } from '../fetch/http.js';
import { FLIPKART_DOMAINS, extractFlipkartIds, recognizeFlipkart } from './canonicalize.js';
import { parseFlipkartPage } from './parse.js';
import { fetchFlipkartPincodePricing, injectPincodePricing } from './location.js';

export class FlipkartAdapter implements MarketplaceAdapter {
  readonly marketplace: Marketplace = 'flipkart';
  readonly domains = FLIPKART_DOMAINS;

  constructor(private readonly fetchFn: FetchFn = httpFetch) {}

  recognize(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
    return recognizeFlipkart(url);
  }

  async fetch(canonicalUrl: string, opts?: FetchOptions): Promise<RawPage> {
    const page = await this.fetchFn(canonicalUrl);
    // Flipkart price/stock are location-specific. When a pincode is set, fetch
    // the localized price/MRP/stock from Flipkart's page/fetch API and inject it
    // so the parser overrides those fields (offers still come from the HTML).
    if (opts?.pincode) {
      const url = new URL(canonicalUrl);
      const pricing = await fetchFlipkartPincodePricing(url.pathname + url.search, opts.pincode);
      if (!pricing) {
        // A pincode is configured but its localized price couldn't be fetched.
        // Do NOT fall back to the IP-default price: the proxy IP's region varies
        // between checks, so that records a wrong price and fires a false drop.
        // Fail the check transiently — the last known price is preserved.
        throw new CheckError('other', `Flipkart pincode ${opts.pincode} pricing unavailable`);
      }
      page.body = injectPincodePricing(page.body, pricing);
    }
    return page;
  }

  parse(page: RawPage): ProductSnapshot {
    const ids = extractFlipkartIds(new URL(page.url));
    return parseFlipkartPage(page.body, { pid: ids?.pid, itemId: ids?.itemId });
  }
}
