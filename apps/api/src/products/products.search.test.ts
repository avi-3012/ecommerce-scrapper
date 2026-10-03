import { describe, expect, it } from 'vitest';
import { ProductsController } from './products.controller.js';
import type { PrismaService } from '../prisma.service.js';
import type { JobsService } from '../jobs.service.js';

interface Row {
  id: string;
  marketplace: 'amazon_in' | 'flipkart';
  status: string;
  displayName: string;
  marketplaceProductId: string;
  url: string;
  priority: number;
  createdAt: Date;
  currentPrice: number | null;
  category: null;
}

type Order = Record<string, 'asc' | 'desc'>;

/**
 * Just enough of Prisma for the product list: equality and `id in` filters,
 * multi-key ordering, skip/take. Selects and includes return whole rows —
 * the controller only reads what it asked for.
 */
function fakePrisma(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (key === 'id' && value && typeof value === 'object' && 'in' in value) {
        return (value as { in: string[] }).in.includes(row.id);
      }
      return row[key as keyof Row] === value;
    });
  const compare = (orderBy: Order[]) => (a: Row, b: Row) => {
    for (const order of orderBy) {
      const [key, dir] = Object.entries(order)[0]!;
      const x = a[key as keyof Row] as number | Date | string | null;
      const y = b[key as keyof Row] as number | Date | string | null;
      if (x === y) continue;
      const lt = x === null ? false : y === null ? true : x < y;
      return (lt ? -1 : 1) * (dir === 'asc' ? 1 : -1);
    }
    return 0;
  };
  const findMany = async (args: {
    where?: Record<string, unknown>;
    orderBy?: Order[];
    skip?: number;
    take?: number;
  }) => {
    let found = rows.filter((row) => matches(row, args.where));
    if (args.orderBy) found = [...found].sort(compare(args.orderBy));
    const start = args.skip ?? 0;
    return found.slice(start, args.take === undefined ? undefined : start + args.take);
  };
  return {
    product: {
      findMany,
      count: async (args: { where?: Record<string, unknown> }) =>
        rows.filter((row) => matches(row, args.where)).length,
    },
    user: {
      findFirst: async () => ({
        id: 'u1',
        settings: { scrapeCapacity: null, flipkartScrapeCapacity: null },
      }),
    },
    systemStatus: { findMany: async () => [] },
  } as unknown as PrismaService;
}

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const row = (id: string, displayName: string, over: Partial<Row> = {}): Row => ({
  id,
  marketplace: 'amazon_in',
  status: 'active',
  displayName,
  marketplaceProductId: id.toUpperCase(),
  url: `https://www.amazon.in/dp/${id.toUpperCase()}`,
  priority: 1,
  createdAt: at(1),
  currentPrice: 50_000,
  category: null,
  ...over,
});

const catalogue = [
  row('typo', 'HP Victsu 15 Gaming Laptop', { createdAt: at(3), currentPrice: 60_000 }),
  row('exact', 'HP Victus 15 Gaming Laptop', { createdAt: at(1), currentPrice: 70_000 }),
  row('dell', 'Dell Inspiron 15', { createdAt: at(2) }),
  row('p2', 'HP Victus 16 Gaming Laptop', { priority: 2, currentPrice: 90_000 }),
];

const list = (query: Record<string, string>) =>
  new ProductsController(fakePrisma(catalogue), {} as JobsService).list(query) as Promise<{
    items: Array<{ id: string }>;
    total: number;
    pageSize: number;
  }>;
const ids = (result: { items: Array<{ id: string }> }) => result.items.map((p) => p.id);

describe('product list search', () => {
  it('finds through a typo and ranks the best match first, priority still leading', async () => {
    const first = await list({ search: 'victus', pageSize: '2' });
    expect(first.total).toBe(3);
    expect(ids(first)).toEqual(['p2', 'exact']);

    const second = await list({ search: 'victus', pageSize: '2', page: '2' });
    expect(ids(second)).toEqual(['typo']);
  });

  it('keeps a chosen sort while searching', async () => {
    const result = await list({ search: 'victus gaming', sort: 'price_asc' });
    expect(ids(result)).toEqual(['p2', 'typo', 'exact']);
  });

  it('lists everything, priority first, when not searching', async () => {
    const result = await list({});
    expect(result.total).toBe(4);
    expect(ids(result)).toEqual(['p2', 'typo', 'dell', 'exact']); // then newest
  });

  it('serves up to 200 a page', async () => {
    expect((await list({ pageSize: '200' })).pageSize).toBe(200);
    await expect(list({ pageSize: '201' })).rejects.toThrow('Validation failed');
  });
});
