import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import type { FetchOptions, MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { httpFetch } from '../fetch/http.js';
import type { FetchFn } from '../fetch/http.js';
import { amazonLocationCookie } from '../fetch/location.js';
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
    // Localise the whole session (page + offer side-sheets) to the pincode.
    const cookie = opts?.pincode
      ? await amazonLocationCookie(opts.pincode, canonicalUrl)
      : undefined;
    const fetchOpts = cookie ? { headers: { cookie } } : undefined;

    const page = await this.fetchFn(canonicalUrl, fetchOpts);
    // Expand every multi-offer card into its individual offers via Amazon's
    // side-sheet AJAX endpoint (cheap tier-1 calls, same proxy/session), and
    // carry them into parse via an injected marker script. A layout change that
    // blocks expansion throws parse_failed here — no summary-only fallback.
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
