import * as cheerio from 'cheerio';
import type { ProductSnapshot, StockStatus } from '@pricepulse/shared';
import { computeDiscountPct } from '@pricepulse/shared';
import { CheckError } from '../errors.js';
import { normalizeOffers } from '../offers.js';
import { parseInrAmount } from '../money.js';
import { validateSnapshot } from '../validate.js';

interface JsonLdProduct {
  '@type'?: string | string[];
  name?: string;
  image?: string | string[];
  offers?: {
    price?: string | number;
    availability?: string;
  };
}

/**
 * Flipkart listing parser (WP-1.3). Strategy order: embedded JSON-LD
 * structured data first (Flipkart ships a Product schema on listing pages),
 * then text-content-based selector fallbacks (Flipkart's class names are
 * obfuscated and churn — we avoid depending on them where possible).
 *
 * NOTE (H-12): fixture suite must be extended with captured real pages
 * before the Milestone 1 soak.
 */
/** Flipkart identifiers: itemId is the product (URL path), pid the variant (query). */
export interface FlipkartExpectedIds {
  pid?: string | null;
  itemId?: string | null;
}

export function parseFlipkartPage(html: string, expected?: FlipkartExpectedIds): ProductSnapshot {
  detectInterstitials(html);

  const $ = cheerio.load(html);
  const provenance: Record<string, string> = {};

  // ── Identity echo (variant discipline, BRD R-5) ──
  // Compare like-for-like: itemId↔itemId and pid↔pid. The two live in
  // different namespaces (itm… in the path, a 16-char pid in the query), so a
  // page that exposes only its itemId must NOT be judged against our pid —
  // that produced false "marketplace redirect" rejections (e.g. /a/p/ URLs).
  const canonicalHref = $('link[rel="canonical"]').attr('href') ?? '';
  const pagePid = canonicalHref.match(/[?&]pid=([A-Z0-9]{16})/)?.[1];
  const pageItemId = canonicalHref.match(/\/p\/(itm[0-9a-zA-Z]{13})/)?.[1];
  if (expected?.itemId && pageItemId && expected.itemId !== pageItemId) {
    throw new CheckError(
      'parse_failed',
      `Page is item ${pageItemId}, expected ${expected.itemId} (marketplace redirect)`,
    );
  }
  if (expected?.pid && pagePid && expected.pid !== pagePid) {
    throw new CheckError(
      'parse_failed',
      `Page is variant ${pagePid}, expected ${expected.pid} (marketplace redirect)`,
    );
  }
  const pageId = pagePid ?? pageItemId;

  // ── Strategy 1: JSON-LD ──
  const product = extractJsonLdProduct($);
  let name = '';
  let price: number | null = null;
  let stockStatus: StockStatus = 'unknown';
  let imageUrl: string | null = null;

  if (product) {
    name = (product.name ?? '').trim();
    if (name) provenance.name = 'jsonld';
    const rawPrice = product.offers?.price;
    price = rawPrice !== undefined ? parseInrAmount(String(rawPrice)) : null;
    if (price !== null) provenance.price = 'jsonld';
    const availability = product.offers?.availability ?? '';
    if (/InStock/i.test(availability)) {
      stockStatus = 'in_stock';
      provenance.stock = 'jsonld';
    } else if (/OutOfStock|SoldOut|Discontinued/i.test(availability)) {
      stockStatus = 'out_of_stock';
      provenance.stock = 'jsonld';
    }
    const image = Array.isArray(product.image) ? product.image[0] : product.image;
    imageUrl = image ?? null;
  }

  // ── Strategy 1b: Flipkart's embedded state JSON. Flipkart's DOM class names
  // are obfuscated (e.g. "Nx9bqj") so CSS selectors are unreliable, but the
  // page ships the price in a JSON blob — the most stable signal. ──
  if (price === null) {
    const match =
      html.match(/"finalPrice"\s*:\s*"?(\d{2,9})/i) ||
      html.match(/"sellingPrice"\s*:\s*\{[^}]*?"value"\s*:\s*"?(\d{2,9})/i) ||
      html.match(/"sellingPrice"\s*:\s*"?(\d{2,9})/i) ||
      html.match(/"price"\s*:\s*"?(\d{2,9})/i);
    if (match) {
      price = parseInrAmount(match[1]);
      if (price !== null) provenance.price = 'embedded-json';
    }
  }

  // ── Strategy 2: selector/text fallbacks ──
  if (!name) {
    name =
      $('h1').first().text().trim() ||
      $('title')
        .text()
        .replace(/- Flipkart\.com.*/i, '')
        .trim();
    if (name) provenance.name = 'heading-fallback';
  }
  const bodyText = $('body').text();
  if (stockStatus === 'unknown') {
    if (/sold out|coming soon|notify me|currently unavailable/i.test(bodyText)) {
      stockStatus = 'out_of_stock';
      provenance.stock = 'page-text';
    }
  }
  if (price === null) {
    // The selling-price element is the first ₹ amount inside the price block;
    // match text shaped like a price near the top of the page.
    const priceText = $('[class*="price"], [data-testid="selling-price"]')
      .filter((_i, el) => /₹\s?[\d,]+/.test($(el).text()))
      .first()
      .text();
    price = parseInrAmount(priceText.match(/₹\s?[\d,]+(?:\.\d{1,2})?/)?.[0]);
    if (price !== null) provenance.price = 'price-element';
  }
  if (stockStatus === 'unknown' && price !== null) {
    stockStatus = 'in_stock';
    provenance.stock = 'implied-by-price';
  }

  // No trustworthy current price when not in stock — record null, not a guess
  // (Flipkart's JSON-LD still carries a price for sold-out items, but it isn't
  // a buyable current price).
  if (stockStatus !== 'in_stock') {
    price = null;
    delete provenance.price;
  }

  // ── MRP: struck-through DOM, else embedded JSON, else equal-to-price ──
  let mrp: number | null = null;
  if (price !== null) {
    const struck = $('strike, del, s, [class*="strike"]')
      .filter((_i, el) => /₹\s?[\d,]+/.test($(el).text()))
      .first()
      .text();
    mrp = parseInrAmount(struck);
    if (mrp !== null) provenance.mrp = 'strikethrough';
    if (mrp === null) {
      const jsonMrp = html.match(/"mrp"\s*:\s*"?(\d{2,9})/i);
      const parsed = jsonMrp ? parseInrAmount(jsonMrp[1]) : null;
      if (parsed !== null && parsed >= price) {
        mrp = parsed;
        provenance.mrp = 'embedded-json';
      }
    }
    if (mrp === null) {
      mrp = price;
      provenance.mrp = 'equal-to-price';
    }
  }

  // ── Offers: list items mentioning offer keywords ──
  const offerTexts: string[] = [];
  $('li').each((_i, el) => {
    const text = $(el).text().trim();
    if (/bank offer|special price|coupon|cashback|exchange|no cost emi/i.test(text)) {
      offerTexts.push(text);
    }
  });
  const offers = normalizeOffers(offerTexts);

  if (!name) {
    throw new CheckError('parse_failed', 'Could not extract product name (all strategies)');
  }
  if (price === null && stockStatus !== 'out_of_stock') {
    throw new CheckError('parse_failed', 'Could not extract price (all strategies)');
  }

  return validateSnapshot({
    marketplace: 'flipkart',
    marketplaceProductId: pageId ?? expected?.pid ?? expected?.itemId ?? '',
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

function extractJsonLdProduct($: cheerio.CheerioAPI): JsonLdProduct | null {
  let found: JsonLdProduct | null = null;
  $('script[type="application/ld+json"]').each((_i, el) => {
    if (found) return;
    try {
      const parsed: unknown = JSON.parse($(el).text());
      const candidates = Array.isArray(parsed) ? parsed : [parsed];
      for (const candidate of candidates) {
        const item = candidate as JsonLdProduct;
        const type = item['@type'];
        if (type === 'Product' || (Array.isArray(type) && type.includes('Product'))) {
          found = item;
          return;
        }
      }
    } catch {
      // malformed JSON-LD → fall through to selector strategies
    }
  });
  return found;
}

function detectInterstitials(html: string): void {
  // A real product page carries JSON-LD Product or an embedded price blob and
  // is large; block/CAPTCHA walls are small and lack both. Only classify as an
  // interstitial when there is NO product signal — otherwise phrases like
  // "request blocked" buried in a legitimate page's JavaScript trigger false
  // positives (a real ₹18,999 product page was being reported as blocked).
  const looksLikeProduct =
    html.length > 150_000 ||
    /"@type"\s*:\s*"Product"/.test(html) ||
    /"(?:finalPrice|sellingPrice)"\s*:/.test(html);
  if (looksLikeProduct) return;

  if (/are you a human|unusual traffic|verify you'?re not a robot/i.test(html)) {
    throw new CheckError('captcha', 'Flipkart presented a verification challenge');
  }
  if (/access denied|request blocked/i.test(html)) {
    throw new CheckError('fetch_blocked', 'Flipkart blocked the request');
  }
  if (/this page (?:is|was) unavailable|product (?:is )?no longer available/i.test(html)) {
    throw new CheckError('listing_removed', 'Flipkart listing-removed content');
  }
}
