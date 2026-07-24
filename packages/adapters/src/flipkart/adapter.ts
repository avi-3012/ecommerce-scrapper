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
    // The main page may be fetched by the browser tier (opts.pageFetch); the
    // pincode price still comes from the page/fetch API below, so localisation
    // is identical on both tiers.
    const pageFetch = opts?.pageFetch ?? this.fetchFn;
    const page = await pageFetch(canonicalUrl);
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
          locationErrorCode: result.locationErrorCode,
          outOfStock: result.pricing?.stockStatus === 'out_of_stock',
        };
      }
      if (!result.pricing) {
        // The listing IS buyable but no response gave a price localized to the
        // delivery pincode. Do NOT fall back to the default all-India price —
        // it belongs to a seller that does not deliver here and differs from the
        // local price, which is exactly what fired phantom drops.
        // Fail the check transiently — the last known price is preserved.
        // (An out-of-stock listing never lands here: it needs no pincode echo.)
        const why =
          result.locationErrorCode ?? result.availability?.unserviceabilityReason ?? 'unverified';
        throw new CheckError(
          'other',
          `Flipkart returned no price localized to pincode ${opts.pincode} after ${result.attempts} attempts (${why})`,
        );
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
