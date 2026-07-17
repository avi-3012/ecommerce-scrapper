import * as cheerio from 'cheerio';
import { CheckError } from '../errors.js';
import type { FetchFn } from '../fetch/http.js';
import type { RawOffer } from '../offers.js';

/**
 * Amazon individual-offer extraction.
 *
 * Amazon groups promotions into offer cards (Bank Offer, No Cost EMI, Cashback,
 * Partner Offers, …). A card that holds several offers ("3 offers") shows the
 * individual offers only in an AJAX "side-sheet" that loads on click — they are
 * NOT in the product page's HTML. Rather than drive a headless browser, we hit
 * the same endpoint the side-sheet uses:
 *
 *   GET /gp/product/ajax/vsxOffersSecondaryView?asin=…&offerType=<contentId>&…
 *
 * built entirely from the card's own `data-side-sheet` config. This returns the
 * individual offers as `.vsx-offers-desktop-lv__item` rows over cheap tier-1
 * HTTP. Single-offer cards ("1 offer") already show their one offer in the card
 * summary, and their endpoint returns empty by design.
 *
 * No toleration of layout drift: if a multi-offer card can no longer be expanded
 * into its individual offers, the whole check fails as `parse_failed` so the
 * layout change surfaces as maintenance rather than silently recording partial
 * or summary-only offer data.
 */

/** Marker script the adapter injects into the page body carrying enriched offers. */
export const AMAZON_OFFERS_MARKER = 'pp-amazon-offers';

interface SideSheetConfig {
  contentId?: string;
  encryptedMerchantId?: string;
  smid?: string;
  buyingOptionIndex?: number;
  sr?: string;
}

interface OfferCard {
  title: string;
  summary: string;
  count: number;
  config?: SideSheetConfig;
}

/**
 * The "Partner Offers" card ("Get GST invoice and save … on business
 * purchases") is a B2B sign-up, not a price/discount offer, so it is excluded.
 */
function isExcludedCard(title: string, summary: string, contentId?: string): boolean {
  return (
    /partner/i.test(title) ||
    /partner/i.test(contentId ?? '') ||
    /gst invoice|business purchase/i.test(summary)
  );
}

/** Read the offer cards present on a product page (new carousel layout). */
function extractOfferCards($: cheerio.CheerioAPI): OfferCard[] {
  const cards: OfferCard[] = [];
  $('.offers-items').each((_i, el) => {
    const card = $(el);
    const title = card.find('.offers-items-title').first().text().replace(/\s+/g, ' ').trim();
    // Strip the `a-truncate-cut` ellipsis copy so the summary text is stable.
    const summaryEl = card.find('.offers-items-content').first().clone();
    summaryEl.find('.a-truncate-cut').remove();
    const summary = summaryEl.text().replace(/\s+/g, ' ').trim();
    const count = Number(card.find('.vsx-offers-count').first().text().match(/\d+/)?.[0]) || 1;
    let config: SideSheetConfig | undefined;
    const raw = card.find('[data-side-sheet]').attr('data-side-sheet');
    if (raw) {
      try {
        config = JSON.parse(raw) as SideSheetConfig;
      } catch {
        config = undefined;
      }
    }
    if ((title || summary) && !isExcludedCard(title, summary, config?.contentId)) {
      cards.push({ title, summary, count, config });
    }
  });
  return cards;
}

/** Build the side-sheet AJAX URL for a card from its own declarative config. */
export function buildSecondaryViewUrl(asin: string, config: SideSheetConfig): string {
  const offerType = config.contentId ?? '';
  const merchant = config.encryptedMerchantId ?? '';
  const params = new URLSearchParams({
    asin,
    deviceType: 'web',
    offerType,
    buyingOptionIndex: String(config.buyingOptionIndex ?? 0),
    additionalParams: `merchantId:${merchant}`,
    smid: config.smid ?? '',
    encryptedMerchantId: merchant,
    sr: config.sr ?? '',
    experienceId: 'vsxOffersSecondaryView',
    showFeatures: 'vsxoffers',
    featureParams: `OfferType:${offerType},DeviceType:web`,
  });
  return `https://www.amazon.in/gp/product/ajax/vsxOffersSecondaryView?${params.toString()}`;
}

/** Parse the individual offers out of a side-sheet AJAX response. */
export function parseSecondaryViewOffers(html: string): string[] {
  const $ = cheerio.load(html);
  const offers: string[] = [];
  $('.vsx-offers-desktop-lv__item').each((_i, el) => {
    const node = $(el).clone();
    // Drop "See details" links AND Amazon's `a-truncate-cut` copy: the truncate
    // widget ships the full text plus an ellipsized duplicate, and whether the
    // duplicate is present varies between responses — so `.text()` would
    // intermittently double the string and flap the offer-change alert.
    node.find('a, button, script, style, .a-truncate-cut').remove();
    // Strip the positional "Offer N" prefix (Amazon returns offers in a varying
    // order) and any dangling " ." left after removing the "See details" link.
    const text = node
      .text()
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^Offer\s+\d+\s*/i, '')
      .replace(/\s+\.\s*$/, '.')
      .trim();
    if (text) offers.push(text);
  });
  return offers;
}

function offerHeaders(asin: string): Record<string, string> {
  return {
    'x-requested-with': 'XMLHttpRequest',
    accept: 'text/html,*/*',
    referer: `https://www.amazon.in/dp/${asin}`,
  };
}

/** Coupon badge — a checkbox-style instant coupon shown outside the offer carousel. */
function couponOffers($: cheerio.CheerioAPI): RawOffer[] {
  const out: RawOffer[] = [];
  $('#couponBadgeRegularVsn, .couponBadge, [id^="couponText"]').each((_i, el) => {
    const description = $(el).text().replace(/\s+/g, ' ').trim();
    if (description) out.push({ label: 'coupon', description });
  });
  return out;
}

/**
 * Collect every individual offer on the page. Returns `null` when the page has
 * no offer cards at all (nothing to enrich — parse falls back to whatever the
 * DOM carries). Throws `parse_failed` when a multi-offer card cannot be expanded
 * into its individual offers (layout drift — no toleration). Network errors from
 * the AJAX fetch propagate as their transient category.
 */
export async function collectAmazonOffers(
  html: string,
  asin: string,
  fetchFn: FetchFn,
): Promise<RawOffer[] | null> {
  const $ = cheerio.load(html);
  const cards = extractOfferCards($);
  if (cards.length === 0) return null;

  const perCard = await Promise.all(
    cards.map(async (card): Promise<RawOffer[]> => {
      // Single-offer card: the summary IS the one offer (endpoint returns empty).
      if (card.count <= 1) {
        return card.summary ? [{ label: card.title, description: card.summary }] : [];
      }
      // Multi-offer card: the individual offers must come from the side-sheet.
      if (!card.config?.contentId) {
        throw new CheckError(
          'parse_failed',
          `Amazon offer layout changed: "${card.title}" lists ${card.count} offers but exposes no side-sheet config`,
        );
      }
      const url = buildSecondaryViewUrl(asin, card.config);
      const page = await fetchFn(url, { timeoutMs: 15_000, headers: offerHeaders(asin) });
      const items = parseSecondaryViewOffers(page.body);
      if (items.length === 0) {
        throw new CheckError(
          'parse_failed',
          `Amazon offer layout changed: "${card.title}" side-sheet yielded no individual offers`,
        );
      }
      return items.map((description) => ({ label: card.title, description }));
    }),
  );

  return [...couponOffers($), ...perCard.flat()];
}

/** Serialize enriched offers into a marker script appended to the page body. */
export function injectOffers(html: string, offers: RawOffer[]): string {
  const json = JSON.stringify(offers).replace(/</g, '\\u003c');
  return `${html}\n<script type="application/json" id="${AMAZON_OFFERS_MARKER}">${json}</script>`;
}

/** Read enriched offers the adapter injected, if present. */
export function readInjectedOffers($: cheerio.CheerioAPI): RawOffer[] | null {
  const el = $(`#${AMAZON_OFFERS_MARKER}`);
  if (el.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(el.first().text());
    return Array.isArray(parsed) ? (parsed as RawOffer[]) : null;
  } catch {
    return null;
  }
}

/**
 * Whether the page shows a multi-offer card. Used by the parser to enforce the
 * no-toleration rule: if such a card is present but no enriched offers were
 * injected (e.g. the browser tier, which cannot call the side-sheet endpoint),
 * the individual offers are missing and the check must fail rather than record
 * summary-only data.
 */
export function hasUnexpandedMultiOfferCard(html: string): boolean {
  const $ = cheerio.load(html);
  return extractOfferCards($).some((c) => c.count > 1);
}

/**
 * Offers straight from the product-page DOM, for pages that need no side-sheet
 * expansion: single-offer cards, older flat-list layouts, and the coupon badge.
 */
export function domOffers($: cheerio.CheerioAPI): RawOffer[] {
  const out: RawOffer[] = [...couponOffers($)];
  const cards = extractOfferCards($);
  if (cards.length > 0) {
    for (const card of cards) {
      if (card.summary) out.push({ label: card.title, description: card.summary });
    }
    return out;
  }
  // Older layout: each offer is a flat line rather than a card.
  $('#vsxoffers_feature_div .vsx-offers-desktop-lv__item, #itembox-InstantBankDiscount').each(
    (_i, el) => {
      const description = $(el).text().replace(/\s+/g, ' ').trim();
      if (description) out.push({ description });
    },
  );
  return out;
}
