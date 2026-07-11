import { describe, expect, it } from 'vitest';
import { classifyOffer, diffOffers, normalizeOffers, offersHash } from './offers.js';

describe('offer classification', () => {
  it.each([
    ['10% Instant Discount on HDFC Bank Credit Card', 'bank_offer'],
    ['Flat ₹100 off coupon', 'coupon'],
    ['5% Cashback on Flipkart Axis Bank Card', 'bank_offer'],
    ['Get ₹500 cashBack on first order', 'cashback'],
    ['Up to ₹20,000 off on exchange', 'exchange'],
    ['Free delivery on orders above ₹499', 'other'],
  ])('"%s" → %s', (text, expected) => {
    expect(classifyOffer(text)).toBe(expected);
  });
});

describe('offersHash stability rules (FR-3.4 primitive)', () => {
  const offerA = 'Bank Offer: 10% Instant Discount up to ₹1,500 on HDFC Bank Credit Card';
  const offerB = 'Apply ₹2,000 coupon';

  it('is order-independent', () => {
    expect(offersHash(normalizeOffers([offerA, offerB]))).toBe(
      offersHash(normalizeOffers([offerB, offerA])),
    );
  });

  it('ignores whitespace and decorative punctuation differences', () => {
    expect(offersHash(normalizeOffers([`  ${offerA.replace(/ /g, '  ')} • `]))).toBe(
      offersHash(normalizeOffers([offerA])),
    );
  });

  it('changes when an amount inside an offer changes', () => {
    expect(offersHash(normalizeOffers([offerA]))).not.toBe(
      offersHash(normalizeOffers([offerA.replace('₹1,500', '₹2,000')])),
    );
  });

  it('changes when an offer is added or removed', () => {
    expect(offersHash(normalizeOffers([offerA]))).not.toBe(
      offersHash(normalizeOffers([offerA, offerB])),
    );
    expect(offersHash(normalizeOffers([]))).not.toBe(offersHash(normalizeOffers([offerA])));
  });

  it('dedupes repeated offers within a page', () => {
    expect(normalizeOffers([offerA, offerA, ` ${offerA} `])).toHaveLength(1);
  });
});

describe('diffOffers (FR-3.4 alert payload)', () => {
  it('reports added and removed offers', () => {
    const prev = normalizeOffers(['Bank Offer: 10% off HDFC', 'Free delivery deal']);
    const curr = normalizeOffers(['Bank Offer: 10% off HDFC', 'Apply ₹500 coupon']);
    const diff = diffOffers(prev, curr);
    expect(diff.added.map((o) => o.description)).toEqual(['Apply ₹500 coupon']);
    expect(diff.removed.map((o) => o.description)).toEqual(['Free delivery deal']);
  });
});
