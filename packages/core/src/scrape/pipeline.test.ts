import { describe, expect, it, vi } from 'vitest';
import { CheckError, createTestSession } from '@pricepulse/adapters';
import type { FetchFn, IdentitySession, MarketplaceAdapter } from '@pricepulse/adapters';
import type { ProductSnapshot } from '@pricepulse/shared';
import { performCheck } from './pipeline.js';

const snapshot = (price: number | null, extra: Partial<ProductSnapshot> = {}): ProductSnapshot => ({
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
  ...extra,
});

const browserFetch: FetchFn = async (url) => ({
  url,
  body: '<html>browser</html>',
  tier: 'browser',
  fetchedAt: new Date(),
});

function session(): IdentitySession {
  return createTestSession('flipkart');
}

/** An adapter whose tier-1 fails and whose tier-2 succeeds, or fails differently. */
function stubAdapter(
  tier1Error: CheckError,
  onBrowser: (url: string, pageFetch: FetchFn) => Promise<unknown>,
  parse: () => ProductSnapshot = () => snapshot(114990),
): { adapter: MarketplaceAdapter; fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async (url: string, opts?: { pageFetch?: FetchFn }) => {
    if (!opts?.pageFetch) throw tier1Error;
    return onBrowser(url, opts.pageFetch);
  });
  const adapter = {
    marketplace: 'flipkart',
    domains: ['flipkart.com'],
    recognize: vi.fn(),
    fetch,
    parse: vi.fn(parse),
  } as unknown as MarketplaceAdapter;
  return { adapter, fetch };
}

describe('performCheck tier-2 escalation', () => {
  it('routes the browser fetch THROUGH the adapter so location logic still runs', async () => {
    // Tier-1 could not read the client-rendered page; tier-2 must re-fetch via
    // the adapter (which applies the pincode) — NOT bypass it and record the
    // unlocalised page price.
    const { adapter, fetch } = stubAdapter(
      new CheckError('parse_failed', 'client-rendered page had no price'),
      async (url, pageFetch) => ({ ...(await pageFetch(url)), localized: true }),
    );

    const outcome = await performCheck(adapter, 'https://www.flipkart.com/x/p/itm1?pid=P1', {
      session: session(),
      browserFetch,
      pincode: '122004',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('unreachable');
    expect(outcome.tier).toBe('browser');
    expect(outcome.snapshot.price).toBe(114990); // localised, not the IP-default page price
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({ pincode: '122004', pageFetch: browserFetch });
  });

  it('NEVER escalates a block — the browser would leave from the same flagged IP', async () => {
    // The behaviour this migration deliberately removed. Under proxies, a
    // browser retry left from a different exit node. On one line it is the same
    // address seconds later: not a workaround, a second refusal.
    const { adapter, fetch } = stubAdapter(
      new CheckError('fetch_blocked', 'Flipkart returned HTTP 529'),
      async () => {
        throw new Error('the browser tier must not be reached for a block');
      },
    );

    const outcome = await performCheck(adapter, 'https://www.flipkart.com/x/p/itm1?pid=P1', {
      session: session(),
      browserFetch,
      pincode: '122004',
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.classification).toBe('blocked');
    expect(outcome.tier).toBe('http');
  });

  it('classifies a CAPTCHA as blocked, not as something to retry', async () => {
    const { adapter, fetch } = stubAdapter(
      new CheckError('captcha', 'Amazon presented a CAPTCHA challenge'),
      async () => {
        throw new Error('unreachable');
      },
    );

    const outcome = await performCheck(adapter, 'https://www.amazon.in/dp/X', {
      session: session(),
      browserFetch,
    });

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(outcome.classification).toBe('blocked');
  });

  it('fails the check when the browser tier cannot localise — never records a wrong price', async () => {
    const { adapter } = stubAdapter(
      new CheckError('parse_failed', 'tier-1 could not parse'),
      async () => {
        throw new CheckError('other', 'pincode 122004 pricing unavailable');
      },
    );

    const outcome = await performCheck(adapter, 'https://www.flipkart.com/x/p/itm1?pid=P1', {
      session: session(),
      browserFetch,
      pincode: '122004',
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.error.reason).toBe('other');
    expect(outcome.classification).toBe('error');
    expect(outcome.tier).toBe('browser');
  });

  it('does not escalate a non-escalatable tier-1 failure (e.g. pincode unavailable)', async () => {
    const { adapter, fetch } = stubAdapter(
      new CheckError('other', 'pincode 122004 pricing unavailable'),
      async () => {
        throw new Error('unreachable');
      },
    );

    const outcome = await performCheck(adapter, 'https://www.flipkart.com/x/p/itm1?pid=P1', {
      session: session(),
      browserFetch,
      pincode: '122004',
    });

    expect(outcome.ok).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1); // no browser retry
    expect(outcome.tier).toBe('http');
  });
});

describe('performCheck suspicion', () => {
  /** An adapter whose tier-1 succeeds and returns whatever snapshot is given. */
  function okAdapter(parsed: ProductSnapshot): MarketplaceAdapter {
    return {
      marketplace: 'flipkart',
      domains: ['flipkart.com'],
      recognize: vi.fn(),
      fetch: vi.fn(async (url: string) => ({
        url,
        body: '<html/>',
        tier: 'http' as const,
        fetchedAt: new Date(),
      })),
      parse: vi.fn(() => parsed),
    } as unknown as MarketplaceAdapter;
  }

  it('accepts an ordinary price move', async () => {
    const outcome = await performCheck(okAdapter(snapshot(95_000)), 'https://x/p/i?pid=P1', {
      session: session(),
      lastAcceptedPrice: 100_000,
    });
    expect(outcome.classification).toBe('ok');
  });

  it('holds back a 40%+ move for a second opinion instead of recording it', async () => {
    const outcome = await performCheck(okAdapter(snapshot(50_000)), 'https://x/p/i?pid=P1', {
      session: session(),
      lastAcceptedPrice: 100_000,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.classification).toBe('suspect');
    if (outcome.classification !== 'suspect') throw new Error('unreachable');
    expect(outcome.suspectReason).toBe('price_jump');
    // The snapshot survives, because a second identity has to be asked whether
    // it sees the same thing.
    expect(outcome.snapshot.price).toBe(50_000);
  });

  it('holds back a page that has a title but no price', async () => {
    const outcome = await performCheck(okAdapter(snapshot(null)), 'https://x/p/i?pid=P1', {
      session: session(),
      lastAcceptedPrice: 100_000,
    });
    expect(outcome.classification).toBe('suspect');
  });

  it('does not suspect an out-of-stock listing for having no price', async () => {
    const outcome = await performCheck(
      okAdapter(snapshot(null, { stockStatus: 'out_of_stock' })),
      'https://x/p/i?pid=P1',
      { session: session(), lastAcceptedPrice: 100_000 },
    );
    expect(outcome.classification).toBe('ok');
  });

  it('stamps the identity on every outcome, for the audit trail', async () => {
    const s = session();
    const outcome = await performCheck(okAdapter(snapshot(95_000)), 'https://x/p/i?pid=P1', {
      session: s,
      lastAcceptedPrice: 100_000,
    });
    expect(outcome.debug.identityId).toBe(s.id);
  });
});
