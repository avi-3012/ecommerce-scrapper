import { describe, expect, it, vi } from 'vitest';
import { HeartbeatService } from './heartbeat.service.js';
import type { PrismaService } from './prisma.service.js';
import type { WorkerConfig } from './config.js';

const config: WorkerConfig = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  WORKER_HEARTBEAT_SECONDS: 30,
  SETTINGS_ENC_KEY: 'ab'.repeat(32),
  SCHEDULER_TICK_SECONDS: 20,
};

describe('HeartbeatService', () => {
  it('upserts the single system_status row with the heartbeat time', async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { systemStatus: { upsert } } as unknown as PrismaService;
    const service = new HeartbeatService(prisma, identityStub(), config);
    const now = new Date('2026-07-10T12:00:00Z');

    await service.beat(now);

    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 1 },
        create: { id: 1, workerHeartbeatAt: now },
      }),
    );
    const update = upsert.mock.calls[0]![0].update as Record<string, unknown>;
    expect(update.workerHeartbeatAt).toBe(now);
  });

  it('publishes the scraper vitals on every beat, stamped with the time', async () => {
    // Vitals used to be written only at the end of a scheduler cycle. When a
    // global backoff stalled a cycle for hours, the dashboard kept rendering
    // pre-incident numbers and reported "not paused" while fetching was paused.
    // The heartbeat is the thing that keeps running, so it owns this now.
    const upsert = vi.fn().mockResolvedValue({});
    const prisma = { systemStatus: { upsert } } as unknown as PrismaService;
    const now = new Date('2026-07-10T12:00:00Z');

    await new HeartbeatService(prisma, identityStub(), config).beat(now);

    const health = (upsert.mock.calls[0]![0].update as { scraperHealth: Record<string, unknown> })
      .scraperHealth;
    // The timestamp is what lets the dashboard tell live numbers from stale ones.
    expect(health.at).toBe(now.toISOString());
    expect(health).toHaveProperty('ratePerMin');
    expect(health).toHaveProperty('backoffLevel');
    expect(health).toHaveProperty('pausedUntil');
    expect(health).toHaveProperty('killSwitch');
  });

  it('survives a database failure without throwing (NFR-1)', async () => {
    const upsert = vi.fn().mockRejectedValue(new Error('db down'));
    const prisma = { systemStatus: { upsert } } as unknown as PrismaService;
    const service = new HeartbeatService(prisma, identityStub(), config);

    await expect(service.beat()).resolves.toBeUndefined();
  });
});

/**
 * The heartbeat now publishes the scraper's vitals as well as the timestamp —
 * deliberately, because it is the one thing that keeps running when a cycle
 * stalls. These tests only care about the heartbeat write, so the pool and
 * governor are stubbed to their quietest useful answers.
 */
function identityStub(): never {
  return {
    governor: {
      snapshot: () => ({
        capPerMin: 0,
        learnedPerMin: 0,
        mode: 'fixed',
        diurnalFactor: 1,
        usedLastMinute: 0,
        usedLastHour: 0,
        recentBlockRatio: 0,
        recentCongestionRatio: 0,
        unreadable: 0,
        backoffLevel: 0,
        pausedUntil: null,
        isNight: false,
      }),
      killSwitchEngaged: () => false,
    },
    pool: { list: () => [] },
  } as never;
}
