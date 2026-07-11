import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getUserWithSettings } from '@pricepulse/core';
import type { Marketplace } from '@pricepulse/shared';
import type { Product } from '@pricepulse/db';
import { PrismaService } from './prisma.service.js';
import { CheckRunnerService } from './check-runner.service.js';
import { WORKER_CONFIG } from './config.js';
import type { WorkerConfig } from './config.js';

/** Politeness (FR-2.5): sequential per marketplace with a randomized gap. */
const MIN_GAP_MS = 3_000;
const MAX_GAP_MS = 8_000;
/** Cap per tick so one tick never monopolises the loop. */
const BATCH_PER_MARKETPLACE = 15;

/**
 * The monitoring loop (WP-1.5). Every tick: read settings live (FR-2.1/6.2),
 * select due products, and process them per-marketplace — sequentially
 * within a marketplace with randomized gaps, marketplaces in parallel.
 * Failures are contained per product (NFR-1). Cycle bookkeeping feeds
 * system_status (NFR-2, FR-5.1).
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastPartitionUpkeep = 0;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CheckRunnerService) private readonly runner: CheckRunnerService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.config.SCHEDULER_TICK_SECONDS * 1000);
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** One pass; overlapping ticks are skipped, never queued. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.partitionUpkeep();
      const { settings } = await getUserWithSettings(this.prisma);
      if (settings.monitoringPaused) return;

      const due = await this.prisma.product.findMany({
        where: { status: 'active', nextCheckAt: { lte: new Date() } },
        orderBy: { nextCheckAt: 'asc' },
      });
      if (due.length === 0) return;

      const cycleStart = new Date();
      const byMarketplace = new Map<Marketplace, Product[]>();
      for (const product of due) {
        const list = byMarketplace.get(product.marketplace) ?? [];
        list.push(product);
        byMarketplace.set(product.marketplace, list);
      }

      let succeeded = 0;
      let failed = 0;
      await Promise.all(
        [...byMarketplace.values()].map(async (products) => {
          // Shuffle so the same products are not always checked first
          const batch = shuffle(products).slice(0, BATCH_PER_MARKETPLACE);
          for (const product of batch) {
            try {
              const result = await this.runner.checkProduct(product);
              if (result.success) succeeded++;
              else failed++;
            } catch (err) {
              // recordCheck itself failed (e.g. DB hiccup) — contained per NFR-1
              failed++;
              console.error(`Check of ${product.id} could not be recorded:`, err);
            }
            await sleep(MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS));
          }
        }),
      );

      await this.updateSystemStatus(cycleStart, due.length, succeeded, failed);
    } catch (err) {
      console.error('Scheduler tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }

  private async updateSystemStatus(
    startedAt: Date,
    dueCount: number,
    succeeded: number,
    failed: number,
  ): Promise<void> {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [total7d, success7d] = await Promise.all([
      this.prisma.priceHistory.count({ where: { checkedAt: { gte: since } } }),
      this.prisma.priceHistory.count({ where: { checkedAt: { gte: since }, success: true } }),
    ]);
    const successRate7d = total7d > 0 ? Math.round((success7d / total7d) * 10000) / 100 : null;

    await this.prisma.systemStatus.upsert({
      where: { id: 1 },
      update: {
        lastCycleStartedAt: startedAt,
        lastCycleEndedAt: new Date(),
        lastCycleDue: dueCount,
        lastCycleChecked: succeeded + failed,
        lastCycleSucceeded: succeeded,
        lastCycleFailed: failed,
        successRate7d,
      },
      create: { id: 1 },
    });
    const payload = JSON.stringify({ type: 'status' });
    await this.prisma.$executeRaw`SELECT pg_notify('pricepulse_events', ${payload})`.catch(
      () => undefined,
    );
  }

  /** Keep future price_history partitions provisioned (ADR-0002); daily. */
  private async partitionUpkeep(): Promise<void> {
    if (Date.now() - this.lastPartitionUpkeep < 24 * 3600 * 1000) return;
    try {
      await this.prisma.$executeRawUnsafe('SELECT ensure_price_history_partitions(3)');
      this.lastPartitionUpkeep = Date.now();
    } catch (err) {
      // Loud but non-fatal: inserts into a missing partition will fail loudly anyway (NFR-2).
      console.error('Partition upkeep failed:', err instanceof Error ? err.message : err);
    }
  }
}

function shuffle<T>(items: T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
