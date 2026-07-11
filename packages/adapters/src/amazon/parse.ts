import * as cheerio from 'cheerio';
import type { ProductSnapshot, StockStatus } from '@pricepulse/shared';
import { computeDiscountPct } from '@pricepulse/shared';
import { CheckError } from '../errors.js';
import { normalizeOffers } from '../offers.js';
import { parseInrAmount } from '../money.js';
import { validateSnapshot } from '../validate.js';

/**
 * Amazon India listing parser (WP-1.2). Layered strategies per field with
 * provenance; one required field failing all strategies fails the whole
 * check as parse_failed — partial snapshots are never recorded as success.
 *
 * NOTE (H-12): selectors are grounded in Amazon's long-stable markup hooks;
 * the fixture suite must be extended with captured real pages before the
 * Milestone 1 soak.
 */
export function parseAmazonPage(html: string, expectedAsin?: string): ProductSnapshot {
  detectInterstitials(html);

  const $ = cheerio.load(html);
  const provenance: Record<string, string> = {};

  // ── ASIN echo (variant discipline, BRD R-5) ──
  const pageAsin =
    $('input#ASIN').attr('value') ??
    $('[data-asin]').first().attr('data-asin') ??
    canonicalAsin($('link[rel="canonical"]').attr('href'));
  if (expectedAsin && pageAsin && pageAsin !== expectedAsin) {
    throw new CheckError(
      'parse_failed',
      `Page is for ASIN ${pageAsin}, expected ${expectedAsin} (marketplace redirect)`,
    );
  }

  // ── Name ──
  const name = $('#productTitle').text().trim() || $('h1 span').first().text().trim();
  if (name) provenance.name = $('#productTitle').length ? 'product-title' : 'h1-fallback';

  // ── Stock ──
  const availabilityText = $('#availability').text().trim().toLowerCase();
  let stockStatus: StockStatus = 'unknown';
  if (/currently unavailable|out of stock|temporarily unavailable/.test(availabilityText)) {
    stockStatus = 'out_of_stock';
    provenance.stock = 'availability-block';
  } else if (/in stock|order soon|left in stock/.test(availabilityText)) {
    stockStatus = 'in_stock';
    provenance.stock = 'availability-block';
  }

  // ── Price (strategy order: core price block → legacy ids → any offscreen price) ──
  let price: number | null = null;
  const coreOffscreen = $(
    '#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #apex_desktop .a-price .a-offscreen',
  )
    .first()
    .text();
  price = parseInrAmount(coreOffscreen);
  if (price !== null) provenance.price = 'core-price-block';
  if (price === null) {
    price = parseInrAmount($('#priceblock_ourprice, #priceblock_dealprice').first().text());
    if (price !== null) provenance.price = 'legacy-price-id';
  }
  if (price === null) {
    price = parseInrAmount($('.a-price:not(.a-text-price) .a-offscreen').first().text());
    if (price !== null) provenance.price = 'any-offscreen-price';
  }

  // A parsed price with no availability signal means a normal buyable listing.
  if (stockStatus === 'unknown' && price !== null) {
    stockStatus = 'in_stock';
    provenance.stock = 'implied-by-price';
  }

  // ── MRP (strikethrough list price) ──
  let mrp = parseInrAmount(
    $('.basisPrice .a-offscreen, .a-price.a-text-price .a-offscreen').first().text(),
  );
  if (mrp !== null) provenance.mrp = 'basis-price';
  if (mrp === null && price !== null) {
    mrp = price;
    provenance.mrp = 'equal-to-price';
  }

  // ── Offers (coupon badge, bank/promo strips) ──
  const offerTexts: string[] = [];
  $('#couponBadgeRegularVsn, .couponBadge, [id^="couponText"]').each((_i, el) => {
    offerTexts.push($(el).text());
  });
  $(
    '#vsxoffers_feature_div .vsx-offers-desktop-lv__item, #itembox-InstantBankDiscount, .offers-items-content',
  ).each((_i, el) => {
    offerTexts.push($(el).text());
  });
  const offers = normalizeOffers(offerTexts);

  // ── Image ──
  const imageUrl = $('#landingImage').attr('src') ?? $('#imgTagWrapperId img').attr('src') ?? null;

  // ── Required-field enforcement ──
  if (!name)
    throw new CheckError('parse_failed', 'Could not extract product name (all strategies)');
  if (price === null && stockStatus !== 'out_of_stock') {
    throw new CheckError('parse_failed', 'Could not extract price (all strategies)');
  }

  return validateSnapshot({
    marketplace: 'amazon_in',
    marketplaceProductId: pageAsin ?? expectedAsin ?? '',
    name,
    price: price ?? 0,
    mrp: mrp ?? price ?? 0,
    discountPct: computeDiscountPct(price ?? 0, mrp ?? price ?? 0),
    offers,
    stockStatus,
    imageUrl,
    provenance,
  });
}

function detectInterstitials(html: string): void {
  if (/validateCaptcha|Type the characters you see in this image/i.test(html)) {
    throw new CheckError('captcha', 'Amazon presented a CAPTCHA challenge');
  }
  if (/To discuss automated access to Amazon data|api-services-support@amazon\.com/i.test(html)) {
    throw new CheckError('fetch_blocked', 'Amazon robot-check page returned');
  }
  if (/Looking for something\?[\s\S]*we can(?:'|no)t find that page/i.test(html)) {
    throw new CheckError('listing_removed', 'Amazon page-not-found content');
  }
}

function canonicalAsin(href: string | undefined): string | undefined {
  return href?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
}
