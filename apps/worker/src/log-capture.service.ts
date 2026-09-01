import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';

/**
 * Tees the worker's console output into the database so the dashboard can offer
 * it as a download.
 *
 * The worker and the API do not share a filesystem, so a database table is the
 * only route by which "what did the worker say when it broke" reaches a button
 * in the browser.
 *
 * Deliberately bounded on every axis: lines are truncated, the buffer is capped,
 * writes are batched, and old rows are pruned by both age and count. Diagnostics
 * that grow without limit become an outage of their own, and a logger that fails
 * must never take the worker down with it.
 */
const MAX_LINE = 2_000;
const MAX_BUFFERED = 500;
const FLUSH_MS = 10_000;
const RETENTION_HOURS = 48;
const MAX_ROWS = 20_000;

type Level = 'log' | 'warn' | 'error';

@Injectable()
export class LogCaptureService implements OnModuleInit, OnModuleDestroy {
  private buffer: Array<{ at: Date; level: Level; message: string }> = [];
  private timer: NodeJS.Timeout | null = null;
  private readonly original: Partial<Record<Level, (...args: unknown[]) => void>> = {};
  private lastPrune = 0;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    for (const level of ['log', 'warn', 'error'] as const) {
      const original = console[level].bind(console);
      this.original[level] = original;
      console[level] = (...args: unknown[]): void => {
        // The real console still receives everything unchanged — `docker logs`
        // must keep working exactly as it did.
        original(...args);
        this.push(level, args);
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    for (const level of ['log', 'warn', 'error'] as const) {
      const original = this.original[level];
      if (original) console[level] = original;
    }
    if (this.timer) clearTimeout(this.timer);
    await this.flush();
  }

  private push(level: Level, args: unknown[]): void {
    const message = args
      .map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message}`;
        try {
          return JSON.stringify(a);
        } catch {
          return String(a);
        }
      })
      .join(' ')
      .slice(0, MAX_LINE);

    this.buffer.push({ at: new Date(), level, message });
    // Drop the OLDEST when saturated: during an incident the newest lines are
    // the ones worth having.
    if (this.buffer.length > MAX_BUFFERED) this.buffer.splice(0, this.buffer.length - MAX_BUFFERED);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, FLUSH_MS);
    this.timer.unref?.();
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.prisma.workerLog.createMany({ data: batch });
      await this.prune();
    } catch {
      // Never console.* here: this runs FROM the console patch, and logging a
      // logging failure is how you build an infinite loop.
    }
  }

  private async prune(): Promise<void> {
    if (Date.now() - this.lastPrune < 5 * 60_000) return;
    this.lastPrune = Date.now();
    const cutoff = new Date(Date.now() - RETENTION_HOURS * 3600_000);
    await this.prisma.workerLog
      .deleteMany({ where: { at: { lt: cutoff } } })
      .catch(() => undefined);
    // A row cap as well as an age cap: a crash loop produces a day of lines in a
    // minute, which the age cap alone would not catch.
    const total = await this.prisma.workerLog.count().catch(() => 0);
    if (total > MAX_ROWS) {
      const oldest = await this.prisma.workerLog
        .findMany({ orderBy: { at: 'asc' }, take: total - MAX_ROWS, select: { id: true } })
        .catch(() => [] as Array<{ id: bigint }>);
      if (oldest.length > 0) {
        await this.prisma.workerLog
          .deleteMany({ where: { id: { in: oldest.map((r) => r.id) } } })
          .catch(() => undefined);
      }
    }
  }
}
