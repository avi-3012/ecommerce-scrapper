import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gotScraping } from 'got-scraping';
import {
  extractApiPricing,
  extractAppliedPincode,
  extractListingAvailability,
  fetchFlipkartPincodePricing,
  isUnbuyable,
} from './location.js';
import { createTestSession } from '../identity/testing.js';
import type { IdentitySession } from '../identity/session.js';

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
    // The session reads the raw (compressed) body; identity encoding here.
    mockedFetch.mockResolvedValue({
      statusCode: 200,
      body,
      rawBody: Buffer.from(body),
      headers: {},
    } as never);
  };

  // A real identity session over a throwaway store: the pincode call must carry
  // the identity's own UA in `x-user-agent`, so a stub session would test nothing.
  let session: IdentitySession;

  beforeEach(() => {
    mockedFetch.mockReset();
    session = createTestSession('flipkart');
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

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122004');

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

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm2?pid=P2', '122004');

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

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm3?pid=P3', '122004');

    expect(result.pricing).toBeNull();
    expect(result.verified).toBe(false);
    expect(result.applied).toBe('560001');
    expect(result.attempts).toBe(3);
  });
});

/**
 * A page/fetch response in Flipkart's current widget format, trimmed from live
 * captures to the fields that decide localisation. Each call is priced for the
 * location the session held BEFORE it (`pricedFor`), while the delivery widget
 * and the warranty link echo the pincode the call asked for (`asked`). Only the
 * payments callout's `pin` names the pricing location: `-1` for none.
 */
const liveResponse = (fields: {
  asked: string;
  pricedFor: string;
  price: number;
  mrp?: number;
  /** pls.unserviceabilityReason, e.g. "NO_PINCODE" or "NoServiceableVendor". */
  reason?: string;
  availabilityStatus?: string;
  /** The delivery widget is left out for a listing that cannot be delivered. */
  delivery?: boolean;
  /** Some listings show no payments callout at all. */
  payments?: boolean;
}): string => {
  const { asked, pricedFor, reason } = fields;
  const inStock = (fields.availabilityStatus ?? 'IN_STOCK') === 'IN_STOCK';
  const deliveryWidget = {
    widget: {
      type: 'ATLAS_WIDGET',
      data: {
        dlsData: {
          default_fk_pp_delivery_widget_address_bar_location_tag_test_0: {
            value: { label_0: { value: { text: asked } } },
          },
          box_2: {
            action: {
              type: 'NAVIGATION',
              params: {
                pin: asked,
                pageKey: 'delivery-page',
                url: `https://www.flipkart.com/item/product-delivery/itemId?pageKey=delivery-page&marketplace=FLIPKART&pin=${asked}&lid=LSTCOM1&pid=COM1`,
              },
            },
          },
        },
      },
    },
  };
  // Echoes the request, like the delivery widget — listed first, so a reader
  // that took the first `pin=` it met would get the wrong one.
  const warrantyWidget = {
    widget: {
      type: 'ATLAS_WIDGET',
      data: {
        dlsData: {
          box_2: {
            action: {
              url: `https://www.flipkart.com/item/product-warranty/itemId?pageKey=product-warranty&marketplace=FLIPKART&pin=${asked}&lid=LSTCOM1`,
            },
          },
        },
      },
    },
  };
  const paymentsWidget = {
    widget: {
      type: 'ATLAS_WIDGET',
      data: {
        dlsData: {
          gridData_0: {
            value: [
              {},
              {
                value: {
                  row_1: {
                    action: {
                      params: {
                        url: `https://www.flipkart.com/item/payments-callout/itemId?pageKey=payments-callout&marketplace=Flipkart&pin=${pricedFor}&lid=LSTCOM1&pid=COM1`,
                      },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };
  return JSON.stringify({
    RESPONSE: {
      pageData: {
        pageContext: {
          fdpEventTracking: {
            events: {
              psi: {
                pls: {
                  sellerId: '8187b3fdf3d64605',
                  ...(reason ? { unserviceabilityReason: reason } : {}),
                  listingId: 'LSTCOM1',
                  availabilityStatus: fields.availabilityStatus ?? 'IN_STOCK',
                  listingState: 'current',
                  isAvailable: inStock,
                  isServiceable: inStock && !reason,
                },
                ppd: { finalPrice: fields.price, fsp: fields.price, mrp: fields.mrp ?? null },
              },
            },
          },
        },
      },
      slots: [
        ...(fields.delivery === false ? [] : [deliveryWidget]),
        warrantyWidget,
        ...(fields.payments === false ? [] : [paymentsWidget]),
      ],
    },
  });
};

describe('fetchFlipkartPincodePricing — the pincode takes effect one call late', () => {
  const reply = (body: string) =>
    ({ statusCode: 200, body, rawBody: Buffer.from(body), headers: {} }) as never;
  const inTurn = (...bodies: string[]): void => {
    for (const body of bodies) mockedFetch.mockResolvedValueOnce(reply(body));
  };

  // The live sequence for one laptop through a fresh identity: first quoted with
  // no location at ₹1,25,990 by a seller delivering in a week, then — once the
  // session holds 122001 — at ₹1,39,990 by a seller delivering tomorrow.
  const noLocation = liveResponse({
    asked: '122001',
    pricedFor: '-1',
    reason: 'NO_PINCODE',
    price: 125990,
    mrp: 135000,
  });
  const localised = liveResponse({
    asked: '122001',
    pricedFor: '122001',
    price: 139990,
    mrp: 228090,
  });

  let session: IdentitySession;

  beforeEach(() => {
    mockedFetch.mockReset();
    session = createTestSession('flipkart');
  });

  it('records the price for our pincode, not the no-location price a fresh session gets first', async () => {
    inTurn(noLocation, localised);

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing).toEqual({
      price: 139990,
      mrp: 228090,
      stockStatus: 'in_stock',
      pincode: '122001',
    });
    expect(result.verified).toBe(true);
    expect(result.applied).toBe('122001');
    expect(result.attempts).toBe(2);
    // The audit keeps the bytes the price came from.
    expect(result.sample).toContain('"finalPrice":139990');
  });

  it('needs one call once the session already holds our pincode', async () => {
    inTurn(localised);

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing?.price).toBe(139990);
    expect(result.attempts).toBe(1);
  });

  it('never reads a no-location answer as "no seller delivers here"', async () => {
    // NO_PINCODE comes with isServiceable: false. Counted as a delivery verdict,
    // three of them recorded an in-stock laptop as out of stock.
    mockedFetch.mockResolvedValue(reply(noLocation));

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing).toBeNull();
    expect(result.verified).toBe(false);
    expect(result.availability?.unserviceabilityReason).toBe('NO_PINCODE');
    expect(result.attempts).toBe(3);
  });

  it("refuses the session's previous pincode's price, though every echo shows ours", async () => {
    const previous = liveResponse({ asked: '122001', pricedFor: '560001', price: 131990 });
    inTurn(previous, localised);

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing?.price).toBe(139990);
    expect(result.attempts).toBe(2);
  });

  it('gives up with no price while every answer is priced for somewhere else', async () => {
    mockedFetch.mockResolvedValue(
      reply(liveResponse({ asked: '122001', pricedFor: '560001', price: 131990 })),
    );

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing).toBeNull();
    expect(result.applied).toBe('560001');
  });

  it('takes "not deliverable" about another pincode as no verdict on ours', async () => {
    // Asked for 122001 by a session still at Port Blair: Flipkart answers
    // NoServiceableVendor about Port Blair, then prices 122001 normally.
    const portBlair = liveResponse({
      asked: '122001',
      pricedFor: '744101',
      reason: 'NoServiceableVendor',
      price: 61499,
      delivery: false,
    });
    inTurn(portBlair, localised);

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing?.stockStatus).toBe('in_stock');
    expect(result.pricing?.price).toBe(139990);
  });

  it('marks out of stock when every answer priced for OUR pincode says nobody delivers', async () => {
    const undeliverable = (pricedFor: string): string =>
      liveResponse({
        asked: '744101',
        pricedFor,
        reason: 'NoServiceableVendor',
        price: 61499,
        delivery: false,
      });
    inTurn(undeliverable('122001'), undeliverable('744101'), undeliverable('744101'));

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '744101');

    expect(result.pricing).toEqual({
      price: null,
      mrp: null,
      stockStatus: 'out_of_stock',
      pincode: '744101',
    });
    expect(result.attempts).toBe(3);
  });

  it('reaches no delivery verdict from answers priced only for another pincode', async () => {
    mockedFetch.mockResolvedValue(
      reply(
        liveResponse({
          asked: '122001',
          pricedFor: '744101',
          reason: 'NoServiceableVendor',
          price: 61499,
          delivery: false,
        }),
      ),
    );

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing).toBeNull(); // failed, not "out of stock"
  });

  it('records out of stock on the first answer, whatever location it was priced for', async () => {
    mockedFetch.mockResolvedValue(
      reply(
        liveResponse({
          asked: '122001',
          pricedFor: '744101',
          reason: 'NotAvailable',
          availabilityStatus: 'OUT_OF_STOCK',
          price: 57990,
          delivery: false,
        }),
      ),
    );

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing?.stockStatus).toBe('out_of_stock');
    expect(result.attempts).toBe(1);
  });

  it('without a payments callout, trusts only a call this check has already moved', async () => {
    // Nothing on such a listing names the pricing location, so the first answer
    // may belong to wherever the session was. The second is priced for ours:
    // the first call moved the session there.
    const unmarked = (price: number): string =>
      liveResponse({ asked: '122001', pricedFor: '122001', price, payments: false });
    inTurn(unmarked(131990), unmarked(139990));

    const result = await fetchFlipkartPincodePricing(session, '/product/p/itm1?pid=P1', '122001');

    expect(result.pricing?.price).toBe(139990);
    expect(result.verified).toBe(true);
    expect(result.attempts).toBe(2);
  });
});
