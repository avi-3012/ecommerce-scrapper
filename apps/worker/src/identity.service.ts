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
  /**
   * One governor per egress address, keyed by address ('' = the host's default
   * route, which is the single-IP case).
   *
   * The far end decides per address, so the budget, the backoff and the
   * adaptive controller are all per address too. Under one shared governor a
   * single bad minute cost 100% of throughput for up to three hours; across
   * five addresses the same minute costs a fifth of it.
   */
  readonly governors = new Map<string, IpGovernor>(
    (this.config.egress.length ? this.config.egress : ['']).map((ip) => [
      ip,
      new IpGovernor(
        this.config,
        this.store,
        (alert) => void this.raiseHealthAlert(alert.message),
        ip || undefined,
      ),
    ]),
  );

  /** The governor accounting for this identity's address. */
  governorFor(identity: Identity): IpGovernor {
    return this.governors.get(identity.egressId ?? '') ?? this.defaultGovernor;
  }

  /**
   * A governor to ask about process-wide facts — the kill switch, and the
   * config every governor shares. Never used for per-address accounting.
   */
  get defaultGovernor(): IpGovernor {
    return this.governors.values().next().value!;
  }

  /**
   * Total requests per minute across every address. This is the number the
   * cycle planner needs: five addresses at 3/min is a 15/min catalogue budget,
   * and planning against one address's share would stretch every cycle fivefold.
   */
  capPerMinTotal(now: number = Date.now()): number {
    let total = 0;
    for (const governor of this.governors.values()) total += governor.capPerMin(now);
    return total;
  }

  /**
   * Whether ANY address can currently take a request. A cycle is only pointless
   * when every address is stopped — with one paused out of five, four fifths of
   * the catalogue is still servable.
   */
  gate(now: number = Date.now()): { allowed: boolean; reason: string | null } {
    let reason: string | null = null;
    for (const governor of this.governors.values()) {
      const decision = governor.canRequest(now);
      if (decision.allowed) return { allowed: true, reason: null };
      reason ??= decision.reason;
    }
    return { allowed: false, reason };
  }

  /**
   * The vitals, merged across every egress.
   *
   * Rates and usage are summed because they are budgets: five addresses at
   * 3/min really is a 15/min catalogue budget. Backoff level and the block
   * ratio take the WORST address rather than an average — an average hides the
   * one address in trouble behind four healthy ones, which is the opposite of
   * what a health panel is for. `pausedUntil` is set only when every address is
   * stopped, since anything less is partial capacity, not an outage.
   */
  vitals(now: number = Date.now()): {
    capPerMin: number;
    learnedPerMin: number;
    usedLastMinute: number;
    usedLastHour: number;
    recentBlockRatio: number;
    recentCongestionRatio: number;
    unreadable: number;
    backoffLevel: number;
    pausedUntil: number | null;
    mode: string;
    diurnalFactor: number;
    isNight: boolean;
    egressCount: number;
    egressPaused: number;
  } {
    const snaps = [...this.governors.values()].map((g) => g.snapshot(now));
    const first = snaps[0]!;
    const sum = (pick: (s: (typeof snaps)[number]) => number): number =>
      snaps.reduce((total, s) => total + pick(s), 0);
    const max = (pick: (s: (typeof snaps)[number]) => number): number =>
      snaps.reduce((best, s) => Math.max(best, pick(s)), 0);
    const pausedSnaps = snaps.filter((s) => s.pausedUntil !== null);
    return {
      capPerMin: sum((s) => s.capPerMin),
      learnedPerMin: sum((s) => s.learnedPerMin),
      usedLastMinute: sum((s) => s.usedLastMinute),
      usedLastHour: sum((s) => s.usedLastHour),
      recentBlockRatio: max((s) => s.recentBlockRatio),
      recentCongestionRatio: max((s) => s.recentCongestionRatio),
      unreadable: sum((s) => s.unreadable ?? 0),
      backoffLevel: max((s) => s.backoffLevel),
      pausedUntil:
        pausedSnaps.length === snaps.length && snaps.length > 0
          ? max((s) => s.pausedUntil ?? 0)
          : null,
      mode: first.mode,
      diurnalFactor: first.diurnalFactor,
      isNight: first.isNight,
      egressCount: snaps.length,
      egressPaused: pausedSnaps.length,
    };
  }

  /** True when this identity's own address is currently able to send. */
  /**
   * The addresses that can take a request right now.
   *
   * Computed once per acquire rather than per candidate identity: `canRequest`
   * re-reads its state file, so asking it per persona would mean one
   * synchronous read per identity per check — forty-eight where five will do.
   */
  private openEgresses(now: number = Date.now()): Set<string> {
    const open = new Set<string>();
    for (const [ip, governor] of this.governors) {
      if (governor.canRequest(now).allowed) open.add(ip);
    }
    return open;
  }
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
    this.browserTier = await createBrowserTier(undefined, this.defaultGovernor);
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
    const open = this.openEgresses();
    const identity = this.pool.acquire({
      site,
      productId,
      // Skip identities whose address is backing off: handing one out would
      // only produce a request refused at the gate a moment later, while a
      // usable identity on another address sat idle.
      usable: (candidate) => open.has(candidate.egressId ?? ''),
    });
    if (!identity) return null;
    return new IdentitySession(
      identity,
      this.pool,
      this.governorFor(identity),
      marketplace,
      this.shuttingDown,
    );
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
    const ratePerMin = this.capPerMinTotal();
    return [
      '─── PricePulse scraping ───────────────────────────────',
      config.egress.length
        ? `  connection      ${config.connection.type}, ${config.egress.length} source ` +
          `address${config.egress.length === 1 ? '' : 'es'} (${config.egress.join(', ')}), ` +
          `each with its own budget and backoff`
        : `  connection      ${config.connection.type} (single address, own route)`,
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
      // Against the EFFECTIVE cycle, not the requested one. Quoting the
      // requested cycle understates capacity by exactly the factor the cycle
      // has stretched — a banner reading "≈ 12" while 50 products are being
      // checked is the kind of wrong that costs someone an hour.
      `  capacity        maxProducts ≈ perMin × cycleMinutes = ` +
        `${ratePerMin.toFixed(0)} × ${effectiveCycleMin.toFixed(1)} ≈ ` +
        `${maxProductsFor(ratePerMin, effectiveCycleMin)}` +
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
