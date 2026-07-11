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
    const service = new HeartbeatService(prisma, config);
    const now = new Date('2026-07-10T12:00:00Z');

    await service.beat(now);

    expect(upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      update: { workerHeartbeatAt: now },
      create: { id: 1, workerHeartbeatAt: now },
    });
  });

  it('survives a database failure without throwing (NFR-1)', async () => {
    const upsert = vi.fn().mockRejectedValue(new Error('db down'));
    const prisma = { systemStatus: { upsert } } as unknown as PrismaService;
    const service = new HeartbeatService(prisma, config);

    await expect(service.beat()).resolves.toBeUndefined();
  });
});
