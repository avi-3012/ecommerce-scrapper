import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { WORKER_CONFIG } from './config.js';
import type { WorkerConfig } from './config.js';

/**
 * Writes the worker heartbeat into the single-row system_status table
 * (plan §3.7). The API's health endpoint and, later, the dashboard's red
 * "monitoring stalled" banner read this timestamp (NFR-2). Milestone 1's
 * scheduler loop will live alongside this service.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat();
    }, this.config.WORKER_HEARTBEAT_SECONDS * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async beat(now: Date = new Date()): Promise<void> {
    try {
      await this.prisma.systemStatus.upsert({
        where: { id: 1 },
        update: { workerHeartbeatAt: now },
        create: { id: 1, workerHeartbeatAt: now },
      });
    } catch (err) {
      // A failed heartbeat must be loud in logs but must never kill the worker (NFR-1).
      console.error('Heartbeat write failed:', err instanceof Error ? err.message : err);
    }
  }
}
