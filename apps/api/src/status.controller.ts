import { Controller, Get, Inject } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/** System health snapshot (NFR-2, FR-5.1): what the dashboard banner and bot /status read. */
@Controller('status')
export class StatusController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async get() {
    const [status, total, active, pausedUser, pausedAuto, failing, alerts24h, drops24h] =
      await Promise.all([
        this.prisma.systemStatus.findUnique({ where: { id: 1 } }),
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

    const heartbeatAt = status?.workerHeartbeatAt ?? null;
    const workerStale = heartbeatAt === null || Date.now() - heartbeatAt.getTime() > 120_000;

    return {
      products: { total, active, pausedUser, pausedAuto, failing },
      alertsLast24h: alerts24h,
      dropsLast24h: drops24h,
      lastCycle: status
        ? {
            startedAt: status.lastCycleStartedAt,
            endedAt: status.lastCycleEndedAt,
            due: status.lastCycleDue,
            succeeded: status.lastCycleSucceeded,
            failed: status.lastCycleFailed,
          }
        : null,
      successRate7d: status?.successRate7d ?? null,
      workerHeartbeatAt: heartbeatAt,
      workerStale,
    };
  }
}
