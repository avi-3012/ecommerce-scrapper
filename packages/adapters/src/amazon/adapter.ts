import type { Marketplace, ProductSnapshot, ScrapeDebug } from '@pricepulse/shared';
import type { FetchOptions, MarketplaceAdapter, RawPage, UrlRecognition } from '../adapter.js';
import { CheckError } from '../errors.js';
import {
  amazonLocationApplied,
  amazonLocationCookie,
  amazonResolvedLocation,
} from '../fetch/location.js';
import type { IdentitySession } from '../identity/session.js';
import { AMAZON_DOMAINS, extractAsin, recognizeAmazon } from './canonicalize.js';
import { amazonOutOfStock, parseAmazonPage } from './parse.js';
import { collectAmazonOffers, injectOffers } from './offers.js';

export class AmazonAdapter implements MarketplaceAdapter {
  readonly marketplace: Marketplace = 'amazon_in';
  readonly domains = AMAZON_DOMAINS;

  recognize(url: URL): Exclude<UrlRecognition, { kind: 'unsupported' }> {
    return recognizeAmazon(url);
  }

  async fetch(canonicalUrl: string, opts: FetchOptions): Promise<RawPage> {
    const debug = opts.debug;
    const session = opts.session;
    // The main page may be fetched by the browser tier (opts.pageFetch); the
    // glow cookie is still minted and applied below, so localisation is
    // identical on both tiers rather than bypassed on escalation.
    const pageFetch = opts.pageFetch ?? session.pageFetch;
    if (debug) debug.identityId = session.id;
    if (!opts.pincode) {
      const page = await pageFetch(canonicalUrl, { debug, kind: 'main_page' });
      if (debug) {
        debug.fetch = { finalUrl: page.url, bodyBytes: page.body.length, tier: page.tier };
        debug.amazon = { resolvedLocation: amazonResolvedLocation(page.body) || null };
      }
      return this.enrichOffers(page, session, debug);
    }
    if (debug) debug.pincodeRequested = opts.pincode;

    // Localise this identity to the pincode. The glow cookie is bound to the
    // session that minted it, so it lives in the identity's own jar and is
    // re-minted for that identity alone when a page comes back unlocalised.
    for (let attempt = 0; attempt < 3; attempt++) {
      const cookie = await amazonLocationCookie(
        session,
        opts.pincode,
        canonicalUrl,
        attempt > 0,
        debug,
      );
      if (!cookie) {
        if (debug) debug.amazon = { locationApplied: false, attempts: attempt + 1 };
        throw new CheckError('other', `Amazon location for pincode ${opts.pincode} unavailable`);
      }
      const page = await pageFetch(canonicalUrl, {
        headers: { cookie },
        debug,
        kind: 'main_page',
      });
      const resolvedLocation = amazonResolvedLocation(page.body);
      if (debug) {
        debug.fetch = { finalUrl: page.url, bodyBytes: page.body.length, tier: page.tier };
      }
      if (amazonLocationApplied(page.body, opts.pincode)) {
        if (debug) {
          debug.amazon = { locationApplied: true, attempts: attempt + 1, resolvedLocation };
        }
        return this.enrichOffers(page, session, debug);
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
      if (outOfStock) return this.enrichOffers(page, session, debug);
    }
    // Never record a default-location price — fail transiently; last price kept.
    throw new CheckError('other', `Amazon did not apply pincode ${opts.pincode}`);
  }

  /**
   * Expand every multi-offer card into its individual offers via Amazon's
   * side-sheet AJAX endpoint — the same XHRs the real page fires, issued by the
   * same identity so they carry its jar and referer — and carry them into parse
   * via an injected marker script. A layout change that blocks expansion falls
   * back to the card's summary line and notes it on the debug trail, rather than
   * failing a check whose price was already read.
   */
  private async enrichOffers(
    page: RawPage,
    session: IdentitySession,
    debug: ScrapeDebug | undefined,
  ): Promise<RawPage> {
    const asin = extractAsin(new URL(page.url)) ?? undefined;
    if (asin) {
      const offers = await collectAmazonOffers(page.body, asin, session.subFetch, debug);
      if (offers) page.body = injectOffers(page.body, offers);
    }
    return page;
  }

  parse(page: RawPage): ProductSnapshot {
    const expectedAsin = extractAsin(new URL(page.url)) ?? undefined;
    return parseAmazonPage(page.body, expectedAsin);
  }
}
