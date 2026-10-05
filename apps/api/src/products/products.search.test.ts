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
  lastSuccessAt: Date | null;
  categoryId: string | null;
  category: null;
}

type Order = Record<string, 'asc' | 'desc' | { sort: 'asc' | 'desc'; nulls?: 'first' | 'last' }>;

/** Every product has this much history and this many alerts, for deletion's impact. */
const HISTORY_EACH = 12;
const ALERTS_EACH = 2;

/**
 * Just enough of Prisma for the product list: equality and `in` filters,
 * multi-key ordering, skip/take. Selects and includes return whole rows —
 * the controller only reads what it asked for.
 */
function fakePrisma(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown> = {}): boolean =>
    Object.entries(where).every(([key, value]) => {
      if (value && typeof value === 'object' && 'in' in value) {
        return (value as { in: unknown[] }).in.includes(row[key as keyof Row]);
      }
      if (value && typeof value === 'object' && 'not' in value) {
        return row[key as keyof Row] !== (value as { not: unknown }).not;
      }
      return row[key as keyof Row] === value;
    });
  const compare = (orderBy: Order[]) => (a: Row, b: Row) => {
    for (const order of orderBy) {
      const [key, spec] = Object.entries(order)[0]!;
      const dir = typeof spec === 'string' ? spec : spec.sort;
      // Postgres' own default: NULLS LAST ascending, NULLS FIRST descending.
      const nulls =
        typeof spec === 'string' || !spec.nulls ? (dir === 'asc' ? 'last' : 'first') : spec.nulls;
      const x = a[key as keyof Row] as number | Date | string | null;
      const y = b[key as keyof Row] as number | Date | string | null;
      if (x === y) continue;
      if (x === null || y === null) return (x === null ? 1 : -1) * (nulls === 'last' ? 1 : -1);
      return (x < y ? -1 : 1) * (dir === 'asc' ? 1 : -1);
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
      updateMany: async (args: { where?: Record<string, unknown>; data: Partial<Row> }) => {
        const hit = rows.filter((row) => matches(row, args.where));
        for (const row of hit) Object.assign(row, args.data);
        return { count: hit.length };
      },
      deleteMany: async (args: { where?: Record<string, unknown> }) => {
        const hit = rows.filter((row) => matches(row, args.where));
        for (const row of hit) rows.splice(rows.indexOf(row), 1);
        return { count: hit.length };
      },
    },
    priceHistory: {
      count: async (args: { where: { productId: { in: string[] } } }) =>
        rows.filter((row) => args.where.productId.in.includes(row.id)).length * HISTORY_EACH,
    },
    alert: {
      count: async (args: { where: { productId: { in: string[] } } }) =>
        rows.filter((row) => args.where.productId.in.includes(row.id)).length * ALERTS_EACH,
    },
    user: {
      findFirst: async () => ({
        id: 'u1',
        settings: { scrapeCapacity: null, flipkartScrapeCapacity: null },
      }),
    },
    systemStatus: { findMany: async () => [] },
    category: {
      findUnique: async (args: { where: { id: string } }) =>
        args.where.id === GAMING ? { id: GAMING } : null,
    },
  } as unknown as PrismaService;
}

const at = (day: number) => new Date(Date.UTC(2026, 9, day));
const GAMING = '11111111-1111-4111-8111-111111111111';
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
  lastSuccessAt: at(4),
  categoryId: null,
  category: null,
  ...over,
});

const catalogue = [
  row('typo', 'HP Victsu 15 Gaming Laptop', { createdAt: at(3), currentPrice: 60_000 }),
  row('exact', 'HP Victus 15 Gaming Laptop', { createdAt: at(1), currentPrice: 70_000 }),
  row('dell', 'Dell Inspiron 15', { createdAt: at(2) }),
  row('p2', 'HP Victus 16 Gaming Laptop', { priority: 2, currentPrice: 90_000 }),
  // Imported, never yet read: placeholder name, no price, no successful check.
  row('waiting', 'Awaiting first check — COMHG6XZUYVABCDE', {
    createdAt: at(5),
    currentPrice: null,
    lastSuccessAt: null,
  }),
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
    expect(result.total).toBe(5);
    expect(ids(result)).toEqual(['p2', 'waiting', 'typo', 'dell', 'exact']); // then newest
  });

  it('leaves out products awaiting their first check, or shows only them', async () => {
    const done = await list({ checked: 'done' });
    expect(ids(done)).not.toContain('waiting');
    expect(done.total).toBe(4);

    expect(ids(await list({ checked: 'pending' }))).toEqual(['waiting']);
  });

  it('serves up to 200 a page', async () => {
    expect((await list({ pageSize: '200' })).pageSize).toBe(200);
    await expect(list({ pageSize: '201' })).rejects.toThrow('Validation failed');
  });
});

describe('select all matching', () => {
  const matching = (query: Record<string, string>) =>
    new ProductsController(fakePrisma(catalogue), {} as JobsService).ids(query);

  it('returns every product the search matches, not just one page of them', async () => {
    const result = await matching({ search: 'victus', pageSize: '1' });
    expect(result.total).toBe(3);
    expect([...result.ids].sort()).toEqual(['exact', 'p2', 'typo']);
  });

  it('applies the same filters as the list', async () => {
    expect(await matching({ checked: 'pending' })).toEqual({ ids: ['waiting'], total: 1 });
  });
});

describe('bulk edit', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const fresh = () => [
    row(id(1), 'Acer Aspire Lite', { createdAt: at(1) }),
    row(id(2), 'Dell Inspiron 15', { createdAt: at(2) }),
    row(id(3), 'HP Victus 15', { createdAt: at(3) }),
  ];

  it('sets one priority on every selected product, which then leads the list', async () => {
    const controller = new ProductsController(fakePrisma(fresh()), {} as JobsService);

    expect(await controller.bulkEdit({ ids: [id(1), id(2)], priority: 5 })).toEqual({
      updated: 2,
    });
    // The two at P5 first (newest first between them), then the one left at P1.
    expect(ids(await controller.list({}))).toEqual([id(2), id(1), id(3)]);
  });

  it('sets a category on every selected product, or takes it away', async () => {
    const rows = fresh();
    const controller = new ProductsController(fakePrisma(rows), {} as JobsService);

    expect(await controller.bulkEdit({ ids: [id(1), id(3)], categoryId: GAMING })).toEqual({
      updated: 2,
    });
    expect(rows.map((r) => r.categoryId)).toEqual([GAMING, null, GAMING]);

    await controller.bulkEdit({ ids: [id(1)], categoryId: null });
    expect(rows.map((r) => r.categoryId)).toEqual([null, null, GAMING]);
  });

  it('refuses a category that does not exist, or a change that names nothing', async () => {
    const controller = new ProductsController(fakePrisma(fresh()), {} as JobsService);
    await expect(
      controller.bulkEdit({ ids: [id(1)], categoryId: '22222222-2222-4222-8222-222222222222' }),
    ).rejects.toThrow('Unknown category');
    await expect(controller.bulkEdit({ ids: [id(1)] })).rejects.toThrow('Validation failed');
  });

  it('refuses an empty selection, a priority below 1, and over 1,000 at once', async () => {
    const controller = new ProductsController(fakePrisma(fresh()), {} as JobsService);
    await expect(controller.bulkEdit({ ids: [], priority: 2 })).rejects.toThrow(
      'Validation failed',
    );
    await expect(controller.bulkEdit({ ids: [id(1)], priority: 0 })).rejects.toThrow(
      'Validation failed',
    );
    const tooMany = Array.from({ length: 1_001 }, (_, n) => id(n + 1));
    await expect(controller.bulkEdit({ ids: tooMany, priority: 2 })).rejects.toThrow(
      'Validation failed',
    );
  });
});

describe('bulk pause, resume and delete', () => {
  const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const mixed = () => [
    row(id(1), 'Acer Aspire Lite'),
    row(id(2), 'Dell Inspiron 15', { status: 'paused_user' }),
    row(id(3), 'HP Victus 15', { status: 'paused_auto' }),
    row(id(4), 'Lenovo LOQ 15'),
  ];
  const statuses = (rows: Row[]) => rows.map((r) => r.status);

  it('pauses the selected products that are being checked, and leaves paused ones be', async () => {
    const rows = mixed();
    const controller = new ProductsController(fakePrisma(rows), {} as JobsService);

    expect(await controller.bulkPause({ ids: [id(1), id(2), id(3)] })).toEqual({ paused: 1 });
    // An auto-paused product keeps saying why it stopped; the unselected one runs on.
    expect(statuses(rows)).toEqual(['paused_user', 'paused_user', 'paused_auto', 'active']);
  });

  it('resumes the selected paused products with a clean slate, and leaves active ones be', async () => {
    const rows = mixed();
    Object.assign(rows[2]!, { consecutiveFailures: 5 }); // auto-paused after five failures
    const controller = new ProductsController(fakePrisma(rows), {} as JobsService);

    expect(await controller.bulkResume({ ids: [id(1), id(2), id(3)] })).toEqual({ resumed: 2 });
    expect(statuses(rows)).toEqual(['active', 'active', 'active', 'active']);
    // Due now, failures forgotten, as when resuming one.
    expect(rows[2]).toMatchObject({ consecutiveFailures: 0 });
    expect((rows[2] as unknown as { nextCheckAt: Date }).nextCheckAt).toBeInstanceOf(Date);
    // The active one selected alongside was not touched: no check pulled forward.
    expect(rows[0]).not.toHaveProperty('nextCheckAt');
  });

  it('deletes only once confirmed, and says first what would go with them', async () => {
    const rows = mixed();
    const controller = new ProductsController(fakePrisma(rows), {} as JobsService);

    await expect(controller.bulkDelete({ ids: [id(1), id(3)] })).rejects.toMatchObject({
      response: { impact: { historyCount: 2 * HISTORY_EACH, alertCount: 2 * ALERTS_EACH } },
    });
    expect(rows).toHaveLength(4);

    expect(await controller.bulkDelete({ ids: [id(1), id(3)] }, 'true')).toEqual({
      deleted: 2,
      historyCount: 2 * HISTORY_EACH,
      alertCount: 2 * ALERTS_EACH,
    });
    expect(rows.map((r) => r.id)).toEqual([id(2), id(4)]);
  });

  it('refuses an empty selection and over 1,000 at once', async () => {
    const controller = new ProductsController(fakePrisma(mixed()), {} as JobsService);
    const tooMany = Array.from({ length: 1_001 }, (_, n) => id(n + 1));
    for (const act of [
      (ids: string[]) => controller.bulkPause({ ids }),
      (ids: string[]) => controller.bulkResume({ ids }),
      (ids: string[]) => controller.bulkDelete({ ids }, 'true'),
    ]) {
      await expect(act([])).rejects.toThrow('Validation failed');
      await expect(act(tooMany)).rejects.toThrow('Validation failed');
    }
  });
});

describe('sorting', () => {
  it('puts products with no price last, highest price first', async () => {
    const result = await list({ sort: 'price_desc' });
    // Priority first (p2), then by price; the one awaiting its first check last.
    expect(ids(result)).toEqual(['p2', 'exact', 'typo', 'dell', 'waiting']);
  });

  it('puts them last going the other way too', async () => {
    expect(ids(await list({ sort: 'price_asc' })).at(-1)).toBe('waiting');
  });
});
