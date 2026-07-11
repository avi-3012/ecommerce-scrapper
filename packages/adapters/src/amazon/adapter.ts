import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import type { MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { httpFetch } from '../fetch/http.js';
import type { FetchFn } from '../fetch/http.js';
import { AMAZON_DOMAINS, extractAsin, recognizeAmazon } from './canonicalize.js';
import { parseAmazonPage } from './parse.js';

export class AmazonAdapter implements MarketplaceAdapter {
  readonly marketplace: Marketplace = 'amazon_in';
  readonly domains = AMAZON_DOMAINS;

  constructor(private readonly fetchFn: FetchFn = httpFetch) {}

  recognize(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
    return recognizeAmazon(url);
  }

  fetch(canonicalUrl: string): Promise<RawPage> {
    return this.fetchFn(canonicalUrl);
  }

  parse(page: RawPage): ProductSnapshot {
    const expectedAsin = extractAsin(new URL(page.url)) ?? undefined;
    return parseAmazonPage(page.body, expectedAsin);
  }
}
