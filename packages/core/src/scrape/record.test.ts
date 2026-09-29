import { describe, expect, it, vi } from 'vitest';
import { CheckError } from '@pricepulse/adapters';
import type { PrismaClient, Product, Settings } from '@pricepulse/db';
import { recordCheck } from './record.js';
import type { CheckOutcome } from './pipeline.js';

const NOW = new Date('2026-09-03T11:20:00.000Z');

const product = (over: Partial<Product> = {}): Product =>
  ({
    id: 'p1',
    userId: 'u1',
    status: 'active',
    consecutiveFailures: 19,
    checkIntervalMinutes: 1,
    lastCheckedAt: new Date('2026-09-03T11:12:00.000Z'),
    lastSuccessAt: new Date('2026-09-03T11:12:00.000Z'),
    lastChangedAt: null,
    currentPrice: null,
    currentMrp: null,
    currentOffers: [],
    currentStockStatus: 'in_stock',
    ...over,
  }) as unknown as Product;

const settings = {
  checkIntervalMinutes: 1,
  consecutiveFailureLimit: 20,
} as unknown as Settings;

const failure = (error: CheckError): CheckOutcome =>
  ({
    ok: false,
    classification: 'error',
    error,
    tier: 'http',
    durationMs: 90_000,
    debug: {},
  }) as CheckOutcome;

function stubPrisma(): { prisma: PrismaClient; update: ReturnType<typeof vi.fn> } {
  const update = vi.fn().mockResolvedValue({});
  const prisma = {
    product: { update },
    priceHistory: { create: vi.fn() },
    alert: { create: vi.fn() },
    $transaction: vi.fn().mockResolvedValue([{}, {}, undefined]),
  } as unknown as PrismaClient;
  return { prisma, update };
}

describe('recordCheck — a listing the marketplace moved', () => {
  const NAME =
    'HP 14 Smartchoice, Intel Core Ultra 5 125H 12 TOPS, 24GB DDR5 (Upgradeable) 1TB SSD';
  const OLD = 'https://www.amazon.in/dp/B0GWQC4JGJ';
  const NEW = 'https://www.amazon.in/dp/B0G2BHDDB8';
  const movedTo = (name: string) =>
    failure(
      new CheckError('parse_failed', 'Page is for ASIN B0G2BHDDB8, expected B0GWQC4JGJ', {
        escalate: false,
        movedTo: { productId: 'B0G2BHDDB8', canonicalUrl: NEW, name },
      }),
    );
  // 19 failures of a 20 limit: a check counted as a failure would auto-pause it.
  const tracked = (over: Partial<Product> = {}) =>
    product({
      marketplace: 'amazon_in',
      marketplaceProductId: 'B0GWQC4JGJ',
      url: OLD,
      canonicalUrl: OLD,
      displayName: NAME,
      ...over,
    } as Partial<Product>);
  const rig = (alreadyTracked: { id: string; displayName: string } | null = null) => {
    const stub = stubPrisma();
    Object.assign(stub.prisma.product, { findUnique: vi.fn().mockResolvedValue(alreadyTracked) });
    return stub;
  };
  const detailOf = (prisma: PrismaClient): string =>
    vi.mocked(prisma.priceHistory.create).mock.calls[0]![0].data.failureDetail as string;

  it("follows it when the page carries this product's own title", async () => {
    const { prisma, update } = rig();
    const result = await recordCheck(prisma, tracked(), movedTo(NAME), settings, NOW);

    expect(result.autoPaused).toBe(false);
    expect(update.mock.calls[0]![0].data).toMatchObject({
      url: NEW,
      canonicalUrl: NEW,
      marketplaceProductId: 'B0G2BHDDB8',
      consecutiveFailures: 0,
      nextCheckAt: NOW, // checked again at once, at the new link
    });
    // Still one history row for the check, saying what happened.
    expect(detailOf(prisma)).toContain('now lists this product as B0G2BHDDB8');
  });

  it('matches the title through case, spacing and invisible direction marks', async () => {
    const { prisma, update } = rig();
    await recordCheck(
      prisma,
      tracked(),
      movedTo(`  ${NAME.toUpperCase().replace(/ /g, '  ')}\u200E`),
      settings,
      NOW,
    );
    expect(update.mock.calls[0]![0].data.canonicalUrl).toBe(NEW);
  });

  it('does not follow a page with a different title, and says so', async () => {
    const { prisma, update } = rig();
    const result = await recordCheck(
      prisma,
      tracked(),
      movedTo(NAME.replace('24GB', '16GB')),
      settings,
      NOW,
    );

    expect(result.autoPaused).toBe(true); // an ordinary failure, counted
    expect(update.mock.calls[0]![0].data.canonicalUrl).toBeUndefined();
    expect(detailOf(prisma)).toContain('not switched automatically: its title does not match');
  });

  it('does not follow a product that was never read', async () => {
    const { prisma, update } = rig();
    await recordCheck(
      prisma,
      tracked({ displayName: 'Awaiting first check — B0GWQC4JGJ' }),
      movedTo(NAME),
      settings,
      NOW,
    );
    expect(update.mock.calls[0]![0].data.canonicalUrl).toBeUndefined();
  });

  it('does not take over a listing another product already tracks', async () => {
    const { prisma, update } = rig({ id: 'p2', displayName: NAME });
    await recordCheck(prisma, tracked(), movedTo(NAME), settings, NOW);

    expect(update.mock.calls[0]![0].data.canonicalUrl).toBeUndefined();
    expect(detailOf(prisma)).toContain('B0G2BHDDB8 is already tracked');
  });
});

describe('recordCheck — checks that never made a request', () => {
  // The 3 Sep 2026 incident: a 107-second Amazon block put the connection into
  // a three-hour backoff, during which every due product was still dispatched
  // and refused at the gate. All 22 active products auto-paused on failures
  // that were never sent.
  it('does not count a backoff refusal against the product', async () => {
    const { prisma, update } = stubPrisma();
    const result = await recordCheck(
      prisma,
      product(),
      failure(new CheckError('other', 'Fetching is paused (backoff)', { attempted: false })),
      settings,
      NOW,
    );

    expect(result.autoPaused).toBe(false);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.priceHistory.create).not.toHaveBeenCalled();
    // Only the next attempt moves. The failure budget and the last-checked time
    // describe the PRODUCT, and nothing was learned about it.
    const data = update.mock.calls[0]?.[0]?.data;
    expect(Object.keys(data)).toEqual(['nextCheckAt']);
  });

  it('still counts a real failure, and still auto-pauses at the limit', async () => {
    const { prisma } = stubPrisma();
    const result = await recordCheck(
      prisma,
      product(),
      failure(new CheckError('fetch_blocked', 'Amazon block page detected')),
      settings,
      NOW,
    );

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(result.autoPaused).toBe(true); // 19 + 1 === limit of 20
  });
});

describe('recordCheck — next check follows the marketplace interval', () => {
  // Uses the not-attempted path, which writes only nextCheckAt: the cleanest
  // place to read the interval a product was scheduled with.
  const schedule = async (marketplace: 'amazon_in' | 'flipkart'): Promise<number> => {
    const { prisma, update } = stubPrisma();
    await recordCheck(
      prisma,
      product({ marketplace, checkIntervalMinutes: null } as Partial<Product>),
      failure(new CheckError('other', 'not sent', { attempted: false })),
      {
        checkIntervalMinutes: 30,
        flipkartCheckIntervalMinutes: 5,
        consecutiveFailureLimit: 20,
      } as unknown as Settings,
      NOW,
    );
    const next = update.mock.calls[0]![0].data.nextCheckAt as Date;
    return (next.getTime() - NOW.getTime()) / 60_000;
  };

  it("schedules a Flipkart product on Flipkart's interval", async () => {
    const minutes = await schedule('flipkart');
    expect(minutes).toBeGreaterThanOrEqual(4.5);
    expect(minutes).toBeLessThanOrEqual(5.5);
  });

  it("leaves an Amazon product on Amazon's interval, untouched by Flipkart's", async () => {
    const minutes = await schedule('amazon_in');
    expect(minutes).toBeGreaterThanOrEqual(27);
    expect(minutes).toBeLessThanOrEqual(33);
  });
});
