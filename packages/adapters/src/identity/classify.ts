import { createHash } from 'node:crypto';
import type { Marketplace } from '@pricepulse/shared';
import type { ClassifiedResponse } from './types.js';

/**
 * Every response gets exactly one classification: ok | suspect | hard_block.
 *
 * This is the IP-level early-warning system that replaces "rotate the proxy and
 * hope". With one IP there is nothing to rotate to, so the only safe response to
 * a block is to stop — which means a block has to be recognised the moment the
 * bytes arrive, before a parser gets a chance to turn it into a failed check.
 *
 * The existing parser-level interstitial detectors stay where they are and stay
 * correct; this runs EARLIER, on the raw response, and is what drives identity
 * cooling and the global backoff.
 */

/** Amazon's own block vocabulary. */
const AMAZON_BLOCK_MARKERS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  { pattern: /Robot Check/i, reason: 'amazon_robot_check' },
  { pattern: /Enter the characters you see below/i, reason: 'amazon_captcha' },
  { pattern: /action="\/errors\/validateCaptcha"/i, reason: 'amazon_captcha' },
  { pattern: /id="captchacharacters"/i, reason: 'amazon_captcha' },
  { pattern: /Type the characters you see in this image/i, reason: 'amazon_captcha' },
  { pattern: /Sorry! Something went wrong/i, reason: 'amazon_sorry' },
  { pattern: /api-services-support@amazon\.com/i, reason: 'amazon_automated_access' },
  { pattern: /To discuss automated access to Amazon data/i, reason: 'amazon_automated_access' },
];

/** A page that carries real product signal, so a stray phrase can't fake a block. */
function looksLikeFlipkartProduct(body: string): boolean {
  return (
    /"@type"\s*:\s*"Product"/.test(body) ||
    /"(?:finalPrice|sellingPrice)"\s*:/.test(body) ||
    /<title>[^<]{20,}<\/title>/i.test(body)
  );
}

export interface ResponseFacts {
  marketplace: Marketplace;
  status: number;
  body: string;
  /**
   * Whether this response is SUPPOSED to be a product page.
   *
   * False for warm-up and noise fetches — a homepage or a search page has no
   * product in it by definition, so "no product JSON-LD" says nothing about
   * whether we were blocked. Getting this wrong is not academic: it made every
   * Flipkart warm-up read as a hard block, which cooled the identity that had
   * just been created and fed the IP-level backoff with fictional evidence.
   */
  expectProduct?: boolean;
}

/**
 * Classify a raw marketplace response.
 *
 * Amazon serves its blocks with a recognisable body, so status alone is not
 * enough — a 200 can be a CAPTCHA. Flipkart is the opposite: it does not
 * announce blocks, it just stops serving product pages, so ANY non-200 counts,
 * as does a 200 with no product in it (529 has been seen in the wild).
 */
export function classifyResponse({
  marketplace,
  status,
  body,
  expectProduct = true,
}: ResponseFacts): ClassifiedResponse {
  if (marketplace === 'amazon_in') {
    if (status === 403 || status === 429) {
      return block(`amazon_http_${status}`, `Amazon refused the request (HTTP ${status})`);
    }
    if (status === 503) {
      return block('amazon_http_503', 'Amazon served its 503 anti-bot page');
    }
    for (const marker of AMAZON_BLOCK_MARKERS) {
      if (marker.pattern.test(body)) {
        return block(marker.reason, `Amazon block page detected (${marker.reason})`);
      }
    }
    return { classification: 'ok', reason: 'ok', detail: '' };
  }

  // Flipkart: any non-200 is a block signal.
  if (status !== 200) {
    return block(`flipkart_http_${status}`, `Flipkart returned HTTP ${status}`);
  }
  // A homepage or search page is a 200 with no product in it, and that is
  // correct rather than suspicious. Only status can speak for those.
  if (!expectProduct) {
    return { classification: 'ok', reason: 'ok', detail: '' };
  }
  if (!looksLikeFlipkartProduct(body)) {
    return block(
      'flipkart_no_product',
      `Flipkart returned 200 with no product JSON-LD and no product title (${body.length} bytes)`,
    );
  }
  return { classification: 'ok', reason: 'ok', detail: '' };
}

function block(reason: string, detail: string): ClassifiedResponse {
  return { classification: 'hard_block', reason, detail };
}

/**
 * Snapshot-level suspicion: the page came back 200 and parsed, but what it says
 * does not hold together. A flagged session gets served subtly wrong data at
 * 200 rather than a block page, so this is the only signal that catches it.
 */
export interface SnapshotFacts {
  name: string | null;
  price: number | null;
  /** The last price we accepted for this product, if any. */
  lastAcceptedPrice: number | null;
  outOfStock: boolean;
}

/** The relative move, versus the last accepted price, that we refuse to trust. */
export const SUSPECT_DELTA_RATIO = 0.4;

export function classifySnapshot(facts: SnapshotFacts): ClassifiedResponse {
  const { name, price, lastAcceptedPrice, outOfStock } = facts;
  // An out-of-stock listing legitimately has no price; that is not suspicious.
  if (!outOfStock) {
    if (name && (price === null || price === undefined)) {
      return suspect('no_price', `"${name}" parsed with a title but no price`);
    }
    if (price !== null && price <= 0) {
      return suspect('non_positive_price', `Parsed price ${price} is not a real price`);
    }
  }
  if (price !== null && price > 0 && lastAcceptedPrice !== null && lastAcceptedPrice > 0) {
    const delta = Math.abs(price - lastAcceptedPrice) / lastAcceptedPrice;
    if (delta > SUSPECT_DELTA_RATIO) {
      return suspect(
        'price_jump',
        `Price moved ${(delta * 100).toFixed(1)}% vs last accepted (${lastAcceptedPrice} → ${price})`,
      );
    }
  }
  return { classification: 'ok', reason: 'ok', detail: '' };
}

function suspect(reason: string, detail: string): ClassifiedResponse {
  return { classification: 'suspect', reason, detail };
}

/** Stable fingerprint of a blocked body, so repeats of one block page collapse. */
export function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

/** The slice of a blocked body worth keeping. */
export function bodyHead(body: string, bytes = 2048): string {
  return body.slice(0, bytes);
}
