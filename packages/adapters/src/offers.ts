import { createHash } from 'node:crypto';
import type { Offer, OfferType } from '@pricepulse/shared';

/**
 * Offer normalization (WP-1.1 rule 5): classify raw promotional text into
 * comparable structures with a stable hash. Hash stability rules, verified
 * by tests:
 *  - reordering offers must NOT change the hash;
 *  - whitespace/punctuation-only differences must NOT change the hash;
 *  - a changed amount or wording inside an offer MUST change the hash.
 */

// Both marketplaces tag an offer with its category up front: Amazon's card
// title ("Bank Offer", "No Cost EMI") and Flipkart's list-item prefix
// ("Bank Offer: 5% Cashback …"). That leading label is authoritative — a
// "Bank Offer" that happens to be a cashback is still filed under Bank Offer —
// so it is matched first, before the keyword fallback.
const LABEL_PREFIX: Array<[OfferType, RegExp]> = [
  ['no_cost_emi', /^\s*no[\s-]?cost\s*emi\b/i],
  ['bank_offer', /^\s*bank offer\b/i],
  ['cashback', /^\s*cash\s?back\b/i],
  ['coupon', /^\s*coupon\b/i],
  ['partner', /^\s*partner offers?\b/i],
  ['exchange', /^\s*exchange( offer)?\b/i],
];

// Keyword fallback for un-prefixed text. Order matters: the more specific
// categories are tested first, because their text also contains generic
// "bank"/"credit card"/"emi" tokens. A cashback offer or a No Cost EMI offer
// would otherwise be misfiled as a plain bank offer.
const CLASSIFICATION: Array<[OfferType, RegExp]> = [
  ['no_cost_emi', /\bno[\s-]?cost\s*emi\b/i],
  ['cashback', /\bcash\s?back\b/i],
  ['exchange', /\bexchange\b/i],
  ['coupon', /\bcoupon\b/i],
  ['partner', /\b(partner offer|gst invoice|business purchase|gst)\b/i],
  ['bank_offer', /\b(bank|credit card|debit card|emi|instant discount|upi)\b/i],
];

export function classifyOffer(text: string): OfferType {
  for (const [type, pattern] of LABEL_PREFIX) {
    if (pattern.test(text)) return type;
  }
  for (const [type, pattern] of CLASSIFICATION) {
    if (pattern.test(text)) return type;
  }
  return 'other';
}

/** Collapse whitespace, strip decorative punctuation, lowercase — the comparison form. */
function comparisonForm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[|•·*_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeOffers(rawTexts: string[]): Offer[] {
  return normalizeOfferCards(rawTexts.map((description) => ({ description })));
}

/**
 * A raw offer entry captured from the page, before normalization. `label` is an
 * optional category hint — e.g. an Amazon offer-card title ("Bank Offer", "No
 * Cost EMI") — which classifies more reliably than the free-text description
 * (whose "EMI"/"Credit Cards" tokens are ambiguous).
 */
export interface RawOffer {
  description: string;
  label?: string;
}

export function normalizeOfferCards(raw: RawOffer[]): Offer[] {
  const seen = new Set<string>();
  const offers: Offer[] = [];
  for (const entry of raw) {
    const description = entry.description.replace(/\s+/g, ' ').trim();
    if (!description) continue;
    const key = comparisonForm(description);
    if (seen.has(key)) continue; // dedupe within a page
    seen.add(key);
    offers.push({
      // Prefer the category hint (card title) when present; fall back to
      // classifying the description text itself.
      type: classifyOffer(entry.label ? `${entry.label} ${description}` : description),
      description,
    });
  }
  // Deterministic order so the hash is order-independent
  return offers.sort((a, b) =>
    comparisonForm(a.description).localeCompare(comparisonForm(b.description)),
  );
}

/** Stable hash over the normalized offer set — the FR-3.4 change-detection primitive. */
export function offersHash(offers: Offer[]): string {
  const canonical = offers
    // Include the type so a re-categorized offer (same wording, different
    // category) is still detected as a change.
    .map((o) => `${o.type}|${comparisonForm(o.description)}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Difference between two offer sets, for FR-3.4 alert payloads. */
export function diffOffers(
  previous: Offer[],
  current: Offer[],
): { added: Offer[]; removed: Offer[] } {
  const prevKeys = new Set(previous.map((o) => comparisonForm(o.description)));
  const currKeys = new Set(current.map((o) => comparisonForm(o.description)));
  return {
    added: current.filter((o) => !prevKeys.has(comparisonForm(o.description))),
    removed: previous.filter((o) => !currKeys.has(comparisonForm(o.description))),
  };
}
