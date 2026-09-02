import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getUserWithSettings, minutesOfDayIn, pruneScrapeAudits } from '@pricepulse/core';
import {
  MAX_REFILL_PER_PASS,
  planCycle,
  pruneCaptures,
  searchKeywords,
  stretchWarning,
} from '@pricepulse/adapters';
import type { Product, Settings } from '@pricepulse/db';
import { PrismaService } from './prisma.service.js';
import { CheckRunnerService } from './check-runner.service.js';
import { IdentityService } from './identity.service.js';

/** How long to keep per-check scrape-audit rows before pruning. */
const AUDIT_RETENTION_DAYS = 14;
/** How often the loop wakes to place the next cycle. */
const IDLE_TICK_MS = 5_000;

/**
 * The monitoring loop, rebuilt around the whole-IP cap.
 *
 * Under proxies this loop paced by a fixed 3–8 s gap and ran both marketplaces
 * in parallel — sensible when every request left from a different exit node.
 * On one ISP line that pattern is the problem, so the shape is inverted:
 *
 *   1. Take the products due this cycle and shuffle them.
 *   2. Ask the planner for a window. If products / W would exceed the cap, the
 *      window STRETCHES. The cap is never exceeded; the cycle just gets longer.
 *   3. Place each fetch at a jittered offset inside the window, at most
 *      `maxConcurrent` at once and one per identity.
 *   4. Replace ~10% of product fetches with a homepage or search browse, so the
 *      IP's traffic is not exclusively product detail pages forever.
 *
 * The governor is the hard gate underneath all of this: even a mis-planned
 * cycle cannot push a request through while the cap is full, the backoff is
 * running, or the kill switch is on.
 */
@Injectable()
export class SchedulerService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;
  private lastPartitionUpkeep = 0;
  private cycleEndsAt = 0;
  /** The last stretch warning emitted, so a standing fact is stated once. */
  private lastStretchWarning = '';
  private bannerPrinted = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(CheckRunnerService) private readonly runner: CheckRunnerService,
    @Inject(IdentityService) private readonly identities: IdentityService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), IDLE_TICK_MS);
    void this.tick();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
  }

  /** One cycle; overlapping ticks are skipped, never queued. */
  async tick(): Promise<void> {
    if (this.running || Date.now() < this.cycleEndsAt) return;
    this.running = true;
    try {
      await this.partitionUpkeep();
      const { settings } = await getUserWithSettings(this.prisma);
      if (settings.monitoringPaused) return;

      // The kill switch outranks everything, including a cycle already planned.
      if (this.identities.governor.killSwitchEngaged()) {
        console.log('[identity] PAUSE engaged — no fetching this cycle');
        this.cycleEndsAt = Date.now() + IDLE_TICK_MS;
        return;
      }

      await this.maybeDailySweep(settings, new Date());
      await this.runCycle();
    } catch (err) {
      console.error('Scheduler tick failed:', err instanceof Error ? err.message : err);
    } finally {
      this.running = false;
    }
  }

  private async runCycle(): Promise<void> {
    const cycleStart = new Date();
    // Replace identities lost to retirement. Without this the pool only ever
    // shrinks — blocks retire personas, nothing creates them, and a pool of 48
    // erodes to 31 in a day and keeps going until acquire() starts returning
    // null and checks are simply skipped. Topped up a couple per cycle so the
    // recovery is gradual rather than a visible step change.
    this.identities.pool.ensureSize(Date.now(), MAX_REFILL_PER_PASS);
    const config = this.identities.config;
    const capPerMin = this.identities.governor.capPerMin();
    const due = await this.dueProducts(config.cycle.maxSec * 1_000);

    // Noise rides ALONG with the products rather than being extra traffic: a
    // noise fetch replaces a product fetch, so the plan size is the product
    // count and the cap arithmetic stays honest.
    const plan = planCycle({
      fetchCount: due.length,
      capPerMin,
      config: { cycle: config.cycle },
    });
    this.cycleEndsAt = cycleStart.getTime() + plan.windowMs;

    if (!this.bannerPrinted) {
      const total = await this.prisma.product.count({ where: { status: 'active' } });
      for (const line of this.identities.banner(total, plan.windowMs / 60_000)) console.log(line);
      this.bannerPrinted = true;
    }
    if (plan.stretched) {
      const warning = stretchWarning(due.length, capPerMin, plan.windowMs);
      if (warning !== this.lastStretchWarning) {
        console.warn(`[identity] WARN ${warning}`);
        this.lastStretchWarning = warning;
      }
    } else {
      this.lastStretchWarning = '';
    }

    if (due.length === 0) return;

    let succeeded = 0;
    let failed = 0;
    let suspect = 0;
    const inFlight = new Set<Promise<void>>();

    for (const [index, product] of due.entries()) {
      if (this.stopped) break;
      // A product is never fetched before it is actually due: the planner's
      // jittered slot decides the EARLIEST it may go, and its own next-check
      // time decides the earliest it should. Whichever is later wins, so the
      // spread stays irregular without any product's interval being shortened.
      const planned = plan.offsetsMs[index] ?? 0;
      const dueOffset = Math.max(0, (product.nextCheckAt?.getTime() ?? 0) - cycleStart.getTime());
      const offset = Math.max(planned, dueOffset);
      const waitMs = cycleStart.getTime() + offset - Date.now();
      if (waitMs > 0) await sleep(waitMs);

      // Never more than `maxConcurrent` requests leaving this IP at once.
      while (inFlight.size >= this.identities.config.maxConcurrent) {
        await Promise.race(inFlight);
      }

      const task = this.fetchOne(product)
        .then((result) => {
          if (result === 'ok') succeeded++;
          else if (result === 'suspect') suspect++;
          else if (result === 'failed') failed++;
        })
        .catch((err: unknown) => {
          // recordCheck itself failed (e.g. a DB hiccup) — contained per NFR-1.
          failed++;
          console.error(`Check of ${product.id} could not be recorded:`, err);
        })
        .finally(() => {
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
    await Promise.all(inFlight);

    this.identities.pool.flush();
    await this.updateSystemStatus(cycleStart, due.length, succeeded, failed, suspect);
  }

  /**
   * One product's turn. With probability `noiseRatio` the identity browses a
   * homepage or a search page INSTEAD — the product simply waits for its next
   * turn, and the IP's traffic stops being a pure stream of product pages.
   */
  private async fetchOne(product: Product): Promise<'ok' | 'failed' | 'suspect' | 'skipped'> {
    // Varied, not fixed: a constant 2% of browsing is itself a regularity. The
    // ratio wanders between half and double the configured value so the mix of
    // product pages to everything else is never quite the same hour to hour.
    const noise = this.identities.config.noiseRatio * (0.5 + Math.random() * 1.5);
    if (Math.random() < noise) {
      await this.fetchNoise(product);
      return 'skipped';
    }
    const exclude = this.runner.suspects.excludeFor(product.id);
    const report = await this.runner.checkProduct(
      product,
      exclude ? { excludeIdentityId: exclude } : {},
    );
    if (report.skipped) return 'skipped';
    if (report.outcome.classification === 'suspect') return 'suspect';
    return report.outcome.ok ? 'ok' : 'failed';
  }

  private async fetchNoise(product: Product): Promise<void> {
    // Noise browses the SAME marketplace as the product it stands in for.
    // Picking freely meant the pool kept touching a marketplace whose products
    // were all paused — pausing every Flipkart product did not stop 48
    // identities warming up against Flipkart and collecting a 529 each.
    const session = this.identities.acquire(product.marketplace);
    if (!session) return;
    try {
      const site = product.marketplace === 'amazon_in' ? 'amazon.in' : 'flipkart.com';
      // Search keywords come from the product's own title, so the browse looks
      // like the same shopper's next thought rather than a random word.
      const keywords = Math.random() < 0.5 ? searchKeywords(product.displayName) : null;
      await session.fetchNoise(site, keywords);
    } catch (err) {
      // Noise is decoration. A failed browse must never affect a real check.
      console.warn('[identity] noise fetch failed:', err instanceof Error ? err.message : err);
    } finally {
      this.identities.release(session);
    }
  }

  /**
   * Products due this cycle, shuffled. Suspects whose ten minutes are up jump
   * the queue: a pending suspicion is a product whose recorded price is stale
   * on purpose, and it should not stay that way longer than it must.
   */
  private async dueProducts(horizonMs: number): Promise<Product[]> {
    const dueSuspects = this.runner.suspects.due();
    // Everything falling due WITHIN this cycle, not only what is already
    // overdue at the instant it starts. Selecting on `now` quantises the real
    // interval to the cycle length: a product checked 40 s into a 60 s cycle
    // comes due at 100 s, is missed by the query that runs at 60 s, and waits
    // until 120 s — turning a requested 1-minute interval into an observed
    // 2-minute one. Each product is then dispatched at its own due time inside
    // the window (see `runCycle`), so the horizon widens what is eligible
    // without making anything fire early.
    const horizon = new Date(Date.now() + horizonMs);
    const [suspects, normal] = await Promise.all([
      dueSuspects.length
        ? this.prisma.product.findMany({
            where: { status: 'active', id: { in: dueSuspects.map((s) => s.productId) } },
          })
        : Promise.resolve([]),
      this.prisma.product.findMany({
        where: { status: 'active', nextCheckAt: { lte: horizon } },
        orderBy: { nextCheckAt: 'asc' },
      }),
    ]);
    const suspectIds = new Set(suspects.map((p) => p.id));
    return [...suspects, ...normal.filter((p) => !suspectIds.has(p.id))];
  }

  /**
   * Once per local day, at/after the configured daily-check time, check EVERY
   * active product, ordered by shortest check interval first. Under proxies
   * this ran "fast-paced" at 1.5 s gaps; it cannot any more — a sweep is
   * ordinary traffic on the same capped line, so it is simply queued at the
   * front of the normal cycle rather than run as a burst.
   */
  private async maybeDailySweep(settings: Settings, now: Date): Promise<void> {
    const target = parseHhMm(settings.dailyCheckTime);
    if (target === null) return;
    if (minutesOfDayIn(settings.timezone, now) < target) return; // not yet time today

    const status = await this.prisma.systemStatus.findUnique({
      where: { id: 1 },
      select: { lastDailySweepAt: true },
    });
    const last = status?.lastDailySweepAt ?? null;
    if (last && localDate(settings.timezone, last) === localDate(settings.timezone, now)) return;

    await this.prisma.systemStatus.upsert({
      where: { id: 1 },
      update: { lastDailySweepAt: now },
      create: { id: 1, lastDailySweepAt: now },
    });

    // Mark everything due, shortest interval first. The cycle planner then
    // spreads the sweep across as many windows as the cap requires.
    const products = await this.prisma.product.findMany({
      where: { status: 'active' },
      select: { id: true, checkIntervalMinutes: true },
    });
    const ordered = [...products].sort(
      (a, b) =>
        (a.checkIntervalMinutes ?? settings.checkIntervalMinutes) -
        (b.checkIntervalMinutes ?? settings.checkIntervalMinutes),
    );
    await Promise.all(
      ordered.map((product, index) =>
        this.prisma.product.update({
          where: { id: product.id },
          // A one-second stagger preserves the shortest-interval-first order
          // through the scheduler's `nextCheckAt` sort.
          data: { nextCheckAt: new Date(now.getTime() + index * 1_000) },
        }),
      ),
    );
    console.log(
      `Daily sweep: ${ordered.length} products queued (shortest interval first); ` +
        `the IP cap paces them across the next cycles`,
    );
  }

  private async updateSystemStatus(
    startedAt: Date,
    dueCount: number,
    succeeded: number,
    failed: number,
    suspect: number,
  ): Promise<void> {
    const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const [total7d, success7d] = await Promise.all([
      this.prisma.priceHistory.count({ where: { checkedAt: { gte: since } } }),
      this.prisma.priceHistory.count({ where: { checkedAt: { gte: since }, success: true } }),
    ]);
    const successRate7d = total7d > 0 ? Math.round((success7d / total7d) * 10000) / 100 : null;

    // Cycle counters only. The scraper's vitals are published by the heartbeat,
    // which keeps running when a cycle does not.
    await this.prisma.systemStatus.upsert({
      where: { id: 1 },
      update: {
        lastCycleStartedAt: startedAt,
        lastCycleEndedAt: new Date(),
        lastCycleDue: dueCount,
        lastCycleChecked: succeeded + failed + suspect,
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

  /** Keep future price_history partitions provisioned (ADR-0002); daily. Also
   * prunes the per-check scrape-audit trail past its retention window. */
  private async partitionUpkeep(): Promise<void> {
    if (Date.now() - this.lastPartitionUpkeep < 24 * 3600 * 1000) return;
    try {
      await this.prisma.$executeRawUnsafe('SELECT ensure_price_history_partitions(3)');
      this.lastPartitionUpkeep = Date.now();
    } catch (err) {
      // Loud but non-fatal: inserts into a missing partition will fail loudly anyway (NFR-2).
      console.error('Partition upkeep failed:', err instanceof Error ? err.message : err);
    }
    try {
      const removed = await pruneScrapeAudits(this.prisma, AUDIT_RETENTION_DAYS);
      if (removed > 0) console.log(`Pruned ${removed} scrape-audit rows past retention`);
    } catch (err) {
      console.error('Scrape-audit prune failed:', err instanceof Error ? err.message : err);
    }
    // Captured failure bodies, same schedule. Debug output that grows without
    // bound is a disk-full incident waiting for the week nobody is watching —
    // and a full disk fails every check, which is worse than losing last
    // month's block pages.
    try {
      const { removedDirs, removedBytes } = pruneCaptures(this.identities.store.dir);
      if (removedDirs > 0) {
        console.log(
          `Pruned ${removedDirs} day(s) of failure captures (${(removedBytes / 1e6).toFixed(1)} MB)`,
        );
      }
    } catch (err) {
      console.error('Capture prune failed:', err instanceof Error ? err.message : err);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse "HH:MM" to minutes-of-day, or null if unset/malformed. */
function parseHhMm(value: string | null): number | null {
  if (!value) return null;
  const m = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes >= 0 && minutes < 24 * 60 ? minutes : null;
}

/** Local calendar date (YYYY-MM-DD) in the given IANA timezone. */
function localDate(timezone: string, date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}
