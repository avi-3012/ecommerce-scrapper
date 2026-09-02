import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  DEFAULT_SCRAPING_CONFIG,
  MAX_REFILL_PER_PASS,
  IdentityPool,
  IdentitySession,
  IdentityStore,
  IpGovernor,
  configWarnings,
  createBrowserTier,
  defaultStoreDir,
  describeState,
  loadScrapingConfig,
  maxProductsFor,
} from '@pricepulse/adapters';
import type { BrowserTier, Identity, ScrapingConfig } from '@pricepulse/adapters';
import type { Marketplace } from '@pricepulse/shared';
import { PrismaService } from './prisma.service.js';

/**
 * Owns the identity pool for the worker process: the pool itself, the IP
 * governor, and the browser tier bound to per-identity profiles.
 *
 * This is the seam that replaced `SCRAPER_PROXY_URL`. Where the worker used to
 * read one env var and hand a proxy URL to every request, it now hands out
 * sessions — and a session is the only way anything in this process can reach a
 * marketplace.
 */
@Injectable()
export class IdentityService implements OnModuleInit, OnModuleDestroy {
  readonly config: ScrapingConfig = safeLoadConfig();
  readonly store = new IdentityStore(defaultStoreDir());
  readonly pool = new IdentityPool(this.config, this.store);
  readonly governor = new IpGovernor(this.config, this.store, (alert) => {
    void this.raiseHealthAlert(alert.message);
  });
  private browserTier: BrowserTier | undefined;
  private shuttingDown = { aborted: false };

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Establishing a pool and recovering one are different situations.
    //
    // From nothing — a first deploy — create the whole pool at once: there is
    // no traffic to blend into yet and a pool of two is useless.
    //
    // From a pool that has ERODED, top up gradually like any other cycle. Every
    // new identity must warm up before its first product fetch, so replacing
    // seventeen at once means seventeen extra requests moments after startup —
    // the exact burst shape that earns a block, arriving right when the
    // connection is least likely to be in credit.
    const existing = this.pool.list().length;
    this.pool.ensureSize(
      Date.now(),
      existing === 0 ? Number.POSITIVE_INFINITY : MAX_REFILL_PER_PASS,
    );
    const after = this.pool.list().length;
    if (existing > 0 && after < this.config.identities.count) {
      console.log(
        `[identity] pool recovering: ${after}/${this.config.identities.count}, ` +
          `topping up ${MAX_REFILL_PER_PASS} per cycle`,
      );
    }
    // The governor counts browser page loads too — they are the heaviest
    // request we make and were previously free as far as the budget knew.
    this.browserTier = await createBrowserTier(undefined, this.governor);
    // Reported HERE, by the service that owns the value. It used to be logged
    // from CheckRunnerService, whose onModuleInit can run before this one has
    // finished — so it announced "not installed" on an image that ships
    // Chromium, which is exactly the kind of wrong that costs someone an hour.
    console.log(
      this.browserTier
        ? 'Browser tier available — one persistent browser profile per identity'
        : 'Browser tier not installed — tier-1 HTTP only (see HUMAN-TASKS H-13)',
    );
    for (const warning of configWarnings(this.config)) console.warn(`[identity] WARN ${warning}`);
  }

  async onModuleDestroy(): Promise<void> {
    this.shuttingDown.aborted = true;
    this.pool.flush();
    await this.browserTier?.closeAll();
  }

  /** Take an identity for one fetch. Null when every identity is busy or resting. */
  acquire(marketplace: Marketplace, productId?: string): IdentitySession | null {
    const site = marketplace === 'amazon_in' ? 'amazon.in' : 'flipkart.com';
    const identity = this.pool.acquire({ site, productId });
    if (!identity) return null;
    return new IdentitySession(identity, this.pool, this.governor, marketplace, this.shuttingDown);
  }

  /** Take a SPECIFIC identity, or none — used to re-ask a suspect via someone else. */
  acquireExcept(
    marketplace: Marketplace,
    excludeIdentityId: string,
    productId?: string,
  ): IdentitySession | null {
    const session = this.acquire(marketplace, productId);
    if (!session) return null;
    if (session.id !== excludeIdentityId) return session;
    // The pool handed back the identity we must not use. Put it down, take the
    // next one, then release the first — a corroborating read from the same
    // identity that produced the suspicion would corroborate nothing.
    const second = this.acquire(marketplace, productId);
    this.release(session);
    return second;
  }

  release(session: IdentitySession): void {
    this.pool.release(session.identity);
  }

  /** The tier-2 fetch bound to this identity's own persistent Chrome profile. */
  browserFetchFor(identity: Identity): ReturnType<BrowserTier['fetchFor']> | undefined {
    return this.browserTier?.fetchFor(identity);
  }

  get browserAvailable(): boolean {
    return this.browserTier !== undefined;
  }

  /**
   * The startup banner. Everything an operator needs to answer "is this
   * configuration sane for this connection" in one screen.
   */
  banner(productCount: number, effectiveCycleMin: number): string[] {
    const { config } = this;
    const identities = this.pool.list();
    const cycleMid = (config.cycle.minSec + config.cycle.maxSec) / 2 / 60;
    const ratePerMin = this.governor.capPerMin();
    return [
      '─── PricePulse scraping ───────────────────────────────',
      `  connection      ${config.connection.type} (own ISP line, no proxies)`,
      `  identities      ${identities.length} (${summariseStates(identities)})`,
      `  identity mode   ${config.identities.rotation} rotation, ` +
        `${Math.round(config.identities.minGapMs.min / 1000)}–${Math.round(config.identities.minGapMs.max / 1000)}s per-identity gap`,
      config.ipCap.mode === 'adaptive'
        ? `  IP budget       adaptive, starting ${config.ipCap.adaptive.startPerMin}/min ` +
          `within [${config.ipCap.adaptive.minPerMin}, ${config.ipCap.adaptive.maxPerMin}] ` +
          `(night ${config.night.startIST}–${config.night.endIST} IST)`
        : `  IP budget       fixed, ${config.ipCap.dayPerMin}/min day, ${config.ipCap.nightPerMin}/min night ` +
          `(night ${config.night.startIST}–${config.night.endIST} IST)`,
      `  concurrency     ${config.maxConcurrent} in flight, 1 per identity`,
      `  noise           ${Math.round(config.noiseRatio * 100)}% of fetches browse instead`,
      `  products        ${productCount}`,
      `  cycle           requested ${config.cycle.minSec}–${config.cycle.maxSec}s, ` +
        `effective ${effectiveCycleMin.toFixed(1)} min`,
      `  capacity        maxProducts ≈ perMin × cycleMinutes = ` +
        `${ratePerMin.toFixed(0)} × ${cycleMid.toFixed(1)} ≈ ${maxProductsFor(ratePerMin, cycleMid)}` +
        (config.ipCap.mode === 'adaptive' ? ' (moves as the rate is learned)' : ''),
      `  store           ${this.store.dir}`,
      '───────────────────────────────────────────────────────',
    ];
  }

  /**
   * A global pause is an ERROR, not a log line: it means the IP is in trouble
   * and everyone sharing it will notice. Route it through the alert path that
   * already exists rather than inventing a second one.
   */
  private async raiseHealthAlert(message: string): Promise<void> {
    try {
      const user = await this.prisma.user.findFirst({ select: { id: true } });
      if (!user) return;
      await this.prisma.alert.create({
        data: {
          userId: user.id,
          type: 'system_health',
          newValue: { healthMessage: message },
          firedAt: new Date(),
        },
      });
    } catch (err) {
      console.error('Could not raise health alert:', err instanceof Error ? err.message : err);
    }
  }
}

function safeLoadConfig(): ScrapingConfig {
  try {
    return loadScrapingConfig();
  } catch (err) {
    console.error(
      `Scraping config invalid, falling back to defaults: ${err instanceof Error ? err.message : err}`,
    );
    return DEFAULT_SCRAPING_CONFIG;
  }
}

function summariseStates(identities: readonly Identity[]): string {
  const counts = new Map<string, number>();
  for (const identity of identities) {
    const state = String(describeState(identity)).split('(')[0]!;
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  return [...counts.entries()].map(([state, n]) => `${n} ${state}`).join(', ');
}
