import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import type { FetchOptions, MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { CheckError } from '../errors.js';
import { httpFetch } from '../fetch/http.js';
import type { FetchFn } from '../fetch/http.js';
import {
  amazonLocationApplied,
  amazonLocationCookie,
  amazonResolvedLocation,
} from '../fetch/location.js';
import { proxySession, resolveExitIp } from '../fetch/proxy.js';
import { AMAZON_DOMAINS, extractAsin, recognizeAmazon } from './canonicalize.js';
import { amazonOutOfStock, parseAmazonPage } from './parse.js';
import { collectAmazonOffers, injectOffers } from './offers.js';

export class AmazonAdapter implements MarketplaceAdapter {
  readonly marketplace: Marketplace = 'amazon_in';
  readonly domains = AMAZON_DOMAINS;

  constructor(private readonly fetchFn: FetchFn = httpFetch) {}

  recognize(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
    return recognizeAmazon(url);
  }

  async fetch(canonicalUrl: string, opts?: FetchOptions): Promise<RawPage> {
    const debug = opts?.debug;
    if (debug) {
      debug.proxySession = proxySession() ?? null;
      debug.exitIp = await resolveExitIp();
    }
    if (!opts?.pincode) {
      const page = await this.fetchFn(canonicalUrl);
      if (debug) {
        debug.fetch = { finalUrl: page.url, bodyBytes: page.body.length, tier: page.tier };
        debug.amazon = { resolvedLocation: amazonResolvedLocation(page.body) || null };
      }
      return this.enrichOffers(page, undefined);
    }
    if (debug) debug.pincodeRequested = opts.pincode;

    // Localise the whole session to the pincode. The glow cookie is IP-bound, so
    // a cached cookie minted on a different proxy IP can be ignored — retry with
    // a freshly-minted cookie until the page actually reflects the pincode.
    for (let attempt = 0; attempt < 3; attempt++) {
      const cookie = await amazonLocationCookie(opts.pincode, canonicalUrl, attempt > 0);
      if (!cookie) {
        if (debug) debug.amazon = { locationApplied: false, attempts: attempt + 1 };
        throw new CheckError('other', `Amazon location for pincode ${opts.pincode} unavailable`);
      }
      const page = await this.fetchFn(canonicalUrl, { headers: { cookie } });
      const resolvedLocation = amazonResolvedLocation(page.body);
      if (debug) {
        debug.fetch = { finalUrl: page.url, bodyBytes: page.body.length, tier: page.tier };
      }
      if (amazonLocationApplied(page.body, opts.pincode)) {
        if (debug) {
          debug.amazon = { locationApplied: true, attempts: attempt + 1, resolvedLocation };
        }
        return this.enrichOffers(page, cookie);
      }
      // Out of stock is a location-independent fact about the listing: there is
      // no localized price to get wrong, so record it rather than burning the
      // remaining attempts and failing a check that already has its answer.
      const outOfStock = amazonOutOfStock(page.body);
      if (debug) {
        debug.amazon = {
          locationApplied: false,
          outOfStock,
          attempts: attempt + 1,
          resolvedLocation: resolvedLocation || null,
        };
      }
      if (outOfStock) return this.enrichOffers(page, cookie);
    }
    // Never record a default-location price — fail transiently; last price kept.
    throw new CheckError('other', `Amazon did not apply pincode ${opts.pincode}`);
  }

  /**
   * Expand every multi-offer card into its individual offers via Amazon's
   * side-sheet AJAX endpoint (cheap tier-1 calls, same proxy/session/cookie),
   * and carry them into parse via an injected marker script. A layout change
   * that blocks expansion throws parse_failed here — no summary-only fallback.
   */
  private async enrichOffers(page: RawPage, cookie: string | undefined): Promise<RawPage> {
    const asin = extractAsin(new URL(page.url)) ?? undefined;
    if (asin) {
      const offers = await collectAmazonOffers(page.body, asin, this.fetchFn, cookie);
      if (offers) page.body = injectOffers(page.body, offers);
    }
    return page;
  }

  parse(page: RawPage): ProductSnapshot {
    const expectedAsin = extractAsin(new URL(page.url)) ?? undefined;
    return parseAmazonPage(page.body, expectedAsin);
  }
}
