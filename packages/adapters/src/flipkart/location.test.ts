import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gotScraping } from 'got-scraping';
import {
  extractApiPricing,
  extractAppliedPincode,
  extractListingAvailability,
  fetchFlipkartPincodePricing,
  isUnbuyable,
} from './location.js';

vi.mock('got-scraping', () => ({ gotScraping: vi.fn() }));
const mockedFetch = vi.mocked(gotScraping);

const pageFetch = (pageContext: unknown, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ RESPONSE: { pageData: { pageContext }, ...extra } });

/** The `pls` node Flipkart's own front end uses to decide buyability. */
const pls = (fields: Record<string, unknown>): Record<string, unknown> => ({
  fdpEventTracking: { events: { psi: { pls: fields } } },
});

/** The delivery widget, which Flipkart populates ONLY for a buyable listing. */
const pincodeSlot = (pincode: number | null): Record<string, unknown> => ({
  slots: [
    {
      widget: {
        data: {
          pincodeData: {
            pincodeComponent: {
              value:
                pincode === null
                  ? null
                  : { type: 'PincodeValue', city: 'Gurgaon', pincode, sellerCount: 4 },
            },
          },
        },
      },
    },
  ],
});

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

  it('returns null for an out-of-stock listing, whose component value is null', () => {
    // Regression: Flipkart populates the delivery widget only for a buyable
    // listing, so an out-of-stock item echoes NO pincode. That must not be read
    // as "our pincode was rejected".
    const json = pageFetch({ pricing: { finalPrice: { value: 82900 } } }, pincodeSlot(null));
    expect(extractAppliedPincode(json)).toBeNull();
  });
});

describe('extractListingAvailability / isUnbuyable', () => {
  it('reads Flipkart’s own buyability verdict from psi.pls', () => {
    const json = pageFetch(
      pls({
        isAvailable: false,
        availabilityStatus: 'OUT_OF_STOCK',
        unserviceabilityReason: 'NotAvailable',
        listingState: 'comingback',
      }),
    );
    const availability = extractListingAvailability(json);
    expect(availability).toEqual({
      isAvailable: false,
      availabilityStatus: 'OUT_OF_STOCK',
      unserviceabilityReason: 'NotAvailable',
      listingState: 'comingback',
    });
    expect(isUnbuyable(availability)).toBe(true);
  });

  it('treats a buyable in-stock listing as buyable', () => {
    const json = pageFetch(
      pls({ isAvailable: true, availabilityStatus: 'IN_STOCK', isServiceable: true }),
    );
    expect(isUnbuyable(extractListingAvailability(json))).toBe(false);
  });

  it('is inconclusive (never unbuyable) when the node is absent', () => {
    const availability = extractListingAvailability(pageFetch({ pricing: {} }));
    expect(availability.isAvailable).toBeNull();
    expect(isUnbuyable(availability)).toBe(false);
  });

  it('marks out of stock from pls even though a price is still quoted', () => {
    // The out-of-stock response still carries the seller's list price; it just
    // is not buyable, so no price may be recorded from it.
    const json = pageFetch({
      pricing: { finalPrice: { value: 82900 }, mrp: 82900 },
      ...pls({ isAvailable: false, availabilityStatus: 'OUT_OF_STOCK' }),
    });
    expect(extractApiPricing(json)?.stockStatus).toBe('out_of_stock');
  });
});

describe('fetchFlipkartPincodePricing (verification vs. stock)', () => {
  const respond = (body: string): void => {
    mockedFetch.mockResolvedValue({ statusCode: 200, body } as never);
  };

  beforeEach(() => {
    mockedFetch.mockReset();
  });

  it('returns a trusted out-of-stock result WITHOUT a pincode echo, on the first try', async () => {
    // The exact shape that auto-paused the iPhone 17 / DELL 15 listings: HTTP
    // 200, a price present, pls says OUT_OF_STOCK, and no pincode component.
    respond(
      pageFetch(
        {
          pricing: { finalPrice: { value: 82900 }, mrp: 82900 },
          ...pls({ isAvailable: false, availabilityStatus: 'OUT_OF_STOCK' }),
        },
        pincodeSlot(null),
      ),
    );

    const result = await fetchFlipkartPincodePricing('/product/p/itm1?pid=P1', '122004');

    expect(result.pricing).toEqual({
      price: null,
      mrp: null,
      stockStatus: 'out_of_stock',
      pincode: '122004',
    });
    expect(result.verified).toBe(false); // honest: no echo was received
    expect(result.availability?.availabilityStatus).toBe('OUT_OF_STOCK');
    // Terminal: retrying cannot produce an echo Flipkart never sends.
    expect(result.attempts).toBe(1);
    expect(mockedFetch).toHaveBeenCalledTimes(1);
  });

  it('trusts a buyable listing only once OUR pincode is echoed back', async () => {
    respond(
      pageFetch(
        {
          pricing: { finalPrice: { value: 89990 }, mrp: 133748 },
          ...pls({ isAvailable: true, availabilityStatus: 'IN_STOCK' }),
        },
        pincodeSlot(122004),
      ),
    );

    const result = await fetchFlipkartPincodePricing('/product/p/itm2?pid=P2', '122004');

    expect(result.pricing).toEqual({
      price: 89990,
      mrp: 133748,
      stockStatus: 'in_stock',
      pincode: '122004',
    });
    expect(result.verified).toBe(true);
    expect(result.attempts).toBe(1);
  });

  it('refuses a buyable listing priced for the WRONG pincode, after retrying', async () => {
    // The flapping guard: a different resolved pincode means the IP-default
    // price. Never record it — retry, then give up with no price.
    respond(
      pageFetch(
        {
          pricing: { finalPrice: { value: 79990 } },
          ...pls({ isAvailable: true, availabilityStatus: 'IN_STOCK' }),
        },
        pincodeSlot(560001),
      ),
    );

    const result = await fetchFlipkartPincodePricing('/product/p/itm3?pid=P3', '122004');

    expect(result.pricing).toBeNull();
    expect(result.verified).toBe(false);
    expect(result.applied).toBe('560001');
    expect(result.attempts).toBe(3);
  });
});
