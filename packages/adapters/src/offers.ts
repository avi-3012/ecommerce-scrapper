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

const CLASSIFICATION: Array<[OfferType, RegExp]> = [
  ['bank_offer', /\b(bank|credit card|debit card|emi|instant discount|upi)\b/i],
  ['coupon', /\bcoupon\b/i],
  ['cashback', /\bcash\s?back\b/i],
  ['exchange', /\bexchange\b/i],
];

export function classifyOffer(text: string): OfferType {
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
  const seen = new Set<string>();
  const offers: Offer[] = [];
  for (const raw of rawTexts) {
    const description = raw.replace(/\s+/g, ' ').trim();
    if (!description) continue;
    const key = comparisonForm(description);
    if (seen.has(key)) continue; // dedupe within a page
    seen.add(key);
    offers.push({ type: classifyOffer(description), description });
  }
  // Deterministic order so the hash is order-independent
  return offers.sort((a, b) =>
    comparisonForm(a.description).localeCompare(comparisonForm(b.description)),
  );
}

/** Stable hash over the normalized offer set — the FR-3.4 change-detection primitive. */
export function offersHash(offers: Offer[]): string {
  const canonical = offers
    .map((o) => comparisonForm(o.description))
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
