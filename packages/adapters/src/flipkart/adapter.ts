import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import type { MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { httpFetch } from '../fetch/http.js';
import type { FetchFn } from '../fetch/http.js';
import { FLIPKART_DOMAINS, extractFlipkartIds, recognizeFlipkart } from './canonicalize.js';
import { parseFlipkartPage } from './parse.js';

export class FlipkartAdapter implements MarketplaceAdapter {
  readonly marketplace: Marketplace = 'flipkart';
  readonly domains = FLIPKART_DOMAINS;

  constructor(private readonly fetchFn: FetchFn = httpFetch) {}

  recognize(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
    return recognizeFlipkart(url);
  }

  fetch(canonicalUrl: string): Promise<RawPage> {
    return this.fetchFn(canonicalUrl);
  }

  parse(page: RawPage): ProductSnapshot {
    const ids = extractFlipkartIds(new URL(page.url));
    return parseFlipkartPage(page.body, { pid: ids?.pid, itemId: ids?.itemId });
  }
}
