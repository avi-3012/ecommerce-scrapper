import { describe, expect, it, vi } from 'vitest';
import { SchedulerService } from './scheduler.service.js';
import type { PrismaService } from './prisma.service.js';
import type { CheckRunnerService } from './check-runner.service.js';
import type { IdentityService } from './identity.service.js';

/**
 * "Last monitoring run" must mean the scheduler last COMPLETED a pass, not that
 * it last found work. A cycle with nothing due — an empty catalogue, or
 * everything checked recently — used to return before recording, so the
 * dashboard froze at whatever time the last busy cycle ended and a perfectly
 * healthy worker was indistinguishable from a dead one.
 */
function rig(options: { due: Array<{ id: string }>; gate?: string }) {
  const upsert = vi.fn().mockResolvedValue({});
  const prisma = {
    product: {
      findMany: vi.fn().mockResolvedValue(options.due),
      count: vi.fn().mockResolvedValue(options.due.length),
    },
    priceHistory: { count: vi.fn().mockResolvedValue(0) },
    systemStatus: { upsert },
    $executeRaw: vi.fn().mockReturnValue({ catch: () => Promise.resolve() }),
  } as unknown as PrismaService;

  const runner = { suspects: { due: () => [] } } as unknown as CheckRunnerService;

  const identities = {
    pool: { ensureSize: vi.fn() },
    config: { cycle: { minSec: 55, maxSec: 65 }, limits: { capacity: 0 } },
    governor: {
      canRequest: () =>
        options.gate
          ? { allowed: false, reason: options.gate, retryAfterMs: 1_000 }
          : { allowed: true, reason: null, retryAfterMs: 0 },
      capPerMin: () => 30,
    },
    banner: () => [],
  } as unknown as IdentityService;

  const service = new SchedulerService(prisma, runner, identities);
  return { service, upsert };
}

describe('SchedulerService cycle reporting', () => {
  it('records a cycle even when nothing was due', async () => {
    const { service, upsert } = rig({ due: [] });

    await (service as unknown as { runCycle(): Promise<void> }).runCycle();

    expect(upsert).toHaveBeenCalledTimes(1);
    const update = upsert.mock.calls[0]![0].update as Record<string, unknown>;
    expect(update.lastCycleDue).toBe(0);
    expect(update.lastCycleEndedAt).toBeInstanceOf(Date);
  });

  it('records a cycle skipped by the global backoff', async () => {
    // A worker that is correctly waiting out a backoff is still running. Left
    // unrecorded, it looks stopped precisely when someone is checking on it.
    const { service, upsert } = rig({ due: [{ id: 'a' }], gate: 'backoff' });

    await (service as unknown as { runCycle(): Promise<void> }).runCycle();

    expect(upsert).toHaveBeenCalledTimes(1);
    expect((upsert.mock.calls[0]![0].update as Record<string, unknown>).lastCycleDue).toBe(0);
  });
});
