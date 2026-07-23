import { describe, expect, it, vi } from 'vitest';
import { CheckError } from '@pricepulse/adapters';
import type { FetchFn, MarketplaceAdapter } from '@pricepulse/adapters';
import type { ProductSnapshot } from '@pricepulse/shared';
import { performCheck } from './pipeline.js';

const snapshot = (price: number): ProductSnapshot => ({
  marketplace: 'flipkart',
  marketplaceProductId: 'P1',
  name: 'HP Victus 15-fa2196tx',
  price,
  mrp: price,
  discountPct: 0,
  offers: [],
  stockStatus: 'in_stock',
  imageUrl: null,
  provenance: { price: 'pincode-api' },
});

const browserFetch: FetchFn = async (url) => ({
  url,
  body: '<html>browser</html>',
  tier: 'browser',
  fetchedAt: new Date(),
});

describe('performCheck tier-2 escalation', () => {
  it('routes the browser fetch THROUGH the adapter so location logic still runs', async () => {
    // Tier-1 is blocked; tier-2 must re-fetch via the adapter (which applies the
    // pincode) — NOT bypass it and record the unlocalised page price. The fake
    // adapter returns the localised ₹1,14,990 only when it is handed the browser
    // fetch, mirroring how the real adapter localises regardless of tier.
    const parse = vi.fn(() => snapshot(114990));
    const fetch = vi.fn(async (_url: string, opts?: { pageFetch?: FetchFn }) => {
      if (!opts?.pageFetch) throw new CheckError('fetch_blocked', 'tier-1 blocked');
      const page = await opts.pageFetch(_url);
      return { ...page, localized: true };
    });
    const adapter = {
      marketplace: 'flipkart',
      domains: ['flipkart.com'],
      recognize: vi.fn(),
      fetch,
      parse,
    } as unknown as MarketplaceAdapter;

    const outcome = await performCheck(adapter, 'https://www.flipkart.com/x/p/itm1?pid=P1', {
      browserFetch,
      pincode: '122004',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.tier).toBe('browser');
    expect(outcome.snapshot.price).toBe(114990); // localised, not the IP-default page price
    // Tier-2 went through adapter.fetch, carrying the pincode and the browser fetch.
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ pincode: '122004', pageFetch: browserFetch });
  });

  it('fails the check when the browser tier cannot localise — never records a wrong price', async () => {
    // The adapter refuses to localise on either tier (e.g. Flipkart pincode
    // unverifiable). The outcome must be a failure so the caller preserves the
    // last known price, rather than a success carrying the IP-default price.
    const fetch = vi.fn(async (_url: string, opts?: { pageFetch?: FetchFn }) => {
      if (!opts?.pageFetch) throw new CheckError('fetch_blocked', 'tier-1 blocked');
      throw new CheckError('other', 'pincode 122004 pricing unavailable');
    });
    const adapter = {
      marketplace: 'flipkart',
      domains: ['flipkart.com'],
      recognize: vi.fn(),
      fetch,
      parse: vi.fn(),
    } as unknown as MarketplaceAdapter;

    const outcome = await performCheck(adapter, 'https://www.flipkart.com/x/p/itm1?pid=P1', {
      browserFetch,
      pincode: '122004',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.reason).toBe('other');
    expect(outcome.tier).toBe('browser');
  });

  it('does not escalate a non-escalatable tier-1 failure (e.g. pincode unavailable)', async () => {
    const fetch = vi.fn(async () => {
      throw new CheckError('other', 'pincode 122004 pricing unavailable');
    });
    const adapter = {
      marketplace: 'flipkart',
      domains: ['flipkart.com'],
      recognize: vi.fn(),
      fetch,
      parse: vi.fn(),
    } as unknown as MarketplaceAdapter;

    const outcome = await performCheck(adapter, 'https://www.flipkart.com/x/p/itm1?pid=P1', {
      browserFetch,
      pincode: '122004',
    });

    expect(outcome.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // no browser retry
    expect(outcome.tier).toBe('http');
  });
});
