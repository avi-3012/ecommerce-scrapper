import { describe, expect, it } from 'vitest';
import { extractApiPricing } from './location.js';

describe('extractApiPricing (Flipkart page/fetch API)', () => {
  it('picks the product price/MRP (largest finalPrice+mrp pair) and stock', () => {
    const json = JSON.stringify({
      RESPONSE: {
        slots: [
          { emi: { finalPrice: 7778 } }, // EMI sub-amount, no MRP → ignored
          { pricing: { finalPrice: 54990, mrp: 69629 }, availabilityStatus: 'IN_STOCK' },
          { exchange: { finalPrice: 2000, mrp: 3000 } }, // smaller pair → ignored
        ],
      },
    });
    expect(extractApiPricing(json)).toEqual({ price: 54990, mrp: 69629, stockStatus: 'in_stock' });
  });

  it('handles nested {value} price shapes', () => {
    const json = JSON.stringify({
      x: { finalPrice: { value: 39999 }, mrp: { value: 45999 }, availabilityStatus: 'IN_STOCK' },
    });
    expect(extractApiPricing(json)).toEqual({ price: 39999, mrp: 45999, stockStatus: 'in_stock' });
  });

  it('marks out of stock', () => {
    const json = JSON.stringify({
      x: { finalPrice: 100, mrp: 120, availabilityStatus: 'OUT_OF_STOCK' },
    });
    expect(extractApiPricing(json)?.stockStatus).toBe('out_of_stock');
  });

  it('returns null on missing pricing or bad JSON', () => {
    expect(extractApiPricing('{"a":1}')).toBeNull();
    expect(extractApiPricing('not json')).toBeNull();
  });
});
