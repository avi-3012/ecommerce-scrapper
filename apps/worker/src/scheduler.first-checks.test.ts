import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from './scheduler.service.js';
import type { PrismaService } from './prisma.service.js';
import type { CheckRunnerService } from './check-runner.service.js';
import type { IdentityService } from './identity.service.js';
import type { WorkerConfig } from './config.js';

/**
 * Products past a marketplace's limit wait behind priority and were never
 * checked at all, so an import past the line sat under "Awaiting first check"
 * for good. Each is now checked until it has succeeded once — on what a cycle
 * has to spare, never at the cost of the products inside the limit.
 */
function rig(options: { capacity: number | null; due: string[]; neverChecked: string[] }) {
  const findMany = vi.fn(async (args: { where?: unknown; select?: { id?: boolean } }) => {
    const where = JSON.stringify(args.where ?? {});
    if (where.includes('lastSuccessAt')) return options.neverChecked.map((id) => ({ id }));
    if (args.select?.id && !where.includes('nextCheckAt')) {
      return [{ id: 'in-1' }, { id: 'in-2' }]; // the products inside the limit
    }
    return options.due.map((id) => ({ id }));
  });
  const prisma = { product: { findMany } } as unknown as PrismaService;
  const runner = { suspects: { due: () => [] } } as unknown as CheckRunnerService;
  const identities = {
    config: { cycle: { minSec: 55, maxSec: 65 }, limits: { capacity: 0 } },
  } as unknown as IdentityService;
  const worker = {
    WORKER_MARKETPLACES: ['flipkart'],
    WORKER_ROLE: 'secondary',
    WORKER_STATUS_ID: 2,
  } as unknown as WorkerConfig;
  const service = new SchedulerService(prisma, runner, identities, worker);
  const settings = { scrapeCapacity: null, flipkartScrapeCapacity: options.capacity };
  const due = (capPerMin: number) =>
    (
      service as unknown as {
        dueProducts(h: number, s: unknown, c: number): Promise<Array<{ id: string }>>;
      }
    )
      .dueProducts(65_000, settings, capPerMin)
      .then((products) => products.map((p) => p.id));
  return { due, findMany };
}

describe('first checks past the limit', () => {
  const firstCheckQuery = (findMany: ReturnType<typeof rig>['findMany']) =>
    findMany.mock.calls
      .map(([args]) => args as { where: unknown; orderBy: unknown })
      .find((args) => JSON.stringify(args.where).includes('lastSuccessAt'));

  it('adds a few never-checked products past the limit to a cycle with room', async () => {
    const { due, findMany } = rig({
      capacity: 2,
      due: ['in-1'],
      neverChecked: ['wait-1', 'wait-2', 'wait-3', 'wait-4'],
    });

    expect(await due(30)).toEqual(['in-1', 'wait-1', 'wait-2', 'wait-3']);

    // Only past the limit, only never succeeded, highest priority first.
    const query = firstCheckQuery(findMany)!;
    const where = JSON.stringify(query.where);
    expect(where).toContain('"NOT"');
    expect(where).toContain('in-1');
    expect(where).toContain('"lastSuccessAt":null');
    expect(query.orderBy).toEqual([{ priority: 'desc' }, { createdAt: 'asc' }]);
  });

  it('waits while the products inside the limit take the budget', async () => {
    // 2 requests a minute, 80% of a 65 s cycle: room for one check, and it is due.
    const { due, findMany } = rig({ capacity: 2, due: ['in-1'], neverChecked: ['wait-1'] });

    expect(await due(2)).toEqual(['in-1']);
    expect(firstCheckQuery(findMany)).toBeUndefined();
  });

  it('adds nothing when the marketplace has no limit — everything is scheduled already', async () => {
    const { due, findMany } = rig({ capacity: null, due: ['a', 'b'], neverChecked: ['wait-1'] });

    expect(await due(30)).toEqual(['a', 'b']);
    expect(firstCheckQuery(findMany)).toBeUndefined();
  });
});
