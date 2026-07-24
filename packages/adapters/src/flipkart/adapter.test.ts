import { beforeEach, describe, expect, it, vi } from 'vitest';
import { gotScraping } from 'got-scraping';
import type { FetchFn } from '../fetch/http.js';
import { FlipkartAdapter } from './adapter.js';

vi.mock('got-scraping', () => ({ gotScraping: vi.fn() }));
const mockedGot = vi.mocked(gotScraping);

// The exit-IP echo also goes through gotScraping; disable it so the mock sees
// only the page/fetch calls under test.
process.env.SCRAPE_AUDIT_EXIT_IP = '0';

beforeEach(() => mockedGot.mockReset());

/** A buyable page/fetch response localised to 122004 at ₹1,14,990. */
const localizedApiBody = JSON.stringify({
  RESPONSE: {
    pageData: {
      pageContext: {
        pricing: { finalPrice: { value: 114990 }, mrp: 133748 },
        fdpEventTracking: {
          events: { psi: { pls: { isAvailable: true, availabilityStatus: 'IN_STOCK' } } },
        },
      },
    },
    slots: [
      {
        widget: {
          data: {
            pincodeData: {
              pincodeComponent: {
                value: { type: 'PincodeValue', city: 'Gurgaon', pincode: 122004, sellerCount: 4 },
              },
            },
          },
        },
      },
    ],
  },
});

/**
 * The real failure mode behind a phantom price drop: Flipkart echoes the pincode
 * (Gurgaon 122004) but prices the listing from the DEFAULT seller, which does not
 * deliver there — flagged by `unserviceabilityReason` / `errorCode`. Here the
 * default is ₹76,990 while the localised price is ₹86,990.
 */
const unlocalizedApiBody = JSON.stringify({
  RESPONSE: {
    pageData: {
      pageContext: {
        pricing: { finalPrice: { value: 76990 }, mrp: 85990 },
        fdpEventTracking: {
          events: {
            psi: {
              pls: {
                isAvailable: true,
                availabilityStatus: 'IN_STOCK',
                unserviceabilityReason: 'NoServiceableVendor',
                sellerId: '0f68f429dbc14f6c',
              },
            },
          },
        },
      },
    },
    slots: [
      {
        widget: {
          data: {
            pincodeData: {
              pincodeComponent: {
                value: {
                  type: 'PincodeValue',
                  city: 'Gurgaon',
                  errorCode: 'NO_SERVICEABLE_SELLER',
                  pincode: 122004,
                  singleSeller: false,
                },
              },
            },
          },
        },
      },
    ],
  },
});

/** The raw listing HTML a browser fetch would return — ships the IP-default ₹82,990. */
const PAGE_HTML = `<!doctype html><html><head>
  <script type="application/ld+json">{"@type":"Product","name":"HP Victus 15-fa2196tx","offers":{"price":"82990","availability":"https://schema.org/InStock"}}</script>
  </head><body><h1><span>HP Victus 15-fa2196tx</span></h1></body></html>`;

describe('FlipkartAdapter — localisation is tier-independent', () => {
  it('applies the pincode price even when the page is fetched by the browser tier', async () => {
    // The regression: tier-2 escalation fetched the page with the browser and
    // recorded the IP-default ₹82,990 because it skipped the pincode API. Now
    // the browser fetch is passed as `pageFetch`, and the localised ₹1,14,990
    // from the (still-called) page/fetch API must win.
    mockedGot.mockResolvedValue({ statusCode: 200, body: localizedApiBody } as never);

    const browserFetch: FetchFn = vi.fn(async (url) => ({
      url,
      body: PAGE_HTML,
      tier: 'browser' as const,
      fetchedAt: new Date(),
    }));

    const adapter = new FlipkartAdapter();
    const page = await adapter.fetch(
      'https://www.flipkart.com/product/p/itm1234567890abc?pid=MOBHFN6YKGBPYJZD',
      { pincode: '122004', pageFetch: browserFetch },
    );
    const snap = adapter.parse(page);

    expect(browserFetch).toHaveBeenCalledOnce();
    expect(snap.price).toBe(114990);
    expect(snap.mrp).toBe(133748);
    expect(snap.provenance.price).toBe('pincode-api');
    expect(page.tier).toBe('browser');
  });

  it('still refuses to record an IP-default price when the browser tier cannot localise', async () => {
    // page/fetch never confirms our pincode → no localised price → the adapter
    // throws rather than falling back to the ₹82,990 the page shipped.
    mockedGot.mockResolvedValue({
      statusCode: 200,
      body: JSON.stringify({ RESPONSE: { pageData: { pageContext: { pricing: {} } } } }),
    } as never);

    const browserFetch: FetchFn = async (url) => ({
      url,
      body: PAGE_HTML,
      tier: 'browser',
      fetchedAt: new Date(),
    });

    const adapter = new FlipkartAdapter();
    await expect(
      adapter.fetch('https://www.flipkart.com/product/p/itm1234567890abc?pid=MOBHFN6YKGBPYJZD', {
        pincode: '122004',
        pageFetch: browserFetch,
      }),
    ).rejects.toMatchObject({ reason: 'other' });
  });
});

describe('FlipkartAdapter — a non-delivering seller never sets the price', () => {
  const URL_ = 'https://www.flipkart.com/product/p/itm1234567890abc?pid=MOBHFN6YKGBPYJZD';
  const pageFetch: FetchFn = async (url) => ({
    url,
    body: PAGE_HTML,
    tier: 'http' as const,
    fetchedAt: new Date(),
  });

  it('retries past a NoServiceableVendor response and records the localised price', async () => {
    // Exactly the phantom-drop scenario: the first response prices the listing
    // from the default seller (₹76,990) while echoing our pincode; the retry
    // returns the properly localised price, which is what must be recorded.
    mockedGot
      .mockResolvedValueOnce({ statusCode: 200, body: unlocalizedApiBody } as never)
      .mockResolvedValue({ statusCode: 200, body: localizedApiBody } as never);

    const adapter = new FlipkartAdapter();
    const debug = {};
    const page = await adapter.fetch(URL_, { pincode: '122004', pageFetch, debug });
    const snap = adapter.parse(page);

    expect(snap.price).toBe(114990); // the localised price, never the ₹76,990 default
    expect(snap.provenance.price).toBe('pincode-api');
    expect(mockedGot).toHaveBeenCalledTimes(2); // first response rejected, retried
  });

  it('fails the check when every attempt is priced by a non-delivering seller', async () => {
    // No response ever carries a price for the delivery pincode, so there is no
    // local price to record — fail transiently rather than record the default.
    mockedGot.mockResolvedValue({ statusCode: 200, body: unlocalizedApiBody } as never);

    const adapter = new FlipkartAdapter();
    const debug: { pincode?: { locationErrorCode?: string | null } } = {};
    await expect(
      adapter.fetch(URL_, { pincode: '122004', pageFetch, debug }),
    ).rejects.toMatchObject({ reason: 'other' });
    // The audit trail names why, so the cause is explainable without re-scraping.
    expect(debug.pincode?.locationErrorCode).toBe('NO_SERVICEABLE_SELLER');
  });
});
