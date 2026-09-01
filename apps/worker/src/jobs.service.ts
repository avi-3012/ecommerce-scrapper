import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { JOB_QUEUES, previewUrl } from '@pricepulse/core';
import type { CheckProductJob, PreviewProductJob, PreviewResult } from '@pricepulse/core';
import type { Marketplace } from '@pricepulse/shared';
import type { FetchFn, IdentitySession } from '@pricepulse/adapters';
import { IdentityService } from './identity.service.js';
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
    @Inject(IdentityService) private readonly identities: IdentityService,
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

    // Registration preview. The returned value becomes the job's output, which
    // is how the API gets its answer back without either side scraping.
    await boss.work<PreviewProductJob, PreviewResult>(JOB_QUEUES.previewProduct, async (jobs) => {
      const job = jobs[0];
      if (!job) throw new Error('preview job with no payload');
      return this.preview(job.data.url);
    });

    this.boss = boss;
  }

  /** One preview, run as a normal identity-paced fetch. */
  private async preview(url: string): Promise<PreviewResult> {
    return previewUrl(
      {
        prisma: this.prisma,
        registry: this.runner.registry,
        maxProducts: this.identities.config.limits.maxProducts,
        acquireIdentity: (marketplace: Marketplace) => this.acquireIdentity(marketplace),
        releaseIdentity: (session: IdentitySession) => this.identities.release(session),
      },
      url,
    );
  }

  private acquireIdentity(
    marketplace: Marketplace,
  ): { session: IdentitySession; browserFetch?: FetchFn } | null {
    const session = this.identities.acquire(marketplace);
    if (!session) return null;
    return { session, browserFetch: this.identities.browserFetchFor(session.identity) };
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: true });
  }
}
