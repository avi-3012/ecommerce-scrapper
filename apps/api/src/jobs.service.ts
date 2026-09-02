import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { JOB_QUEUES } from '@pricepulse/core';
import type {
  CheckProductJob,
  PreviewProductJob,
  PreviewResult,
  ResolveLinksJob,
  ResolveLinksResult,
} from '@pricepulse/core';
import { API_CONFIG } from './config.js';
import type { ApiConfig } from './config.js';

/** Send-only pg-boss client: the API enqueues, the worker executes (plan §2). */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  async onModuleInit(): Promise<void> {
    this.boss = new PgBoss({ connectionString: this.config.DATABASE_URL });
    this.boss.on('error', (err: Error) => console.error('pg-boss error:', err.message));
    await this.boss.start();
    for (const queue of Object.values(JOB_QUEUES)) {
      await this.boss.createQueue(queue).catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: false });
  }

  async enqueueCheckProduct(productId: string): Promise<void> {
    const payload: CheckProductJob = { productId };
    await this.boss?.send(JOB_QUEUES.checkProduct, { ...payload });
  }

  async enqueueCheckAll(): Promise<void> {
    await this.boss?.send(JOB_QUEUES.checkAll, {});
  }

  async enqueueTestNotification(): Promise<void> {
    await this.boss?.send(JOB_QUEUES.testNotification, {});
  }

  /**
   * Ask the worker to preview a listing, and wait for its answer.
   *
   * The API deliberately does not fetch marketplace pages itself. There is one
   * scraping surface, one identity pool and one IP budget, and they all live in
   * the worker — which is also the only process that runs on a connection the
   * marketplaces will serve.
   *
   * Held open rather than made async: a preview already takes seconds (the
   * identity has to be paced like a person), the dashboard already waits for
   * this response, and a polling contract would be three moving parts where one
   * will do. If the worker is down or saturated this returns null and the caller
   * says so plainly.
   */
  async previewProduct(url: string, timeoutMs = 45_000): Promise<PreviewResult | null> {
    const boss = this.boss;
    if (!boss) return null;
    const payload: PreviewProductJob = { url };
    const jobId = await boss.send(
      JOB_QUEUES.previewProduct,
      { ...payload },
      { expireInSeconds: 90 },
    );
    if (!jobId) return null;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(400);
      const job = await boss.getJobById(JOB_QUEUES.previewProduct, jobId).catch(() => null);
      if (!job) continue;
      if (job.state === 'completed') return (job.output as PreviewResult | null) ?? null;
      if (job.state === 'failed' || job.state === 'cancelled') return null;
    }
    return null;
  }

  /**
   * Ask the worker to follow the share links in an import file.
   *
   * Same reasoning as `previewProduct`: a share link is a request to the
   * marketplace that issued it, and the identity pool lives in the worker. The
   * timeout is generous because the worker resolves these one at a time under
   * the identity's own pacing — an import of full product URLs returns at once,
   * an import of fifty share links genuinely costs fifty paced requests.
   *
   * Returns nulls (never the raw URLs) when the worker cannot answer, so the
   * caller reports the rows as unresolved instead of importing an unfollowed
   * link as though it were a listing.
   */
  async resolveLinks(urls: string[], timeoutMs = 180_000): Promise<Array<string | null>> {
    const unresolved = urls.map(() => null);
    const boss = this.boss;
    if (!boss || urls.length === 0) return unresolved;
    const payload: ResolveLinksJob = { urls };
    const jobId = await boss.send(
      JOB_QUEUES.resolveLinks,
      { ...payload },
      { expireInSeconds: Math.ceil(timeoutMs / 1000) + 30 },
    );
    if (!jobId) return unresolved;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const job = await boss.getJobById(JOB_QUEUES.resolveLinks, jobId).catch(() => null);
      if (!job) continue;
      if (job.state === 'completed') {
        return (job.output as ResolveLinksResult | null)?.resolved ?? unresolved;
      }
      if (job.state === 'failed' || job.state === 'cancelled') return unresolved;
    }
    return unresolved;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
