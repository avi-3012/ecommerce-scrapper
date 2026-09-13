import type { Identity, IdentityState, ScrapingConfig } from './types.js';
import {
  IDENTITY_SPECS,
  assertIdentityConsistent,
  generateHeaders,
  isSupportedSpec,
} from './headers.js';
import type { IdentitySpec } from './headers.js';
import { emptyMeta } from './store.js';
import type { IdentityStore, PoolMeta } from './store.js';
import type { IdentityCookieJar } from './jar.js';
import { ulid } from './ulid.js';
import { isNightIst } from './governor.js';

/**
 * The identity pool: a small, stable set of synthetic browsers sharing one IP,
 * paced so that together they look like a household or a small office rather
 * than a scraper.
 *
 * Everything here exists to defend one property — an identity is BORING. It
 * shows up at the same times, from the same browser, with the same cookies, at
 * a human interval, takes breaks, and mostly looks at the same handful of
 * products. The single most dangerous thing this layer could do is make an
 * identity interesting, which is why nothing about a live identity is ever
 * regenerated.
 */

/**
 * Default per-identity minimum gap between requests, randomized once at
 * creation. Overridden by `identities.minGapMs` — at high request rates the gap
 * is what bounds the pool's throughput, so it has to be tunable alongside the
 * pool size rather than fixed here.
 */
export const MIN_GAP_RANGE_MS = { min: 60_000, max: 150_000 } as const;
/** How long a blocked identity stays out of service. */
export const COOLING_RANGE_MS = { min: 45 * 60_000, max: 120 * 60_000 } as const;
/** Away periods: a human puts the laptop down. */
export const AWAY_RANGE_MS = { min: 20 * 60_000, max: 90 * 60_000 } as const;
export const AWAY_PER_DAY = { min: 2, max: 4 } as const;
/** Background churn: roughly one identity replaced per week. */
export const CHURN_INTERVAL_MS = 7 * 24 * 3600_000;
/**
 * How many identities may be created in one top-up.
 *
 * The pool loses members to retirement and has to replace them, but replacing
 * seventeen at once would put seventeen brand-new personas into service in the
 * same minute — each needing its own warm-up, all with empty jars and no
 * history. A household does not acquire seventeen devices at once. Refill a
 * couple per cycle and the pool recovers within the hour without a visible step
 * change in what the connection looks like.
 */
export const MAX_REFILL_PER_PASS = 2;
/** Hard blocks within 24 h that retire an identity early. */
export const RETIRE_AFTER_BLOCKS = 3;
/** Chance that a product stays with the identity that fetched it last cycle. */
export const STICKINESS = 0.7;
/** How many identities stay awake overnight. */
export const NIGHT_CREW = { min: 1, max: 2 } as const;
/** How long pool-file writes are coalesced for. */
export const PERSIST_DEBOUNCE_MS = 1_000;

function randomBetween(range: { min: number; max: number }, random: () => number): number {
  return Math.round(range.min + random() * (range.max - range.min));
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] ?? items[0]!;
}

export function createIdentity(
  spec: IdentitySpec = { browser: 'chrome', os: 'windows', device: 'desktop' },
  now: number = Date.now(),
  random: () => number = Math.random,
  gapRange: { min: number; max: number } = MIN_GAP_RANGE_MS,
  egressId?: string,
): Identity {
  const identity: Identity = {
    id: ulid(now),
    browser: spec.browser,
    os: spec.os,
    device: spec.device,
    ...(egressId ? { egressId } : {}),
    headers: generateHeaders(spec),
    minGapMs: randomBetween(gapRange, random),
    state: 'fresh',
    coolingUntil: null,
    lastUrlBySite: {},
    warmedSites: [],
    lastRequestAt: null,
    awayUntil: null,
    awayDay: null,
    awayCount: 0,
    recentBlocks: [],
    consecutiveBlocks: 0,
    stats: {
      requests: 0,
      blocks: 0,
      suspects: 0,
      createdAt: new Date(now).toISOString(),
      lastUsedAt: null,
    },
  };
  // Refuse to admit a contradictory persona, at the one moment it can still be
  // rejected for free.
  assertIdentityConsistent(identity);
  return identity;
}

export interface AcquireOptions {
  /** Site key the fetch is for ('amazon.in' / 'flipkart.com'). */
  site: string;
  /** The product this fetch is for, for stickiness. Absent for noise fetches. */
  productId?: string;
  now?: number;
  /**
   * Extra eligibility test, applied on top of the pool's own. Used to skip
   * identities whose egress address is currently paused: handing one out would
   * only produce a request that is refused at the gate a moment later, while a
   * usable identity on another address sat idle.
   */
  usable?: (identity: Identity) => boolean;
}

export class IdentityPool {
  private identities: Identity[];
  private meta: PoolMeta;
  /** Ids with a request in flight — the "one in-flight request per identity" rail. */
  private readonly busy = new Set<string>();
  private persistTimer: NodeJS.Timeout | null = null;

  constructor(
    readonly config: ScrapingConfig,
    readonly store: IdentityStore,
    private readonly random: () => number = Math.random,
    /** Called when an identity is retired, so its sockets can be released. */
    private readonly onRetire?: (identityId: string) => void,
  ) {
    const loaded = store.loadPool();
    this.identities = loaded.identities;
    this.meta = { ...emptyMeta(), ...loaded.meta };
  }

  /**
   * Re-read the pool from disk.
   *
   * The worker and the API both draw identities from ONE pool on one line, so
   * each has to see the other's cooling flags and pacing timestamps. Every
   * mutation persists immediately, so a reload before selection is enough to
   * keep the two processes from handing out the same identity twice in a row or
   * ignoring a cool-down the other just set.
   */
  reload(): void {
    // A pending write means OUR copy is the newer one — every mutation updates
    // memory first and schedules the file second. Reloading over it would
    // resurrect the state we just superseded, which shows up as identities
    // whose `lastRequestAt` never advances: selection then sees a permanent
    // tie and stops rotating.
    if (this.persistTimer) return;
    const loaded = this.store.loadPool();
    if (loaded.identities.length === 0) return;
    this.identities = loaded.identities;
    this.meta = { ...emptyMeta(), ...loaded.meta };
  }

  /** Top the pool up to the configured size and apply background churn. */
  ensureSize(now: number = Date.now(), maxNew = Number.POSITIVE_INFINITY): void {
    this.reload();
    this.identities = this.identities.filter((i) => i.state !== 'retired');
    // Retire personas whose device class is no longer supported. Trimming by
    // COUNT alone would leave them in place indefinitely, and an identity whose
    // pages the parsers cannot read is a guaranteed failure every time it is
    // handed out.
    for (const identity of [...this.identities]) {
      if (!isSupportedSpec(identity)) {
        this.retire(identity, `${identity.device}/${identity.os} is no longer a supported persona`);
      }
    }
    this.applyChurn(now);
    this.rebalanceEgress(Math.min(maxNew, MAX_REFILL_PER_PASS));
    let created = 0;
    while (this.identities.length < this.config.identities.count && created < maxNew) {
      this.identities.push(
        createIdentity(
          pick(IDENTITY_SPECS, this.random),
          now,
          this.random,
          this.config.identities.minGapMs,
          this.nextEgress(),
        ),
      );
      created++;
    }
    if (created > 0 && this.identities.length < this.config.identities.count) {
      console.log(
        `[identity] pool topped up by ${created} (${this.identities.length}/${this.config.identities.count}); ` +
          `refilling gradually`,
      );
    }
    // Shrinking the configured count retires the youngest first: the oldest
    // identities carry the most history and are the most credible.
    while (this.identities.length > this.config.identities.count) {
      const youngest = this.identities.reduce((a, b) => (a.id > b.id ? a : b));
      this.retire(youngest, 'pool shrunk to configured size');
    }
    // A gap range edited in config applies to identities that already exist:
    // otherwise lowering it would only take effect as the pool slowly churned,
    // which is weeks away and not what anyone editing that number expects.
    const { min, max } = this.config.identities.minGapMs;
    for (const identity of this.identities) {
      if (identity.minGapMs < min || identity.minGapMs > max) {
        identity.minGapMs = randomBetween({ min, max }, this.random);
      }
    }
    this.persistNow();
  }

  list(): readonly Identity[] {
    return this.identities;
  }

  byId(id: string): Identity | undefined {
    return this.identities.find((i) => i.id === id);
  }

  jarFor(identity: Identity): IdentityCookieJar {
    return this.store.jarFor(identity.id);
  }

  isBusy(id: string): boolean {
    return this.busy.has(id);
  }

  // ── selection ─────────────────────────────────────────────────────────────

  /**
   * Which identities could take a fetch right now: in service, not blocked, not
   * on a break, not mid-request, and past their own minimum gap. At night the
   * field narrows to the small overnight crew — a house where every device is
   * awake at 3 a.m. is not a house.
   */
  eligible(now: number = Date.now()): Identity[] {
    this.thaw(now);
    const nightCrew = isNightIst(now, this.config.night) ? new Set(this.nightCrew(now)) : null;
    return this.identities.filter((identity) => {
      if (identity.state !== 'warm' && identity.state !== 'active' && identity.state !== 'fresh') {
        return false;
      }
      if (this.busy.has(identity.id)) return false;
      if (identity.awayUntil !== null && identity.awayUntil > now) return false;
      if (identity.lastRequestAt !== null && now - identity.lastRequestAt < identity.minGapMs) {
        return false;
      }
      if (nightCrew && !nightCrew.has(identity.id)) return false;
      return true;
    });
  }

  /**
   * Assign an identity to a fetch. Stickiness ~70%: the identity that fetched
   * this product last cycle fetches it again, because a household device that
   * keeps checking the same laptop listing is ordinary, while a product visited
   * by a different browser every two minutes is not. The other ~30% switch, so
   * no product is permanently welded to one identity.
   */
  acquire(options: AcquireOptions): Identity | null {
    const now = options.now ?? Date.now();
    this.reload();
    const eligible = options.usable
      ? this.eligible(now).filter(options.usable)
      : this.eligible(now);
    if (eligible.length === 0) return null;

    // Per-request rotation: no incumbent, no stickiness. Every fetch goes to the
    // least recently used identity, so consecutive requests from this IP present
    // as different browsers. Each is still internally consistent and keeps its
    // own jar — what changes is only how much history any one of them builds up.
    if (this.config.identities.rotation === 'per-request') {
      const chosen = [...eligible].sort(
        (a, b) => (a.lastRequestAt ?? 0) - (b.lastRequestAt ?? 0) || this.random() - 0.5,
      )[0]!;
      this.busy.add(chosen.id);
      return chosen;
    }

    const sticky = options.productId ? this.meta.assignments[options.productId] : undefined;
    const preferred = sticky ? eligible.find((i) => i.id === sticky) : undefined;

    let chosen: Identity;
    if (preferred && this.random() < STICKINESS) {
      chosen = preferred;
    } else {
      // A switch has to actually switch: drop the incumbent from the field
      // before choosing, or a recency tie would keep handing back the same
      // identity and the 30% would be 30% of nothing.
      const field =
        preferred && eligible.length > 1 ? eligible.filter((i) => i.id !== preferred.id) : eligible;
      // Least recently used, which spreads load and keeps every identity's
      // history alive rather than letting a few carry the pool and the rest
      // look dormant. Ties are broken at random so no identity is permanently
      // first in line.
      const ranked = [...field].sort(
        (a, b) => (a.lastRequestAt ?? 0) - (b.lastRequestAt ?? 0) || this.random() - 0.5,
      );
      chosen = ranked[0]!;
    }

    if (options.productId) {
      this.meta.assignments[options.productId] = chosen.id;
      // Persisted so stickiness survives both a restart AND the other process's
      // next reload — otherwise the 70% would silently become 0%. Debounced:
      // losing the last second of assignments costs a little stickiness, which
      // is a preference rather than a safety property.
      this.persist();
    }
    this.busy.add(chosen.id);
    return chosen;
  }

  release(identity: Identity): void {
    this.busy.delete(identity.id);
  }

  /** The 1–2 identities that stay up overnight; stable for a whole night. */
  nightCrew(now: number): string[] {
    const sorted = [...this.identities]
      .filter((i) => i.state === 'warm' || i.state === 'active' || i.state === 'fresh')
      .sort((a, b) => (a.id < b.id ? -1 : 1));
    if (sorted.length === 0) return [];
    // Seed from the IST calendar date so the crew rotates nightly but does not
    // change halfway through a night.
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
      new Date(now),
    );
    let seed = 0;
    for (const ch of day) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const size = Math.min(
      NIGHT_CREW.min + (seed % (NIGHT_CREW.max - NIGHT_CREW.min + 1)),
      sorted.length,
    );
    return Array.from({ length: size }, (_, n) => sorted[(seed + n) % sorted.length]!.id);
  }

  // ── outcome recording ─────────────────────────────────────────────────────

  /** A clean fetch. Promotes a warmed identity into normal service. */
  noteOk(identity: Identity, url: string, now: number = Date.now()): void {
    identity.consecutiveBlocks = 0;
    identity.stats.requests += 1;
    identity.stats.lastUsedAt = new Date(now).toISOString();
    identity.lastRequestAt = now;
    identity.lastUrlBySite[siteKeyOf(url)] = url;
    if (identity.state === 'warm' || identity.state === 'fresh') identity.state = 'active';
    this.maybeGoAway(identity, now);
    this.persist();
  }

  /** A suspect response: recorded against the identity, but not a block. */
  noteSuspect(identity: Identity, now: number = Date.now()): void {
    identity.stats.suspects += 1;
    identity.stats.requests += 1;
    identity.stats.lastUsedAt = new Date(now).toISOString();
    identity.lastRequestAt = now;
    this.persist();
  }

  /**
   * A hard block. The identity goes cooling for 45–120 min — the replacement for
   * "rotate the proxy", except the identity comes BACK rather than being thrown
   * away, because throwing identities away is what makes a pool look synthetic.
   * Repeated blocks are different: that identity is genuinely burned, so retire.
   */
  noteBlock(identity: Identity, now: number = Date.now()): void {
    identity.stats.blocks += 1;
    identity.stats.requests += 1;
    identity.stats.lastUsedAt = new Date(now).toISOString();
    identity.lastRequestAt = now;
    identity.consecutiveBlocks += 1;
    identity.recentBlocks = [...identity.recentBlocks, now].filter((t) => now - t < 24 * 3600_000);

    if (identity.recentBlocks.length >= RETIRE_AFTER_BLOCKS) {
      this.retire(identity, `${identity.recentBlocks.length} hard blocks in 24 h`);
    } else {
      identity.state = 'cooling';
      identity.coolingUntil = now + randomBetween(COOLING_RANGE_MS, this.random);
      console.warn(
        `[identity] ${identity.id} cooling until ${new Date(identity.coolingUntil).toISOString()} ` +
          `(${identity.recentBlocks.length} block(s) in 24 h)`,
      );
    }
    this.persistNow();
  }

  /** Mark a site warmed for this identity (homepage cookies collected). */
  noteWarmed(identity: Identity, site: string, now: number = Date.now()): void {
    if (!identity.warmedSites.includes(site)) identity.warmedSites.push(site);
    if (identity.state === 'fresh') identity.state = 'warm';
    identity.lastRequestAt = now;
    identity.stats.requests += 1;
    this.persist();
  }

  needsWarmUp(identity: Identity, site: string): boolean {
    return !identity.warmedSites.includes(site);
  }

  /**
   * The address a new identity should be bound to: whichever configured egress
   * currently carries the fewest live identities, so the pool stays balanced as
   * personas retire unevenly. Undefined when no egress is configured, which
   * leaves the identity on the host's default route.
   */
  private nextEgress(): string | undefined {
    const egress = this.config.egress;
    if (egress.length === 0) return undefined;
    const load = this.egressLoad();
    let best = egress[0]!;
    for (const ip of egress) {
      if (load.get(ip)! < load.get(best)!) best = ip;
    }
    return best;
  }

  /** How many live identities each configured address currently carries. */
  private egressLoad(): Map<string, number> {
    const load = new Map(this.config.egress.map((ip) => [ip, 0]));
    for (const identity of this.identities) {
      const ip = identity.egressId;
      if (ip !== undefined && load.has(ip)) load.set(ip, load.get(ip)! + 1);
    }
    return load;
  }

  /**
   * Re-home identities whose address has been removed from the config, and
   * balance any that never had one. Called from `ensureSize`, so an egress list
   * edited in config takes effect on the next cycle instead of only as the pool
   * slowly churns.
   */
  private rebalanceEgress(maxMoves: number): void {
    const egress = this.config.egress;
    if (egress.length === 0) {
      for (const identity of this.identities) delete identity.egressId;
      return;
    }
    // An identity with no address, or one whose address has been removed from
    // the config, is re-homed directly: there is no address it has been
    // consistent with, so nothing is broken by giving it one.
    for (const identity of this.identities) {
      if (identity.egressId === undefined || !egress.includes(identity.egressId)) {
        identity.egressId = this.nextEgress();
      }
    }

    // ADDING an address moves nobody, and that is a silent failure: the new
    // address sits idle while the budget it carries is counted in the total the
    // cycle planner spends against. Two addresses added to a pool of 48 already
    // split across two others left half the allowance stranded on addresses
    // with no identities to spend it.
    //
    // Rebalancing RETIRES rather than reassigns. An identity's address is part
    // of its fingerprint in the same way its headers are, and a persona seen
    // from two addresses is a pattern no browser produces — so it has to die
    // and be reborn elsewhere rather than move. The refill below then creates
    // the replacements, and `nextEgress` puts them on the emptiest address.
    //
    // Bounded per pass so the pool drains onto the new addresses over a few
    // minutes instead of retiring half the personas at once, which would be a
    // wave of warm-ups — the exact burst shape that earns a block.
    // While the pool is still growing toward its target, let the refill do the
    // balancing. New identities are created on the least-loaded address, so an
    // empty address fills on its own — retiring aged personas to make room for
    // identities that were about to be created anyway throws away exactly the
    // history that makes a persona credible. Growing identities.count in the
    // same change as the address list is how a large expansion avoids a
    // retirement wave, and this is what makes that work: without it the
    // rebalancer ran first, measured fair share against the CURRENT pool, and
    // killed established identities pass after pass while the refill replaced
    // them one for one.
    if (this.identities.length < this.config.identities.count) return;

    const fairShare = Math.floor(this.identities.length / egress.length);
    for (let moved = 0; moved < maxMoves; moved++) {
      const load = this.egressLoad();
      const emptiest = egress.reduce((a, b) => (load.get(a)! <= load.get(b)! ? a : b));
      const fullest = egress.reduce((a, b) => (load.get(a)! >= load.get(b)! ? a : b));
      if (load.get(emptiest)! >= fairShare) break;
      if (load.get(fullest)! - load.get(emptiest)! <= 1) break;
      const onFullest = this.identities.filter((i) => i.egressId === fullest);
      if (onFullest.length === 0) break;
      // Youngest first: the oldest personas carry the most history and are the
      // most credible, so they are the last ones to spend.
      const youngest = onFullest.reduce((a, b) => (a.id > b.id ? a : b));
      this.retire(youngest, `rebalancing onto ${emptiest}`);
    }
  }

  retire(identity: Identity, why: string): void {
    identity.state = 'retired';
    this.onRetire?.(identity.id);
    console.log(`[identity] retiring ${identity.id} (${identity.browser}/${identity.os}): ${why}`);
    this.identities = this.identities.filter((i) => i.id !== identity.id);
    this.store.dropJar(identity.id);
    for (const [productId, assigned] of Object.entries(this.meta.assignments)) {
      if (assigned === identity.id) delete this.meta.assignments[productId];
    }
  }

  // ── lifecycle helpers ─────────────────────────────────────────────────────

  /** Return cooled-off identities to service. */
  private thaw(now: number): void {
    let changed = false;
    for (const identity of this.identities) {
      if (identity.state === 'cooling' && (identity.coolingUntil ?? 0) <= now) {
        identity.state = 'active';
        identity.coolingUntil = null;
        changed = true;
      }
      if (identity.awayUntil !== null && identity.awayUntil <= now) {
        identity.awayUntil = null;
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /**
   * Occasionally put an identity down for 20–90 minutes. Real people do not
   * refresh a price page every ninety seconds for eighteen hours straight; the
   * gaps are as much a part of looking human as the pacing is.
   */
  private maybeGoAway(identity: Identity, now: number): void {
    const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
      new Date(now),
    );
    if (identity.awayDay !== day) {
      identity.awayDay = day;
      identity.awayCount = 0;
    }
    const target =
      AWAY_PER_DAY.min + Math.floor(this.random() * (AWAY_PER_DAY.max - AWAY_PER_DAY.min + 1));
    if (identity.awayCount >= target) return;
    // Spread the day's breaks out: roughly `target` breaks over ~18 waking hours
    // at one request per minGap works out to a small per-request probability.
    const requestsPerDay = (18 * 3600_000) / identity.minGapMs;
    if (this.random() < target / Math.max(requestsPerDay, 1)) {
      identity.awayUntil = now + randomBetween(AWAY_RANGE_MS, this.random);
      identity.awayCount += 1;
    }
  }

  /**
   * Background churn: about one identity replaced per week, so the pool ages
   * the way a household's devices do — gradually — instead of every persona
   * being the same vintage forever.
   */
  private applyChurn(now: number): void {
    if (this.identities.length === 0) {
      this.meta.lastChurnAt = now;
      return;
    }
    if (this.meta.lastChurnAt === null) {
      this.meta.lastChurnAt = now;
      return;
    }
    if (now - this.meta.lastChurnAt < CHURN_INTERVAL_MS) return;
    const oldest = this.identities.reduce((a, b) => (a.id < b.id ? a : b));
    this.retire(oldest, 'scheduled churn (≈1 identity per 7 days)');
    this.meta.lastChurnAt = now;
  }

  /**
   * Schedule a write of the pool file.
   *
   * Coalesced rather than immediate: `pool.json` carries every identity's full
   * header set, so it is tens of kilobytes, and at a hundred requests a minute
   * writing it synchronously per request would cost megabytes of I/O a minute
   * to record a handful of counter bumps. A write lands within
   * `PERSIST_DEBOUNCE_MS`, which is well inside the interval any other process
   * reloads at, and anything unwritten at a crash is one second of statistics.
   *
   * Cooling and retirement do NOT go through here — see `persistNow`.
   */
  persist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.store.saveIdentities(this.identities, this.meta);
    }, PERSIST_DEBOUNCE_MS);
    this.persistTimer.unref?.();
  }

  /**
   * Write immediately. Used for state another process must not miss even for a
   * second: an identity going cooling, or being retired. Losing a counter bump
   * is nothing; letting a second process keep using an identity we just took
   * out of service is the bug this exists to prevent.
   */
  persistNow(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.store.saveIdentities(this.identities, this.meta);
  }

  flush(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.store.flush(this.identities, this.meta);
  }

  /** Read-only view of who is assigned to what, for the status command. */
  assignments(): Readonly<Record<string, string>> {
    return this.meta.assignments;
  }
}

export function siteKeyOf(url: string): string {
  const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/** Human-readable state summary for logs and the status command. */
export function describeState(
  identity: Identity,
  now: number = Date.now(),
): IdentityState | string {
  if (identity.state === 'cooling' && identity.coolingUntil) {
    return `cooling(${Math.max(0, Math.round((identity.coolingUntil - now) / 60_000))}m)`;
  }
  if (identity.awayUntil && identity.awayUntil > now) {
    return `${identity.state}/away(${Math.max(0, Math.round((identity.awayUntil - now) / 60_000))}m)`;
  }
  return identity.state;
}
