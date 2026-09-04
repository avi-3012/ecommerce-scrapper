import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@pricepulse/db';
import { CAPACITY_ORDER, capacityUsage, inCapacityIds } from './capacity.js';

function stubPrisma(rows: Array<{ id: string }>, activeCount = rows.length) {
  const findMany = vi.fn().mockResolvedValue(rows);
  const count = vi.fn().mockResolvedValue(activeCount);
  return {
    prisma: { product: { findMany, count } } as unknown as PrismaClient,
    findMany,
  };
}

describe('inCapacityIds', () => {
  it('returns null when capacity is disabled — no restriction, not an empty set', async () => {
    const { prisma, findMany } = stubPrisma([]);
    expect(await inCapacityIds(prisma, 0)).toBeNull();
    // The distinction matters: an empty Set would mean "scrape nothing".
    expect(findMany).not.toHaveBeenCalled();
  });

  it('takes the top N by priority, with a total order so the set cannot flap', async () => {
    const { prisma, findMany } = stubPrisma([{ id: 'a' }, { id: 'b' }]);
    const ids = await inCapacityIds(prisma, 2);

    expect(ids).toEqual(new Set(['a', 'b']));
    const args = findMany.mock.calls[0]?.[0];
    expect(args.take).toBe(2);
    expect(args.where).toEqual({ status: 'active' });
    // Equal priorities must not trade places between cycles, or a product at
    // the boundary gets checked every other cycle.
    expect(args.orderBy).toEqual([...CAPACITY_ORDER]);
  });

  it('only lets active products hold a slot', async () => {
    const { prisma, findMany } = stubPrisma([{ id: 'a' }]);
    await inCapacityIds(prisma, 1);
    // A paused or auto-paused listing must free its slot, or one dead product
    // denies a live one forever.
    expect(findMany.mock.calls[0]?.[0]?.where?.status).toBe('active');
  });
});

describe('capacityUsage', () => {
  it('splits active products into scraped and waiting', async () => {
    const { prisma } = stubPrisma([], 300);
    expect(await capacityUsage(prisma, 50)).toEqual({
      capacity: 50,
      active: 300,
      scraped: 50,
      waiting: 250,
    });
  });

  it('reports everything as scraped when capacity is off', async () => {
    const { prisma } = stubPrisma([], 300);
    expect(await capacityUsage(prisma, 0)).toEqual({
      capacity: 0,
      active: 300,
      scraped: 300,
      waiting: 0,
    });
  });

  it('never reports more scraped than exist', async () => {
    const { prisma } = stubPrisma([], 12);
    expect(await capacityUsage(prisma, 50)).toMatchObject({ scraped: 12, waiting: 0 });
  });
});
