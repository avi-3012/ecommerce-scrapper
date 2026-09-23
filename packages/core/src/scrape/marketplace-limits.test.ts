import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@pricepulse/db';
import {
  capacityByMarketplace,
  capacityFor,
  inCapacityIds,
  intervalFor,
  scrapeScopeWhere,
} from './capacity.js';
import type { LimitSettings } from './capacity.js';

const settings = (over: Partial<LimitSettings> = {}): LimitSettings => ({
  checkIntervalMinutes: 30,
  scrapeCapacity: null,
  flipkartCheckIntervalMinutes: null,
  flipkartScrapeCapacity: null,
  ...over,
});

describe('intervalFor', () => {
  it('gives Amazon exactly the interval it always had', () => {
    expect(intervalFor('amazon_in', settings({ checkIntervalMinutes: 30 }))).toBe(30);
    // Setting Flipkart's must not move Amazon's.
    expect(
      intervalFor(
        'amazon_in',
        settings({ checkIntervalMinutes: 30, flipkartCheckIntervalMinutes: 5 }),
      ),
    ).toBe(30);
  });

  it("follows Amazon's until Flipkart's is set, then its own", () => {
    expect(intervalFor('flipkart', settings({ checkIntervalMinutes: 30 }))).toBe(30);
    expect(intervalFor('flipkart', settings({ flipkartCheckIntervalMinutes: 5 }))).toBe(5);
  });
});

describe('capacityFor', () => {
  it("keeps Amazon's rule exactly: Settings, else the scraping config", () => {
    expect(capacityFor('amazon_in', settings({ scrapeCapacity: 200 }), 50)).toBe(200);
    expect(capacityFor('amazon_in', settings(), 50)).toBe(50);
  });

  it('reads Flipkart from Settings only — blank means no limit, never the config', () => {
    // The API cannot see a second worker's config file, so a config fallback
    // for Flipkart would make the product list disagree with what is scraped.
    expect(capacityFor('flipkart', settings(), 50)).toBe(0);
    expect(capacityFor('flipkart', settings({ flipkartScrapeCapacity: 120 }), 50)).toBe(120);
  });

  it("never lets one marketplace's limit change the other's", () => {
    const s = settings({ scrapeCapacity: 200, flipkartScrapeCapacity: 5 });
    expect(capacityFor('amazon_in', s, 50)).toBe(200);
    expect(capacityFor('flipkart', s, 50)).toBe(5);
  });
});

describe('per-marketplace capacity cuts', () => {
  function stub(rowsByMarketplace: Record<string, Array<{ id: string }>>) {
    const findMany = vi.fn(async (args: { where: { marketplace?: string } }) =>
      args.where.marketplace ? (rowsByMarketplace[args.where.marketplace] ?? []) : [],
    );
    return { prisma: { product: { findMany } } as unknown as PrismaClient, findMany };
  }

  it('cuts within one marketplace when asked', async () => {
    const { prisma, findMany } = stub({ flipkart: [{ id: 'f1' }] });
    expect(await inCapacityIds(prisma, 1, 'flipkart')).toEqual(new Set(['f1']));
    expect(findMany.mock.calls[0]![0].where).toEqual({ status: 'active', marketplace: 'flipkart' });
  });

  it('builds a scope where each marketplace is cut to its own limit', async () => {
    const { prisma } = stub({ amazon_in: [{ id: 'a1' }, { id: 'a2' }] });
    const where = await scrapeScopeWhere(
      prisma,
      ['amazon_in', 'flipkart'],
      settings({ scrapeCapacity: 2 }),
      0,
    );
    // Amazon capped to its own top 2; Flipkart unlimited, so no id list at all.
    expect(where).toEqual({
      OR: [{ marketplace: 'amazon_in', id: { in: ['a1', 'a2'] } }, { marketplace: 'flipkart' }],
    });
  });

  it('scopes to only the marketplaces a worker owns', async () => {
    const { prisma, findMany } = stub({ flipkart: [{ id: 'f1' }] });
    const where = await scrapeScopeWhere(
      prisma,
      ['flipkart'],
      settings({ flipkartScrapeCapacity: 1 }),
      0,
    );
    expect(where).toEqual({ OR: [{ marketplace: 'flipkart', id: { in: ['f1'] } }] });
    // Amazon's catalogue was never even looked at.
    expect(findMany.mock.calls.every(([a]) => a.where.marketplace === 'flipkart')).toBe(true);
  });

  it('reports each marketplace separately for marking rows', async () => {
    const { prisma } = stub({ amazon_in: [{ id: 'a1' }] });
    const sets = await capacityByMarketplace(prisma, settings({ scrapeCapacity: 1 }), 0);
    expect(sets.amazon_in).toEqual(new Set(['a1']));
    expect(sets.flipkart).toBeNull();
  });
});
