import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from './scheduler.service.js';
import type { PrismaService } from './prisma.service.js';
import type { CheckRunnerService } from './check-runner.service.js';
import type { IdentityService } from './identity.service.js';
import type { WorkerConfig } from './config.js';

/**
 * "Last monitoring run" must mean the scheduler last COMPLETED a pass, not that
 * it last found work. A cycle with nothing due — an empty catalogue, or
 * everything checked recently — used to return before recording, so the
 * dashboard froze at whatever time the last busy cycle ended and a perfectly
 * healthy worker was indistinguishable from a dead one.
 */
/** Only the fields a cycle reads; capacity falls back to the scraping config. */
const settings = { scrapeCapacity: null, checkIntervalMinutes: 5 } as unknown;

function rig(options: {
  due: Array<{ id: string }>;
  gate?: string;
  worker?: Partial<Record<keyof WorkerConfig, unknown>>;
}) {
  const upsert = vi.fn().mockResolvedValue({});
  const findMany = vi.fn().mockResolvedValue(options.due);
  const historyCount = vi.fn().mockResolvedValue(0);
  const prisma = {
    product: {
      findMany,
      count: vi.fn().mockResolvedValue(options.due.length),
    },
    priceHistory: { count: historyCount },
    systemStatus: { upsert },
    $executeRaw: vi.fn().mockReturnValue({ catch: () => Promise.resolve() }),
  } as unknown as PrismaService;

  const runner = { suspects: { due: () => [] } } as unknown as CheckRunnerService;

  const identities = {
    pool: { ensureSize: vi.fn() },
    config: { cycle: { minSec: 55, maxSec: 65 }, limits: { capacity: 0 } },
    // The scheduler asks the SERVICE, not a governor: with several egress
    // addresses the budget is their sum and the gate opens if any one of them
    // can still send.
    gate: () =>
      options.gate ? { allowed: false, reason: options.gate } : { allowed: true, reason: null },
    capPerMinTotal: () => 30,
    defaultGovernor: { killSwitchEngaged: () => false },
    banner: () => [],
  } as unknown as IdentityService;

  const worker = {
    WORKER_MARKETPLACES: ['amazon_in', 'flipkart'],
    WORKER_ROLE: 'primary',
    WORKER_STATUS_ID: 1,
    ...options.worker,
  } as unknown as WorkerConfig;
  const service = new SchedulerService(prisma, runner, identities, worker);
  return { service, upsert, findMany, historyCount };
}

describe('SchedulerService cycle reporting', () => {
  it('records a cycle even when nothing was due', async () => {
    const { service, upsert } = rig({ due: [] });

    await (service as unknown as { runCycle(s: unknown): Promise<void> }).runCycle(settings);

    expect(upsert).toHaveBeenCalledTimes(1);
    const update = upsert.mock.calls[0]![0].update as Record<string, unknown>;
    expect(update.lastCycleDue).toBe(0);
    expect(update.lastCycleEndedAt).toBeInstanceOf(Date);
  });

  it('records a cycle skipped by the global backoff', async () => {
    // A worker that is correctly waiting out a backoff is still running. Left
    // unrecorded, it looks stopped precisely when someone is checking on it.
    const { service, upsert } = rig({ due: [{ id: 'a' }], gate: 'backoff' });

    await (service as unknown as { runCycle(s: unknown): Promise<void> }).runCycle(settings);

    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0]![0].update as Record<string, unknown>).lastCycleDue).toBe(0);
  });
});

describe('SchedulerService marketplace scope', () => {
  const flipkartOnly = {
    WORKER_MARKETPLACES: ['flipkart'],
    WORKER_ROLE: 'secondary',
    WORKER_STATUS_ID: 2,
  };
  const run = (service: SchedulerService): Promise<void> =>
    (service as unknown as { runCycle(s: unknown): Promise<void> }).runCycle(settings);

  it("selects only its own marketplace's products", async () => {
    const { service, findMany } = rig({ due: [], worker: flipkartOnly });
    await run(service);

    // Every product query this cycle was scoped to Flipkart.
    const wheres = findMany.mock.calls.map(([args]) => JSON.stringify(args.where));
    expect(wheres.length).toBeGreaterThan(0);
    for (const where of wheres) {
      expect(where).toContain('flipkart');
      expect(where).not.toContain('amazon_in');
    }
  });

  it('reports into its own status row, with its marketplaces', async () => {
    const { service, upsert } = rig({ due: [], worker: flipkartOnly });
    await run(service);

    const call = upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 2 });
    expect(call.update.marketplaces).toEqual(['flipkart']);
  });

  it('judges its success rate on its own products only', async () => {
    const { service, historyCount } = rig({ due: [], worker: flipkartOnly });
    await run(service);

    for (const [args] of historyCount.mock.calls) {
      expect(args.where.product).toEqual({ marketplace: { in: ['flipkart'] } });
    }
  });

  it('leaves the primary on row 1 with an empty list, meaning "everything" as before', async () => {
    const { service, upsert, historyCount } = rig({ due: [] });
    await run(service);

    const call = upsert.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 1 });
    expect(call.update.marketplaces).toEqual([]);
    // An all-marketplace worker counts every check, exactly as it always did.
    for (const [args] of historyCount.mock.calls) expect(args.where.product).toBeUndefined();
  });
});
