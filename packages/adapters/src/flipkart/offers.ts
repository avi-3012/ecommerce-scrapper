import type { RawOffer } from '../offers.js';

/**
 * Flipkart individual-offer extraction.
 *
 * Flipkart product pages are client-rendered: the "Available offers" bullets are
 * not in the server HTML, but the page ships the full offer data in a
 * `window.__INITIAL_STATE__` JSON blob. Each offer is a `NepOffers` object with
 * an `offerTitle` (the bank/wallet, e.g. "Flipkart Axis", or a category like
 * "Bank offers"), a subtitle, and an amount. We parse that blob and pull out the
 * individual offers from two sections:
 *
 *  - "Bank offers" (PBO): the card/UPI instant discounts and cashbacks.
 *  - "EMI offers" (PBO_EMI): per-bank EMI offers that carry a DISCOUNT (e.g.
 *    "HDFC Bank — Credit Card • ₹2,000 off"). An EMI row is identified by its
 *    `tenure` field; its promotional value lives in the SUBTITLE, while its
 *    `metaInfoLabelValue` is the monthly installment ("₹X off/m (N months)").
 *
 * A plain EMI installment plan — an EMI row whose subtitle carries no discount,
 * only the monthly figure — is a payment option, not a promotion, so it is
 * excluded: including the installment amount (which tracks the price and tenure)
 * would flap offer-change alerts on every price move.
 */

/** Isolate the `window.__INITIAL_STATE__` object via a string-aware brace scan. */
export function extractInitialState(html: string): unknown | null {
  const marker = html.indexOf('window.__INITIAL_STATE__');
  if (marker === -1) return null;
  const start = html.indexOf('{', marker);
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const CATEGORY_LABEL: Record<string, string> = {
  EXCHANGE: 'Exchange offer',
  PBO: 'Bank offer',
  PBO_EMI: 'No Cost EMI',
};

interface NepOffer {
  type?: string;
  offerTitle?: string;
  offerType?: string;
  offerSubTitleRC?: unknown;
}

/** First text leaf inside a Flipkart "RichContent" subtitle tree. */
function firstText(node: unknown): string | null {
  let found: string | null = null;
  const walk = (n: unknown): void => {
    if (found !== null || !n || typeof n !== 'object') return;
    const obj = n as Record<string, unknown>;
    if (typeof obj.contentValue === 'string' && obj.contentValue.trim()) {
      found = obj.contentValue;
      return;
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(node);
  return found;
}

/** First rupee/percent amount label within an offer object. */
function firstAmount(node: unknown): string | null {
  let found: string | null = null;
  const walk = (n: unknown): void => {
    if (found !== null || !n || typeof n !== 'object') return;
    const obj = n as Record<string, unknown>;
    if (typeof obj.metaInfoLabelValue === 'string' && /₹|%/.test(obj.metaInfoLabelValue)) {
      found = obj.metaInfoLabelValue;
      return;
    }
    for (const k of Object.keys(obj)) walk(obj[k]);
  };
  walk(node);
  return found;
}

const clean = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A candidate offer plus the token used to dedupe it within the page. */
interface OfferCandidate {
  raw: RawOffer;
  key: string;
}

/**
 * A "Bank offers" (or exchange) row. A real offer has a concrete amount or
 * genuine promotional wording; some NepOffers are just category headers whose
 * subtitle is a UI prompt ("Change pincode to exchange item") and carry no
 * offer, so they are dropped even though they have an offerType.
 */
function bankOffer(node: NepOffer & Record<string, unknown>, sub: string): OfferCandidate | null {
  let amount = clean(firstAmount(node) ?? '');
  // The EMI installment table ("₹X off/m (N months)") is handled separately; a
  // bank row that somehow surfaces one is a payment plan, not a promotion.
  if (/off\/m|\/month|\(\d+\s*months?\)/i.test(amount)) return null;
  if (/^₹\s*0\b|^0\b/.test(amount)) amount = ''; // ₹0 / placeholder = no real value
  const hasValue = amount !== '' || /cashback|discount|instant|flat|\d+\s*%|\boff\b/i.test(sub);
  if (!hasValue) return null;
  const description = [node.offerTitle, sub, amount].filter(Boolean).join(' — ');
  const label = node.offerType ? CATEGORY_LABEL[node.offerType] : undefined;
  return { raw: label ? { label, description } : { description }, key: amount };
}

/**
 * A per-bank EMI row from the "EMI offers" section. Only rows that carry a
 * DISCOUNT (a rupee/percent value in the subtitle, e.g. "Credit Card • ₹2,000
 * off") are real offers; a row whose subtitle is just the card type is a plain
 * installment plan and is dropped. The monthly installment amount is never used
 * — it tracks the price and would flap the offer set on every price move.
 */
function emiOffer(node: NepOffer & Record<string, unknown>, sub: string): OfferCandidate | null {
  const hasDiscount = /₹\s?[\d,]+|\d+\s*%/.test(sub);
  if (!hasDiscount) return null;
  const description = [node.offerTitle, sub].filter(Boolean).join(' — ');
  // Prefer the "No Cost EMI" bucket when the copy says so; otherwise a plain
  // discounted EMI offer.
  const label = /no[\s-]?cost/i.test(`${node.offerTitle} ${sub}`) ? 'No Cost EMI' : 'EMI offer';
  return { raw: { label, description }, key: sub };
}

/** Extract the individual promotional offers from a Flipkart page's state JSON. */
export function extractFlipkartOffers(html: string): RawOffer[] {
  const state = extractInitialState(html);
  if (!state) return [];

  const offers: RawOffer[] = [];
  const seen = new Set<string>();

  const walk = (n: unknown): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(walk);
      return;
    }
    const node = n as NepOffer & Record<string, unknown>;
    if (node.type === 'NepOffers' && node.offerTitle) {
      const sub = clean(firstText(node.offerSubTitleRC) ?? '');
      // A per-bank EMI row carries a `tenure` field; its promotional value is the
      // discount in the SUBTITLE, not the monthly installment in the amount.
      const entry = 'tenure' in node ? emiOffer(node, sub) : bankOffer(node, sub);
      if (entry) {
        const key = `${node.offerTitle}|${entry.key}`.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          offers.push(entry.raw);
        }
      }
    }
    for (const k of Object.keys(node)) walk(node[k]);
  };

  walk(state);
  // Guard against a runaway blob. Two sections (bank + EMI) now contribute, so
  // the cap is generous enough not to truncate a genuinely offer-rich listing.
  return offers.slice(0, 40);
}
