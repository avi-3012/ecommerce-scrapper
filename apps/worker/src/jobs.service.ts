import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { JOB_QUEUES } from '@pricepulse/core';
import type { CheckProductJob } from '@pricepulse/core';
import { PrismaService } from './prisma.service.js';
import { CheckRunnerService } from './check-runner.service.js';
import { TelegramService } from './telegram/telegram.service.js';
import { WORKER_CONFIG } from './config.js';
import type { WorkerConfig } from './config.js';

/**
 * On-demand job consumer (FR-2.4, FR-4.3): the API enqueues, the worker
 * executes. pg-boss keeps the queue in Postgres — no extra infrastructure.
 * On-demand checks run through the same single check path as the scheduler.
 */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CheckRunnerService) private readonly runner: CheckRunnerService,
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    const boss = new PgBoss({ connectionString: this.config.DATABASE_URL });
    boss.on('error', (err: Error) => console.error('pg-boss error:', err.message));
    await boss.start();
    for (const queue of Object.values(JOB_QUEUES)) {
      await boss.createQueue(queue).catch(() => undefined); // idempotent across restarts
    }

    await boss.work<CheckProductJob>(JOB_QUEUES.checkProduct, async (jobs) => {
      for (const job of jobs) {
        await this.runner.checkProductById(job.data.productId);
      }
    });

    await boss.work(JOB_QUEUES.checkAll, async () => {
      // Mark everything due now; the scheduler's politeness pacing does the rest (FR-2.4/2.5).
      await this.prisma.product.updateMany({
        where: { status: 'active' },
        data: { nextCheckAt: new Date() },
      });
    });

    await boss.work(JOB_QUEUES.testNotification, async () => {
      await this.telegram.sendTest();
    });

    this.boss = boss;
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
