import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import type { FetchOptions, MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { CheckError } from '../errors.js';
import { httpFetch } from '../fetch/http.js';
import type { FetchFn } from '../fetch/http.js';
import { proxySession, resolveExitIp } from '../fetch/proxy.js';
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
    const debug = opts?.debug;
    if (debug) {
      debug.proxySession = proxySession() ?? null;
      debug.exitIp = await resolveExitIp();
    }
    const page = await this.fetchFn(canonicalUrl);
    if (debug) {
      debug.fetch = { finalUrl: page.url, bodyBytes: page.body.length, tier: page.tier };
    }
    // Flipkart price/stock are location-specific. When a pincode is set, fetch
    // the localized price/MRP/stock from Flipkart's page/fetch API and inject it
    // so the parser overrides those fields (offers still come from the HTML).
    if (opts?.pincode) {
      if (debug) debug.pincodeRequested = opts.pincode;
      const url = new URL(canonicalUrl);
      const result = await fetchFlipkartPincodePricing(url.pathname + url.search, opts.pincode);
      if (debug) {
        debug.pincode = {
          apiStatus: result.status,
          applied: result.applied,
          city: result.city,
          verified: result.verified,
          apiPrice: result.pricing?.price ?? null,
          apiMrp: result.pricing?.mrp ?? null,
          attempts: result.attempts,
          raw: result.raw,
          seller: result.seller,
          sample: result.sample,
          availability: result.availability,
          outOfStock: result.pricing?.stockStatus === 'out_of_stock',
        };
      }
      if (!result.pricing) {
        // The listing IS buyable but its localized price couldn't be confirmed.
        // Do NOT fall back to the IP-default price: the proxy IP's region varies
        // between checks, so that records a wrong price and fires a false drop.
        // Fail the check transiently — the last known price is preserved.
        // (An out-of-stock listing never lands here: it needs no pincode echo.)
        throw new CheckError('other', `Flipkart pincode ${opts.pincode} pricing unavailable`);
      }
      page.body = injectPincodePricing(page.body, result.pricing);
    }
    return page;
  }

  parse(page: RawPage): ProductSnapshot {
    const ids = extractFlipkartIds(new URL(page.url));
    return parseFlipkartPage(page.body, { pid: ids?.pid, itemId: ids?.itemId });
  }
}
