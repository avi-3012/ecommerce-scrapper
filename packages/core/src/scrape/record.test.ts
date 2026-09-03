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
