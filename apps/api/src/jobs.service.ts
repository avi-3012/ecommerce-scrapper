import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PgBoss } from 'pg-boss';
import { JOB_QUEUES, MARKETPLACE_QUEUES, allQueueNames, marketplaceQueue } from '@pricepulse/core';
import type {
  CheckProductJob,
  PreviewProductJob,
  PreviewResult,
  ResolveLinksJob,
  ResolveLinksResult,
} from '@pricepulse/core';
import { createDefaultRegistry, shortLinkMarketplace } from '@pricepulse/adapters';
import type { Marketplace } from '@pricepulse/shared';
import { API_CONFIG } from './config.js';
import type { ApiConfig } from './config.js';

/** Send-only pg-boss client: the API enqueues, the worker executes (plan §2). */
@Injectable()
export class JobsService implements OnModuleInit, OnModuleDestroy {
  private boss: PgBoss | null = null;
  private readonly registry = createDefaultRegistry();

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  /**
   * The marketplace a URL belongs to, for routing its job: a recognised listing
   * says so directly, a share link by the host that issued it. Anything else —
   * a third-party shortener — goes to Amazon, the marketplace every deployment
   * has had a worker for.
   */
  marketplaceFor(url: string): Marketplace {
    const recognition = this.registry.recognize(url.trim());
    if (recognition.kind !== 'unsupported') return recognition.marketplace;
    return shortLinkMarketplace(url.trim()) ?? 'amazon_in';
  }

  async onModuleInit(): Promise<void> {
    this.boss = new PgBoss({ connectionString: this.config.DATABASE_URL });
    this.boss.on('error', (err: Error) => console.error('pg-boss error:', err.message));
    await this.boss.start();
    // Every queue, per marketplace included, so a job can be sent to a
    // marketplace whose worker has never started; it waits there until one does.
    for (const queue of allQueueNames()) {
      await this.boss.createQueue(queue).catch(() => undefined);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.boss?.stop({ graceful: false });
  }

  /** On-demand check, on the queue of the worker that scrapes this product. */
  async enqueueCheckProduct(productId: string, marketplace: Marketplace): Promise<void> {
    const payload: CheckProductJob = { productId };
    await this.boss?.send(marketplaceQueue(MARKETPLACE_QUEUES.checkProduct, marketplace), {
      ...payload,
    });
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
    const queue = marketplaceQueue(MARKETPLACE_QUEUES.previewProduct, this.marketplaceFor(url));
    const payload: PreviewProductJob = { url };
    const jobId = await boss.send(queue, { ...payload }, { expireInSeconds: 90 });
    if (!jobId) return null;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(400);
      const job = await boss.getJobById(queue, jobId).catch(() => null);
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
    const resolved: Array<string | null> = urls.map(() => null);
    if (!this.boss || urls.length === 0) return resolved;
    // One job per marketplace, each on that marketplace's own queue: a
    // Flipkart share link is a request to Flipkart and has to leave from the
    // worker Flipkart serves. Positions are kept so results land on their rows.
    const groups = new Map<Marketplace, number[]>();
    urls.forEach((url, index) => {
      if (!url) return;
      const marketplace = this.marketplaceFor(url);
      groups.set(marketplace, [...(groups.get(marketplace) ?? []), index]);
    });
    await Promise.all(
      [...groups].map(async ([marketplace, indexes]) => {
        const answers = await this.resolveOn(
          marketplaceQueue(MARKETPLACE_QUEUES.resolveLinks, marketplace),
          indexes.map((i) => urls[i]!),
          timeoutMs,
        );
        indexes.forEach((urlIndex, k) => {
          resolved[urlIndex] = answers[k] ?? null;
        });
      }),
    );
    return resolved;
  }

  /** One resolve job on one queue, waited for. Nulls when nobody answers. */
  private async resolveOn(
    queue: string,
    urls: string[],
    timeoutMs: number,
  ): Promise<Array<string | null>> {
    const unresolved = urls.map(() => null);
    const boss = this.boss;
    if (!boss) return unresolved;
    const payload: ResolveLinksJob = { urls };
    const jobId = await boss.send(
      queue,
      { ...payload },
      { expireInSeconds: Math.ceil(timeoutMs / 1000) + 30 },
    );
    if (!jobId) return unresolved;

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(500);
      const job = await boss.getJobById(queue, jobId).catch(() => null);
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
