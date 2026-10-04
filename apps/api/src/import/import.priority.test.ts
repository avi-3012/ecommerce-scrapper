import { describe, expect, it, vi } from 'vitest';
import { ImportController } from './import.controller.js';
import { ImportService } from './import.service.js';
import type { ImportReview } from './import.service.js';
import type { PrismaService } from '../prisma.service.js';
import type { JobsService } from '../jobs.service.js';

const review = (rows: number): ImportReview => ({
  filename: 'FK laptops link.xlsx',
  totalRows: rows,
  valid: Array.from({ length: rows }, (_, i) => ({
    rowNumber: i + 2,
    url: `https://www.flipkart.com/product/p/itm00000000000${i}?pid=COMHG6XZUYVABC${String(i).padStart(2, '0')}`,
    canonicalUrl: `https://www.flipkart.com/product/p/itm00000000000${i}?pid=COMHG6XZUYVABC${String(i).padStart(2, '0')}`,
    marketplace: 'flipkart',
    marketplaceProductId: `COMHG6XZUYVABC${String(i).padStart(2, '0')}`,
  })),
  duplicates: [],
  invalid: [],
});

/** An import service over a database that records what it was asked to create. */
function rig() {
  const create = vi.fn(async () => ({}));
  const prisma = {
    user: { findFirst: async () => ({ id: 'u1', settings: {} }) },
    product: { create, count: async () => 0 },
    importBatch: { create: async () => ({ id: 'b1' }) },
  } as unknown as PrismaService;
  const service = new ImportService(prisma, {} as JobsService);
  const created = () =>
    create.mock.calls.map((call) => (call as unknown as [{ data: { priority?: number } }])[0].data);
  return { service, created };
}

describe('import priority', () => {
  it('gives every imported product the priority typed for the file', async () => {
    const { service, created } = rig();
    const result = await service.execute(review(3), 4);
    expect(result.imported).toBe(3);
    expect(created().map((data) => data.priority)).toEqual([4, 4, 4]);
  });

  it('leaves the default priority when none is given', async () => {
    const { service, created } = rig();
    await service.execute(review(2));
    expect(created().every((data) => !('priority' in data))).toBe(true);
  });

  it('refuses a priority that is not a whole number from 1 up, before importing anything', async () => {
    const execute = vi.fn();
    const controller = new ImportController({ execute } as unknown as ImportService);
    for (const priority of [0, 2.5, '3', -1]) {
      await expect(controller.execute({ ...review(1), priority })).rejects.toThrow(
        'Priority must be a whole number',
      );
    }
    expect(execute).not.toHaveBeenCalled();
  });
});
