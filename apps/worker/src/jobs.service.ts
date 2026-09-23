import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import {
  JOB_QUEUES,
  MARKETPLACE_QUEUES,
  allQueueNames,
  marketplaceQueue,
  previewUrl,
  resolveShortLink,
} from '@pricepulse/core';
import type {
  CheckProductJob,
  PreviewProductJob,
  PreviewResult,
  ResolveLinksJob,
  ResolveLinksResult,
} from '@pricepulse/core';
import type { Marketplace } from '@pricepulse/shared';
import type { FetchFn, IdentitySession } from '@pricepulse/adapters';
import { IdentityService } from './identity.service.js';
import { PrismaService } from './prisma.service.js';
import { CheckRunnerService } from './check-runner.service.js';
import { TelegramService } from './telegram/telegram.service.js';
import { WORKER_CONFIG, scrapesEverything } from './config.js';
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
    for (const queue of allQueueNames()) {
      await boss.createQueue(queue).catch(() => undefined); // idempotent across restarts
    }

    // Marketplace work arrives on that marketplace's own queues, so it reaches
    // the worker that scrapes it and no other. A worker that scrapes every
    // marketplace also drains the original unsuffixed queues, which keeps a
    // single-worker deployment behaving exactly as it always has.
    for (const queue of consumedQueues(this.config).checkProduct) {
      await boss.work<CheckProductJob>(queue, async (jobs) => {
        for (const job of jobs) {
          await this.runner.checkProductById(job.data.productId);
        }
      });
    }

    // Registration preview. The returned value becomes the job's output, which
    // is how the API gets its answer back without either side scraping.
    for (const queue of consumedQueues(this.config).previewProduct) {
      await boss.work<PreviewProductJob, PreviewResult>(queue, async (jobs) => {
        const job = jobs[0];
        if (!job) throw new Error('preview job with no payload');
        return this.preview(job.data.url);
      });
    }

    // Bulk-import short links. Resolved here, one at a time, as real identities
    // — the API has no pool to spend and no view of the IP budget.
    for (const queue of consumedQueues(this.config).resolveLinks) {
      await boss.work<ResolveLinksJob, ResolveLinksResult>(queue, async (jobs) => {
        const job = jobs[0];
        if (!job) throw new Error('resolve job with no payload');
        return { resolved: await this.resolveLinks(job.data.urls) };
      });
    }

    // Duties that must happen once, whatever the number of workers: they are
    // not about any one marketplace, and doubling them would double the effect.
    if (this.config.WORKER_ROLE === 'primary') {
      await boss.work(JOB_QUEUES.checkAll, async () => {
        // Mark everything due now — every marketplace, since each worker picks
        // up its own. The politeness pacing does the rest (FR-2.4/2.5).
        await this.prisma.product.updateMany({
          where: { status: 'active' },
          data: { nextCheckAt: new Date() },
        });
      });

      await boss.work(JOB_QUEUES.testNotification, async () => {
        await this.telegram.sendTest();
      });
    }

    this.boss = boss;
  }

  /**
   * Resolve share links SEQUENTIALLY. The concurrency here is not a tuning
   * knob: each hop is paced by its identity and takes a slot against the IP
   * cap, and running them in parallel is exactly the burst this path used to
   * send. A file of full product URLs resolves instantly, because none of them
   * needs a hop at all.
   */
  private async resolveLinks(urls: string[]): Promise<Array<string | null>> {
    const deps = this.registrationDeps();
    const out: Array<string | null> = [];
    for (const url of urls) {
      if (!url) {
        out.push(null);
        continue;
      }
      if (this.runner.registry.recognize(url).kind === 'listing') {
        out.push(url); // already a listing — no request needed
        continue;
      }
      out.push(await resolveShortLink(deps, url));
    }
    return out;
  }

  /** One preview, run as a normal identity-paced fetch. */
  private async preview(url: string): Promise<PreviewResult> {
    return previewUrl(this.registrationDeps(), url);
  }

  /** The identity-backed dependencies both registration paths run on. */
  private registrationDeps(): Parameters<typeof previewUrl>[0] {
    return {
      prisma: this.prisma,
      registry: this.runner.registry,
      maxProducts: this.identities.config.limits.maxProducts,
      acquireIdentity: (marketplace: Marketplace) => this.acquireIdentity(marketplace),
      releaseIdentity: (session: IdentitySession) => this.identities.release(session),
    };
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

/**
 * The queues a worker consumes, per job kind: one per marketplace it scrapes,
 * plus the original unsuffixed queue when it scrapes all of them.
 */
export function consumedQueues(
  config: Pick<WorkerConfig, 'WORKER_MARKETPLACES'>,
): Record<keyof typeof MARKETPLACE_QUEUES, string[]> {
  const everything = scrapesEverything(config);
  const queuesFor = (
    base: (typeof MARKETPLACE_QUEUES)[keyof typeof MARKETPLACE_QUEUES],
  ): string[] => [
    ...config.WORKER_MARKETPLACES.map((marketplace) => marketplaceQueue(base, marketplace)),
    ...(everything ? [base] : []),
  ];
  return {
    checkProduct: queuesFor(MARKETPLACE_QUEUES.checkProduct),
    previewProduct: queuesFor(MARKETPLACE_QUEUES.previewProduct),
    resolveLinks: queuesFor(MARKETPLACE_QUEUES.resolveLinks),
  };
}
