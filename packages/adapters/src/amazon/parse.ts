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
  // Amazon serves several buy-box price layouts. Try known price containers in
  // order — each is a genuine buy-box/price region, never an accessory or EMI
  // widget, so we avoid the page-wide `.a-price` fallback that used to grab
  // garbage (a ₹499 add-on) on out-of-stock pages.
  let price: number | null = null;
  const priceSelectors = [
    '#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen',
    '#corePriceDisplay_desktop_feature_div .a-price:not(.a-text-price) .a-offscreen',
    '#corePrice_feature_div .a-price:not(.a-text-price) .a-offscreen',
    '#apex_desktop .a-price:not(.a-text-price) .a-offscreen',
    '#tp_price_block_total_price_ww .a-offscreen',
    '.priceToPay .a-offscreen',
    '#price_inside_buybox',
    '#newBuyBoxPrice',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#corePriceDisplay_mobile_feature_div .a-price:not(.a-text-price) .a-offscreen',
  ];
  for (const sel of priceSelectors) {
    const value = parseInrAmount($(sel).first().text());
    if (value !== null) {
      price = value;
      provenance.price = 'buy-box';
      break;
    }
  }
  // Some layouts leave `.a-offscreen` empty and render the price in
  // `.a-price-whole` spans instead — fall back to those, still buy-box-scoped.
  if (price === null) {
    const wholeSelectors = [
      '#corePriceDisplay_desktop_feature_div .priceToPay .a-price-whole',
      '#tp_price_block_total_price_ww .a-price-whole',
      '#corePrice_feature_div .a-price-whole',
      '#apex_desktop .a-price-whole',
    ];
    for (const sel of wholeSelectors) {
      const value = parseInrAmount($(sel).first().text());
      if (value !== null) {
        price = value;
        provenance.price = 'buy-box-whole';
        break;
      }
    }
  }

  // A parsed buy-box price with no availability signal means a normal listing.
  if (stockStatus === 'unknown' && price !== null) {
    stockStatus = 'in_stock';
    provenance.stock = 'implied-by-price';
  }

  // No trustworthy current price when not in stock — record null, not a guess.
  if (stockStatus !== 'in_stock') {
    price = null;
    delete provenance.price;
  }

  // ── MRP (strikethrough list price) — only meaningful alongside a live price ──
  let mrp: number | null = null;
  if (price !== null) {
    mrp = parseInrAmount(
      $('.basisPrice .a-offscreen, .a-price.a-text-price .a-offscreen').first().text(),
    );
    if (mrp !== null) provenance.mrp = 'basis-price';
    if (mrp === null) {
      mrp = price;
      provenance.mrp = 'equal-to-price';
    }
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
    price,
    mrp,
    discountPct: computeDiscountPct(price, mrp),
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
