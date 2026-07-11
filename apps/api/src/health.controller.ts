import { Controller, Get, Inject } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { Public } from './auth/auth.js';

/** Worker heartbeat older than this is reported stale (NFR-2). */
const HEARTBEAT_STALE_SECONDS = 120;

export interface HealthReport {
  status: 'ok' | 'degraded';
  db: 'up' | 'down';
  workerHeartbeatAt: string | null;
  workerStale: boolean;
  version: string;
}

@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async health(): Promise<HealthReport> {
    let db: 'up' | 'down' = 'up';
    let workerHeartbeatAt: Date | null = null;
    try {
      const status = await this.prisma.systemStatus.findUnique({ where: { id: 1 } });
      workerHeartbeatAt = status?.workerHeartbeatAt ?? null;
    } catch {
      db = 'down';
    }
    const workerStale =
      workerHeartbeatAt === null ||
      Date.now() - workerHeartbeatAt.getTime() > HEARTBEAT_STALE_SECONDS * 1000;
    return {
      status: db === 'up' && !workerStale ? 'ok' : 'degraded',
      db,
      workerHeartbeatAt: workerHeartbeatAt?.toISOString() ?? null,
      workerStale,
      version: process.env.npm_package_version ?? 'dev',
    };
  }
}
