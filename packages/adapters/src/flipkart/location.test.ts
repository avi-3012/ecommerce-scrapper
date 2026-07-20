import { describe, expect, it } from 'vitest';
import { extractApiPricing, extractAppliedPincode } from './location.js';

const pageFetch = (pageContext: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ RESPONSE: { pageData: { pageContext }, ...extra } });

describe('extractApiPricing (Flipkart page/fetch API)', () => {
  it('reads the authoritative buy-box price from pageContext.pricing', () => {
    const json = pageFetch({ pricing: { finalPrice: { value: 54990 }, mrp: 69629 } });
    expect(extractApiPricing(json)).toEqual({ price: 54990, mrp: 69629, stockStatus: 'in_stock' });
  });

  it('ignores accessory / variant prices elsewhere in the response (no flapping)', () => {
    // The main price is ₹54,990; the response also carries an accessory at
    // ₹269/₹999 and a second variant — none of which must be picked.
    const json = pageFetch(
      { pricing: { finalPrice: { value: 54990 }, mrp: 69629 } },
      {
        slots: [
          { widget: { data: { products: [{ pricing: { finalPrice: 269, mrp: 999 } }] } } },
          { widget: { data: { pricing: { finalPrice: 66990, mrp: 79999 } } } },
        ],
      },
    );
    expect(extractApiPricing(json)?.price).toBe(54990);
  });

  it('falls back to the psi.ppd tracking block when pricing is absent', () => {
    const json = pageFetch({
      fdpEventTracking: { events: { psi: { ppd: { finalPrice: 39999, mrp: 45999 } } } },
    });
    expect(extractApiPricing(json)).toEqual({ price: 39999, mrp: 45999, stockStatus: 'in_stock' });
  });

  it('marks out of stock when the product context flags it', () => {
    const json = pageFetch({
      pricing: { finalPrice: { value: 100 }, mrp: 120 },
      availability: { availabilityStatus: 'OUT_OF_STOCK' },
    });
    expect(extractApiPricing(json)?.stockStatus).toBe('out_of_stock');
  });

  it('drops an MRP below the price', () => {
    const json = pageFetch({ pricing: { finalPrice: { value: 54990 }, mrp: 999 } });
    expect(extractApiPricing(json)?.mrp).toBeNull();
  });

  it('returns null on missing pageContext or bad JSON', () => {
    expect(extractApiPricing('{"a":1}')).toBeNull();
    expect(extractApiPricing('not json')).toBeNull();
  });
});

describe('extractAppliedPincode', () => {
  it('reads the resolved delivery pincode from the pincode component', () => {
    const json = JSON.stringify({
      RESPONSE: {
        data: {
          pincodeData: {
            pincodeComponent: {
              value: {
                type: 'PINCODE',
                city: 'Mumbai',
                pincode: 400001,
                sellerCount: 3,
                singleSeller: false,
              },
            },
          },
        },
      },
    });
    expect(extractAppliedPincode(json)).toBe('400001');
  });

  it('returns null when the component is absent or JSON is bad', () => {
    expect(extractAppliedPincode('{"a":1}')).toBeNull();
    expect(extractAppliedPincode('nope')).toBeNull();
  });
});
