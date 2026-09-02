import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from './prisma.service.js';

/**
 * One download containing everything needed to diagnose a broken run.
 *
 * The point is that a person who hits a problem should not have to know which
 * of six tables to query, or that the interesting bytes are on a different
 * machine to the dashboard. They press one button and get a file that answers
 * "what broke, when, how often, and what did the marketplace actually send".
 *
 * Secrets are excluded by construction, not by filtering: nothing here reads
 * the settings table's encrypted columns, the JWT secret, or cookie jars. What
 * it does contain is failure detail, which can include marketplace URLs — worth
 * knowing before pasting one into a public issue.
 */
@Controller('diagnostics')
export class DiagnosticsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async bundle(@Res() res: Response, @Query('hours') hoursRaw?: string): Promise<void> {
    const hours = Math.min(Math.max(Number(hoursRaw) || 6, 1), 72);
    const since = new Date(Date.now() - hours * 3600_000);

    const [status, products, history, audits, logs, failureCounts, alerts] = await Promise.all([
      this.prisma.systemStatus.findUnique({ where: { id: 1 } }),
      this.prisma.product.findMany({
        select: {
          id: true,
          marketplace: true,
          displayName: true,
          status: true,
          consecutiveFailures: true,
          checkIntervalMinutes: true,
          currentPrice: true,
          lastCheckedAt: true,
          lastSuccessAt: true,
          lastChangedAt: true,
          nextCheckAt: true,
          // When tracking began. Without it the bundle cannot answer "did this
          // start failing when it was imported, or later?" — which is the first
          // question asked of any batch of products that all fail together.
          createdAt: true,
        },
      }),
      // Failures only: a successful check is not what anyone is debugging, and
      // including them would bury the signal under thousands of "ok" rows.
      this.prisma.priceHistory.findMany({
        where: { checkedAt: { gte: since }, success: false },
        orderBy: { checkedAt: 'desc' },
        take: 1000,
        select: {
          productId: true,
          checkedAt: true,
          failureReason: true,
          failureDetail: true,
          extractionTier: true,
          durationMs: true,
          identityId: true,
        },
      }),
      this.prisma.scrapeAudit.findMany({
        where: { createdAt: { gte: since }, success: false },
        orderBy: { createdAt: 'desc' },
        take: 500,
        select: {
          productId: true,
          createdAt: true,
          marketplace: true,
          tier: true,
          failureReason: true,
          failureDetail: true,
          classification: true,
          classificationReason: true,
          identityId: true,
          capturePath: true,
          pincodeRequested: true,
          pincodeApplied: true,
          bytesWire: true,
        },
      }),
      // Ordered by id, not by `at`. Many lines are written within the same
      // millisecond — a startup banner is a dozen of them — and ordering by
      // timestamp shuffles those ties arbitrarily. The autoincrement is the
      // only field that preserves the order things were actually said in, and
      // for a log that order IS the information.
      this.prisma.workerLog.findMany({
        where: { at: { gte: since } },
        orderBy: { id: 'desc' },
        take: 5000,
      }),
      this.prisma.$queryRaw<Array<{ reason: string | null; n: bigint }>>`
        SELECT failure_reason::text AS reason, count(*) AS n
        FROM price_history WHERE checked_at >= ${since} AND success = false
        GROUP BY 1 ORDER BY 2 DESC`,
      this.prisma.alert.count({ where: { firedAt: { gte: since } } }),
    ]);

    const total = await this.prisma.priceHistory.count({ where: { checkedAt: { gte: since } } });
    const ok = await this.prisma.priceHistory.count({
      where: { checkedAt: { gte: since }, success: true },
    });

    const bundle = {
      generatedAt: new Date().toISOString(),
      windowHours: hours,
      summary: {
        checks: total,
        ok,
        failed: total - ok,
        successRatePct: total > 0 ? Math.round((ok / total) * 1000) / 10 : null,
        alertsFired: alerts,
        failuresByReason: failureCounts.map((r) => ({ reason: r.reason ?? 'ok', n: Number(r.n) })),
      },
      scraper: status?.scraperHealth ?? null,
      worker: {
        heartbeatAt: status?.workerHeartbeatAt ?? null,
        stale:
          !status?.workerHeartbeatAt || Date.now() - status.workerHeartbeatAt.getTime() > 120_000,
        lastCycle: {
          startedAt: status?.lastCycleStartedAt ?? null,
          endedAt: status?.lastCycleEndedAt ?? null,
          due: status?.lastCycleDue ?? 0,
          succeeded: status?.lastCycleSucceeded ?? 0,
          failed: status?.lastCycleFailed ?? 0,
        },
        successRate7d: status?.successRate7d ?? null,
      },
      products: products.map((p) => ({ ...p, currentPrice: p.currentPrice?.toString() ?? null })),
      failures: history.map((h) => ({ ...h, checkedAt: h.checkedAt.toISOString() })),
      audits: audits.map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
      // Oldest-first reads the way a log should.
      workerLog: logs.reverse().map((l) => ({
        at: l.at.toISOString(),
        level: l.level,
        message: l.message,
      })),
      note:
        'Captured response BODIES are not included — they are megabytes of HTML and live on the ' +
        "worker's disk. Each audit row above carries `capturePath`; retrieve one with: " +
        'pnpm --filter @pricepulse/worker failures   then   gunzip -c <IDENTITY_DIR>/<capturePath>',
    };

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="pricepulse-diagnostics-${stamp}.json"`,
    );
    // BigInt ids do not survive JSON.stringify without help.
    res.send(JSON.stringify(bundle, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  }
}
