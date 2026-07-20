import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import type { FetchOptions, MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { CheckError } from '../errors.js';
import { httpFetch } from '../fetch/http.js';
import type { FetchFn } from '../fetch/http.js';
import { amazonLocationApplied, amazonLocationCookie } from '../fetch/location.js';
import { AMAZON_DOMAINS, extractAsin, recognizeAmazon } from './canonicalize.js';
import { parseAmazonPage } from './parse.js';
import { collectAmazonOffers, injectOffers } from './offers.js';

export class AmazonAdapter implements MarketplaceAdapter {
  readonly marketplace: Marketplace = 'amazon_in';
  readonly domains = AMAZON_DOMAINS;

  constructor(private readonly fetchFn: FetchFn = httpFetch) {}

  recognize(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
    return recognizeAmazon(url);
  }

  async fetch(canonicalUrl: string, opts?: FetchOptions): Promise<RawPage> {
    if (!opts?.pincode) {
      return this.enrichOffers(await this.fetchFn(canonicalUrl), undefined);
    }

    // Localise the whole session to the pincode. The glow cookie is IP-bound, so
    // a cached cookie minted on a different proxy IP can be ignored — retry with
    // a freshly-minted cookie until the page actually reflects the pincode.
    for (let attempt = 0; attempt < 3; attempt++) {
      const cookie = await amazonLocationCookie(opts.pincode, canonicalUrl, attempt > 0);
      if (!cookie) {
        throw new CheckError('other', `Amazon location for pincode ${opts.pincode} unavailable`);
      }
      const page = await this.fetchFn(canonicalUrl, { headers: { cookie } });
      if (amazonLocationApplied(page.body, opts.pincode)) {
        return this.enrichOffers(page, cookie);
      }
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
