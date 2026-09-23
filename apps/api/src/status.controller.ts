import { Controller, Get, Inject } from '@nestjs/common';
import type { SystemStatus } from '@pricepulse/db';
import { PrismaService } from './prisma.service.js';
import {
  capacityFor,
  capacityUsage,
  getUserWithSettings,
  isWorkerLive,
  marketplaceHasLiveWorker,
} from '@pricepulse/core';
import { MARKETPLACES } from '@pricepulse/shared';
import { loadScrapingConfigSafely } from './scraping-config.js';

/** System health snapshot (NFR-2, FR-5.1): what the dashboard banner and bot /status read. */
@Controller('status')
export class StatusController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async get() {
    const [rows, total, active, pausedUser, pausedAuto, failing, alerts24h, drops24h] =
      await Promise.all([
        this.prisma.systemStatus.findMany({ orderBy: { id: 'asc' } }),
        this.prisma.product.count(),
        this.prisma.product.count({ where: { status: 'active' } }),
        this.prisma.product.count({ where: { status: 'paused_user' } }),
        this.prisma.product.count({ where: { status: 'paused_auto' } }),
        this.prisma.product.count({ where: { consecutiveFailures: { gt: 0 }, status: 'active' } }),
        this.prisma.alert.count({
          where: { firedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) } },
        }),
        this.prisma.alert.count({
          where: {
            firedAt: { gte: new Date(Date.now() - 24 * 3600 * 1000) },
            type: { in: ['threshold_drop', 'target_price'] },
          },
        }),
      ]);

    // Row 1 is the primary worker. Every top-level field below keeps the
    // meaning it had when there was only one worker; the others appear under
    // `workers`.
    const status = rows.find((r) => r.id === 1) ?? null;
    const { settings } = await getUserWithSettings(this.prisma);
    const configCapacity = loadScrapingConfigSafely().limits.capacity;

    // Per marketplace, because each has its own limit and its own worker. A
    // marketplace with active products and no live worker is the state that
    // otherwise looks exactly like a scraper that silently stopped.
    const byMarketplace = await Promise.all(
      MARKETPLACES.map(async (marketplace) => {
        const usage = await capacityUsage(
          this.prisma,
          capacityFor(marketplace, settings, configCapacity),
          marketplace,
        );
        return {
          marketplace,
          active: usage.active,
          capacity: usage.capacity || null,
          scraped: usage.scraped,
          waiting: usage.waiting,
          hasLiveWorker: marketplaceHasLiveWorker(rows, marketplace),
        };
      }),
    );
    const everyCapped = byMarketplace.every((m) => m.capacity !== null || m.active === 0);

    const heartbeatAt = status?.workerHeartbeatAt ?? null;
    const workerStale = heartbeatAt === null || !isWorkerLive({ workerHeartbeatAt: heartbeatAt });

    return {
      products: {
        total,
        active,
        pausedUser,
        pausedAuto,
        failing,
        // The hard cap, so the dashboard can show how much room is left rather
        // than letting someone discover it by being refused.
        max: loadScrapingConfigSafely().limits.maxProducts || null,
        // Scraping capacity: how many of the active products are actually being
        // checked, and how many are queued behind them waiting on priority.
        // Without this the queued ones look active and simply never update,
        // which is indistinguishable from the scraper being broken.
        capacity: everyCapped
          ? byMarketplace.reduce((sum, m) => sum + (m.capacity ?? 0), 0) || null
          : null,
        scraped: byMarketplace.reduce((sum, m) => sum + m.scraped, 0),
        waiting: byMarketplace.reduce((sum, m) => sum + m.waiting, 0),
        byMarketplace,
      },
      alertsLast24h: alerts24h,
      dropsLast24h: drops24h,
      lastCycle: status ? lastCycleOf(status) : null,
      successRate7d: status?.successRate7d ?? null,
      // The scraper's own vitals, written by the worker each cycle: how fast it
      // is allowed to go right now, how much of that it used, and whether the
      // marketplaces are pushing back. Without this the only way to know the
      // connection is in trouble is to notice prices going stale.
      scraper: (status?.scraperHealth as Record<string, unknown> | undefined) ?? null,
      workerHeartbeatAt: heartbeatAt,
      workerStale,
      // Every worker, primary first. Each has its own connection, budget and
      // backoff, so each has its own health.
      workers: rows.map((row) => ({
        id: row.id,
        primary: row.id === 1,
        marketplaces: row.marketplaces.length ? row.marketplaces : [...MARKETPLACES],
        heartbeatAt: row.workerHeartbeatAt,
        stale: !isWorkerLive(row),
        lastCycle: lastCycleOf(row),
        successRate7d: row.successRate7d,
        scraper: (row.scraperHealth as Record<string, unknown> | undefined) ?? null,
      })),
    };
  }
}

function lastCycleOf(row: SystemStatus) {
  return {
    startedAt: row.lastCycleStartedAt,
    endedAt: row.lastCycleEndedAt,
    due: row.lastCycleDue,
    succeeded: row.lastCycleSucceeded,
    failed: row.lastCycleFailed,
  };
}
