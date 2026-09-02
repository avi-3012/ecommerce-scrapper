import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { IdentityService } from './identity.service.js';
import { WORKER_CONFIG } from './config.js';
import type { WorkerConfig } from './config.js';

/**
 * Writes the worker heartbeat into the single-row system_status table
 * (plan §3.7). The API's health endpoint and, later, the dashboard's red
 * "monitoring stalled" banner read this timestamp (NFR-2). Milestone 1's
 * scheduler loop will live alongside this service.
 */
@Injectable()
export class HeartbeatService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdentityService) private readonly identities: IdentityService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.beat();
    this.timer = setInterval(() => {
      void this.beat();
    }, this.config.WORKER_HEARTBEAT_SECONDS * 1000);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async beat(now: Date = new Date()): Promise<void> {
    try {
      // Vitals are published HERE, on the heartbeat, not at the end of a cycle.
      // A cycle is exactly the thing that stalls — when the global backoff trips
      // mid-cycle, in-flight fetches wait it out and the cycle cannot finish, so
      // cycle-end publishing meant the dashboard showed numbers from before the
      // incident and reported "not paused" while fetching was paused for hours.
      const snapshot = this.identities.governor.snapshot(now.getTime());
      const pool = this.identities.pool.list();
      await this.prisma.systemStatus.upsert({
        where: { id: 1 },
        update: {
          workerHeartbeatAt: now,
          scraperHealth: {
            at: now.toISOString(),
            identities: pool.length,
            cooling: pool.filter((i) => i.state === 'cooling').length,
            ratePerMin: Math.round(snapshot.capPerMin * 10) / 10,
            learnedPerMin: Math.round(snapshot.learnedPerMin * 10) / 10,
            mode: snapshot.mode,
            diurnalFactor: Math.round(snapshot.diurnalFactor * 100) / 100,
            usedLastMinute: snapshot.usedLastMinute,
            usedLastHour: snapshot.usedLastHour,
            blockRatio: Math.round(snapshot.recentBlockRatio * 1000) / 10,
            congestionRatio: Math.round(snapshot.recentCongestionRatio * 1000) / 10,
            unreadable: snapshot.unreadable ?? 0,
            backoffLevel: snapshot.backoffLevel,
            pausedUntil: snapshot.pausedUntil,
            isNight: snapshot.isNight,
            killSwitch: this.identities.governor.killSwitchEngaged(),
          },
        },
        create: { id: 1, workerHeartbeatAt: now },
      });
    } catch (err) {
      // A failed heartbeat must be loud in logs but must never kill the worker (NFR-1).
      console.error('Heartbeat write failed:', err instanceof Error ? err.message : err);
    }
  }
}
