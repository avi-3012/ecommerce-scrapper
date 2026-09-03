import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { IdentityStore } from './store.js';
import type { CapMode, ScrapingConfig } from './types.js';

/**
 * The IP governor: everything that is true of the whole connection rather than
 * of one identity.
 *
 * With residential proxies, a block was a routing problem — rotate the exit node
 * and carry on. On one ISP line there is nowhere to rotate to, so the caps here
 * are HARD limits and the backoff is the only lever left. The scheduler is
 * expected to stretch its cycle to fit under the cap; the governor never lets it
 * through if it doesn't.
 */

/** Backoff ladder in minutes, capped at 3 h. */
export const BACKOFF_LADDER_MIN = [10, 20, 40, 80, 160, 180] as const;
/** Hard blocks within this window that trip the global pause. */
export const BLOCK_BURST = { count: 2, windowMs: 15 * 60_000 } as const;
export const BLOCK_HOURLY = { count: 3, windowMs: 60 * 60_000 } as const;
/** After a global pause, the daytime cap runs at half for this long. */
export const DEGRADE_MS = 6 * 3600_000;
/**
 * Share of recent requests that may fail at the transport layer before the rate
 * is cut. Higher than the block threshold: a refusal is a deliberate act, while
 * a timeout is often just the internet.
 */
export const CONGESTION_RATIO_THRESHOLD = 0.15;
/** A clean stretch this long forgets the backoff level. */
export const BACKOFF_DECAY_MS = 6 * 3600_000;

/** Width of one usage bucket. Twelve of these cover the reported hour. */
export const USAGE_BUCKET_MS = 5 * 60_000;

/**
 * Share of the daytime rate to run in each IST hour, 00:00 → 23:00.
 *
 * A binary day/night switch produces a step function: flat all day, flat all
 * night, two cliffs. Real shopping traffic has none of those edges — it wakes
 * slowly, dips at lunch, peaks in the evening and tails off past midnight. This
 * is a coarse approximation of that curve, and its purpose is that the request
 * rate from this address rises and falls the way a household's does rather than
 * sitting at exactly one of two values.
 */
export const DIURNAL_CURVE: readonly number[] = [
  0.25,
  0.15,
  0.1,
  0.1,
  0.1,
  0.12,
  0.2,
  0.35, // 00–07  small hours → waking
  0.55,
  0.7,
  0.8,
  0.85,
  0.9,
  0.85,
  0.8,
  0.8, //  08–15  morning → afternoon
  0.85,
  0.9,
  1.0,
  1.0,
  0.95,
  0.85,
  0.6,
  0.4, //  16–23  evening peak → wind-down
];

/** The diurnal multiplier for an instant, interpolated between hours. */
export function diurnalFactor(epochMs: number): number {
  const minutes = istMinutes(epochMs);
  const hour = Math.floor(minutes / 60);
  const frac = (minutes % 60) / 60;
  const a = DIURNAL_CURVE[hour % 24]!;
  const b = DIURNAL_CURVE[(hour + 1) % 24]!;
  // Interpolated so the rate glides between hours instead of stepping.
  return a + (b - a) * frac;
}

export interface GovernorState {
  /** Epoch ms of recent hard blocks (pruned to the hourly window). */
  blocks: number[];
  /**
   * Adaptive mode only: the rate the controller has settled on, per minute, and
   * when it last climbed. Persisted, because what this connection tolerates is
   * learned over hours and a restart should not throw that away and re-probe
   * from scratch.
   */
  adaptivePerMin: number | null;
  lastIncreaseAt: number | null;
  /**
   * Epoch ms of requests inside the rolling 60 s window the cap is computed
   * over. Deliberately NOT an hour of timestamps: this file is rewritten on
   * every request, and at 100+/min an hour of them is ~80 KB written a hundred
   * times a minute. The window the cap needs is one minute; the hour that
   * `status` reports comes from the buckets below, which cost twelve numbers.
   */
  requests: number[];
  /** Coarse usage history: [bucketStartMs, count], newest last, one hour deep. */
  usageBuckets: Array<[number, number]>;
  /**
   * Epoch ms of recent CONGESTION signals — timeouts, 5xx, transport failures.
   * Distinct from `blocks`, which are explicit refusals, and deliberately
   * distinct from parse failures (see `recordSoftSignal`).
   */
  congestion: number[];
  backoffLevel: number;
  /** Count of responses we could not read. Never throttles; surfaced loudly. */
  unreadable?: number;
  pausedUntil: number | null;
  /** While set, the daytime cap runs at half. */
  degradedUntil: number | null;
  /** Epoch ms of the most recent hard block, for backoff decay. */
  lastBlockAt: number | null;
  /**
   * Epoch ms of the most recent request actually sent. Separate from
   * `requests`, which is pruned to 60 s: the adaptive controller needs to know
   * whether ANY traffic went out since it last climbed, and that question
   * outlives the cap's one-minute window.
   */
  lastRequestAt?: number | null;
}

function emptyState(): GovernorState {
  return {
    blocks: [],
    requests: [],
    usageBuckets: [],
    congestion: [],
    adaptivePerMin: null,
    lastIncreaseAt: null,
    backoffLevel: 0,
    pausedUntil: null,
    degradedUntil: null,
    lastBlockAt: null,
    lastRequestAt: null,
  };
}

export type PauseReason = 'kill_switch' | 'backoff' | 'cap' | null;

export interface GovernorDecision {
  allowed: boolean;
  reason: PauseReason;
  /** How long to wait before asking again, in ms. */
  retryAfterMs: number;
}

export interface GovernorAlert {
  message: string;
  backoffLevel: number;
  pausedUntilIso: string;
}

export class IpGovernor {
  private state: GovernorState;

  constructor(
    private readonly config: ScrapingConfig,
    private readonly store: IdentityStore,
    /** Called on ERROR-level events (global pause) so the existing alert path fires. */
    private readonly onAlert: (alert: GovernorAlert) => void = () => {},
  ) {
    this.state = { ...emptyState(), ...(store.loadGovernor<GovernorState>() ?? {}) };
    this.state.blocks ??= [];
    this.state.requests ??= [];
    this.state.usageBuckets ??= [];
    this.state.congestion ??= [];
  }

  /**
   * Re-read the shared state from disk.
   *
   * The worker and the API are separate processes on ONE connection, so the cap
   * has to be counted across both or it is not a cap. The state file is the
   * shared ledger: it is re-read before every decision and written after every
   * mutation. A JSON round-trip per request is nothing at six requests a minute,
   * and the alternative — each process believing it owns the whole cap — is how
   * an IP gets flagged.
   */
  private reload(): void {
    const stored = this.store.loadGovernor<GovernorState>();
    if (!stored) return;
    this.state = {
      ...emptyState(),
      ...stored,
      blocks: stored.blocks ?? [],
      requests: stored.requests ?? [],
      usageBuckets: stored.usageBuckets ?? [],
      congestion: stored.congestion ?? [],
    };
  }

  /** Read-only snapshot for the `status` command and the startup banner. */
  snapshot(now: number = Date.now()): GovernorState & {
    capPerMin: number;
    learnedPerMin: number;
    mode: CapMode;
    diurnalFactor: number;
    isNight: boolean;
    usedLastHour: number;
    recentBlockRatio: number;
    recentCongestionRatio: number;
    usedLastMinute: number;
    paused: boolean;
  } {
    this.reload();
    this.prune(now);
    return {
      ...this.state,
      capPerMin: this.capPerMin(now),
      learnedPerMin: this.learnedPerMin(now),
      mode: this.config.ipCap.mode,
      diurnalFactor: this.config.diurnal.enabled ? diurnalFactor(now) : 1,
      isNight: isNightIst(now, this.config.night),
      usedLastHour: this.state.usageBuckets.reduce((sum, [, n]) => sum + n, 0),
      usedLastMinute: this.state.requests.filter((t) => now - t < 60_000).length,
      recentBlockRatio: this.recentBlockRatio(now),
      recentCongestionRatio: this.recentCongestionRatio(now),
      paused: this.pausedNow(now) !== null,
    };
  }

  // ── kill switch ───────────────────────────────────────────────────────────

  /**
   * `PAUSE=1` in the environment, or a `PAUSE` file next to the identity store
   * or in the working directory. Checked on every gate call, so the effect lands
   * within one scheduler slot — well inside the 5 s the rails require.
   */
  killSwitchEngaged(): boolean {
    if (process.env.PAUSE === '1') return true;
    return existsSync(join(this.store.dir, 'PAUSE')) || existsSync(join(process.cwd(), 'PAUSE'));
  }

  // ── caps ──────────────────────────────────────────────────────────────────

  /**
   * The rate in force right now.
   *
   * In `fixed` mode this is the configured day/night number, halved while
   * degraded. In `adaptive` mode it is whatever the controller has learned:
   * the configured number is only where it started.
   */
  /**
   * The ceiling this connection has been LEARNED to tolerate, before the time
   * of day is taken into account. This is the number the AIMD controller moves;
   * `capPerMin` is what is actually spendable right now.
   */
  learnedPerMin(now: number = Date.now()): number {
    if (this.config.ipCap.mode !== 'adaptive') return this.config.ipCap.dayPerMin;
    return this.adaptiveRate(now);
  }

  capPerMin(now: number = Date.now()): number {
    if (this.config.ipCap.mode === 'adaptive') {
      // The learned ceiling is what this connection tolerates at its busiest;
      // the diurnal curve decides how much of that to actually use right now.
      const rate = this.adaptiveRate(now) * (this.config.diurnal.enabled ? diurnalFactor(now) : 1);
      return Math.max(this.config.ipCap.adaptive.minPerMin, rate);
    }
    const night = isNightIst(now, this.config.night);
    if (night) return this.config.ipCap.nightPerMin;
    const day = this.config.ipCap.dayPerMin;
    return this.state.degradedUntil && this.state.degradedUntil > now ? day / 2 : day;
  }

  /**
   * Additive increase, multiplicative decrease — TCP's congestion control, aimed
   * at an anti-bot system instead of a bottleneck link.
   *
   * The insight is the same in both places: the ceiling is a property of the
   * far end, it is not published, and it moves. So probe it. Climb by one
   * request per minute for every clean interval, and give back half the rate
   * the moment the far end objects. The result oscillates gently around
   * whatever the connection actually tolerates, which is a number no
   * configuration file could have told us.
   */
  private adaptiveRate(now: number): number {
    const { adaptive } = this.config.ipCap;
    let rate = this.state.adaptivePerMin ?? adaptive.startPerMin;

    // First call: start the clock here. Treating an absent timestamp as epoch 0
    // makes the very first reading look like fifty-six years of clean running,
    // and the controller jumps straight to maxPerMin without having sent a
    // single request.
    if (this.state.lastIncreaseAt === null) {
      this.state.adaptivePerMin = rate;
      this.state.lastIncreaseAt = now;
      this.persist();
      return Math.min(Math.max(rate, adaptive.minPerMin), adaptive.maxPerMin);
    }

    // The climb has to be EARNED by traffic that actually went out.
    //
    // "Quiet" below means nothing objected — but during a global backoff nothing
    // objects because nothing is sent, so the controller used to recover the
    // whole way to its ceiling while it was learning nothing. On 3 Sep 2026 it
    // climbed 8 → 16/min through a pause in which it made zero requests, and
    // would have resumed at full rate into the same wall that caused the pause.
    // Freezing the clock rather than just skipping the step also means the
    // paused span cannot be cashed in as accrued credit the moment it lifts.
    const lastRequestAt = this.state.lastRequestAt ?? null;
    const sentSinceIncrease = lastRequestAt !== null && lastRequestAt >= this.state.lastIncreaseAt;
    if (this.pausedNow(now) !== null || !sentSinceIncrease) {
      this.state.lastIncreaseAt = now;
      this.persist();
      return Math.min(Math.max(rate, adaptive.minPerMin), adaptive.maxPerMin);
    }

    // Additive increase, but only while nothing has objected recently. A block
    // inside the last increase interval means we are already at the edge.
    const sinceIncrease = now - this.state.lastIncreaseAt;
    const quiet =
      this.state.lastBlockAt === null ||
      now - this.state.lastBlockAt > adaptive.increaseEverySec * 1000;
    if (quiet && sinceIncrease >= adaptive.increaseEverySec * 1000) {
      const steps = Math.floor(sinceIncrease / (adaptive.increaseEverySec * 1000));
      rate = Math.min(rate + steps, adaptive.maxPerMin);
      this.state.adaptivePerMin = rate;
      this.state.lastIncreaseAt = now;
      this.persist();
    }
    return Math.min(Math.max(rate, adaptive.minPerMin), adaptive.maxPerMin);
  }

  /**
   * May one request go out right now? A hard limit: the caller waits, it does
   * not proceed anyway. Requests are counted over a rolling 60 s window, so a
   * cap of 6/min genuinely means no seventh request in any sixty seconds.
   */
  canRequest(now: number = Date.now()): GovernorDecision {
    if (this.killSwitchEngaged()) {
      return { allowed: false, reason: 'kill_switch', retryAfterMs: 5_000 };
    }
    this.reload();
    const pausedUntil = this.pausedNow(now);
    if (pausedUntil !== null) {
      return {
        allowed: false,
        reason: 'backoff',
        retryAfterMs: Math.max(1_000, pausedUntil - now),
      };
    }
    this.prune(now);
    const cap = this.capPerMin(now);
    const inWindow = this.state.requests.filter((t) => now - t < 60_000);
    if (inWindow.length >= cap) {
      const oldest = Math.min(...inWindow);
      return {
        allowed: false,
        reason: 'cap',
        retryAfterMs: Math.max(1_000, 60_000 - (now - oldest)),
      };
    }
    return { allowed: true, reason: null, retryAfterMs: 0 };
  }

  /** Count one request against the cap. Noise fetches count too — they are traffic. */
  recordRequest(now: number = Date.now()): void {
    this.reload();
    this.state.requests.push(now);
    this.state.lastRequestAt = now;
    const bucketStart = Math.floor(now / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
    const last = this.state.usageBuckets[this.state.usageBuckets.length - 1];
    if (last && last[0] === bucketStart) last[1] += 1;
    else this.state.usageBuckets.push([bucketStart, 1]);
    this.prune(now);
    this.persist();
  }

  // ── blocks and backoff ────────────────────────────────────────────────────

  /**
   * Record one hard block at the IP level and escalate if the rate crosses
   * either threshold. Returns the pause end time when a global pause is tripped.
   */
  recordHardBlock(now: number = Date.now()): number | null {
    this.reload();
    // Prune BEFORE recording, so the decay check still sees the previous block's
    // timestamp. Stamping `lastBlockAt = now` first would make every block look
    // like it happened zero milliseconds after the last one, and the escalation
    // would never decay no matter how quiet the months in between were.
    this.prune(now);
    this.state.blocks.push(now);
    this.state.lastBlockAt = now;

    // Multiplicative decrease — but on the block RATIO, not on each individual
    // block. Cutting on every block sounds cautious and is actually the opposite
    // of useful: with any background failure rate at all, the rate ratchets down
    // (a cut is a large multiplicative step; a recovery is one additive step per
    // interval) and the controller settles far below what the connection would
    // have carried. Measured against a simulated 60/min ceiling, per-block
    // cutting parked the rate around 15/min.
    if (this.config.ipCap.mode === 'adaptive') {
      const { adaptive } = this.config.ipCap;
      const ratio = this.recentBlockRatio(now);
      if (ratio > adaptive.tolerateBlockRatio) {
        const before = this.state.adaptivePerMin ?? adaptive.startPerMin;
        const after = Math.max(adaptive.minPerMin, before * adaptive.decreaseFactor);
        this.state.adaptivePerMin = after;
        this.state.lastIncreaseAt = now; // restart the climb from here
        console.warn(
          `[identity] rate ${before.toFixed(1)}/min → ${after.toFixed(1)}/min ` +
            `(${(ratio * 100).toFixed(1)}% of recent requests blocked)`,
        );
      }
    }

    const burst = this.state.blocks.filter((t) => now - t < BLOCK_BURST.windowMs).length;
    const hourly = this.state.blocks.filter((t) => now - t < BLOCK_HOURLY.windowMs).length;
    if (burst < BLOCK_BURST.count && hourly < BLOCK_HOURLY.count) {
      this.persist();
      return null;
    }

    // In adaptive mode the rate cut above IS the response, and it has already
    // happened. Pausing everything on top of it would throw away the throughput
    // the controller just paid for — so the global pause is reserved for the
    // case where cutting the rate has stopped working: already at the floor and
    // still being blocked.
    if (this.config.ipCap.mode === 'adaptive') {
      const atFloor =
        (this.state.adaptivePerMin ?? 0) <= this.config.ipCap.adaptive.minPerMin + 0.001;
      if (!atFloor) {
        this.persist();
        return null;
      }
    }

    const level = Math.min(this.state.backoffLevel, BACKOFF_LADDER_MIN.length - 1);
    const minutes = BACKOFF_LADDER_MIN[level]!;
    this.state.backoffLevel = Math.min(this.state.backoffLevel + 1, BACKOFF_LADDER_MIN.length - 1);
    this.state.pausedUntil = now + minutes * 60_000;
    this.state.degradedUntil = now + DEGRADE_MS;
    // The pause has done its job; do not let the same blocks re-trip it.
    this.state.blocks = [];
    this.persist();

    const message =
      `IP-level block rate exceeded (${burst} in 15 min / ${hourly} in 1 h). ` +
      `Pausing all fetching for ${minutes} min, then running the daytime cap at ` +
      `${(this.config.ipCap.dayPerMin / 2).toFixed(1)}/min for 6 h. ` +
      `Anyone else on this connection may see CAPTCHAs until it settles.`;
    console.error(`[identity] ERROR ${message}`);
    this.onAlert({
      message,
      backoffLevel: this.state.backoffLevel,
      pausedUntilIso: new Date(this.state.pausedUntil).toISOString(),
    });
    return this.state.pausedUntil;
  }

  /**
   * The share of recent requests that came back blocked, over the burst window.
   * Approximate by design: the request count comes from the coarse usage buckets
   * rather than a second array of timestamps, because this number decides
   * whether to change the rate by 40% and does not need to be exact.
   */
  private recentBlockRatio(now: number, windowMs: number = BLOCK_BURST.windowMs): number {
    const blocks = this.state.blocks.filter((t) => now - t <= windowMs).length;
    const requests = this.state.usageBuckets
      .filter(([t]) => now - t <= windowMs + USAGE_BUCKET_MS)
      .reduce((sum, [, n]) => sum + n, 0);
    if (requests === 0) return blocks > 0 ? 1 : 0;
    return blocks / requests;
  }

  /**
   * A failure that is NOT an explicit block, classified by who is at fault.
   *
   * The distinction matters more than it looks. A timeout or a 5xx means the far
   * end did not serve us — that is congestion, and slowing down is the correct
   * response. A parse failure means we could not READ what they served, which
   * may be entirely our bug: a mobile-layout persona whose pages our parsers
   * did not understand once produced a third of all Amazon failures, and had
   * that fed the rate controller it would have throttled a perfectly healthy
   * connection down to nothing while the actual defect sat untouched.
   *
   * So: congestion throttles. Parse failures are counted and shouted about, and
   * never touch the rate.
   */
  recordSoftSignal(kind: 'congestion' | 'unreadable', now: number = Date.now()): void {
    this.reload();
    if (kind === 'unreadable') {
      this.state.unreadable = (this.state.unreadable ?? 0) + 1;
      this.persist();
      return;
    }
    this.state.congestion.push(now);
    this.prune(now);

    // Congestion is judged as a share of traffic, like blocks are — a couple of
    // timeouts in three hundred requests is a flaky minute, not a signal.
    if (this.config.ipCap.mode === 'adaptive') {
      const { adaptive } = this.config.ipCap;
      const ratio = this.recentCongestionRatio(now);
      if (ratio > CONGESTION_RATIO_THRESHOLD) {
        const before = this.state.adaptivePerMin ?? adaptive.startPerMin;
        const after = Math.max(adaptive.minPerMin, before * adaptive.decreaseFactor);
        if (after < before) {
          this.state.adaptivePerMin = after;
          this.state.lastIncreaseAt = now;
          console.warn(
            `[identity] rate ${before.toFixed(1)}/min → ${after.toFixed(1)}/min ` +
              `(${(ratio * 100).toFixed(1)}% of recent requests timed out or errored)`,
          );
        }
      }
    }
    this.persist();
  }

  /** Share of recent requests that failed at the transport layer. */
  private recentCongestionRatio(now: number, windowMs: number = BLOCK_BURST.windowMs): number {
    const bad = this.state.congestion.filter((t) => now - t <= windowMs).length;
    const requests = this.state.usageBuckets
      .filter(([t]) => now - t <= windowMs + USAGE_BUCKET_MS)
      .reduce((sum, [, n]) => sum + n, 0);
    if (requests === 0) return 0;
    return bad / requests;
  }

  /** Epoch ms the global pause ends, or null if not paused. */
  pausedNow(now: number = Date.now()): number | null {
    if (this.state.pausedUntil && this.state.pausedUntil > now) return this.state.pausedUntil;
    return null;
  }

  private prune(now: number): void {
    this.state.blocks = this.state.blocks.filter((t) => now - t < BLOCK_HOURLY.windowMs);
    this.state.requests = this.state.requests.filter((t) => now - t < 60_000);
    this.state.usageBuckets = this.state.usageBuckets.filter(([t]) => now - t < 3600_000);
    this.state.congestion = this.state.congestion.filter((t) => now - t < BLOCK_HOURLY.windowMs);
    // A long clean stretch forgets the escalation, so an incident in March does
    // not make an unrelated one in April start at 80 minutes.
    if (
      this.state.backoffLevel > 0 &&
      this.state.lastBlockAt !== null &&
      now - this.state.lastBlockAt > BACKOFF_DECAY_MS
    ) {
      this.state.backoffLevel = 0;
    }
    if (this.state.pausedUntil && this.state.pausedUntil <= now) this.state.pausedUntil = null;
    if (this.state.degradedUntil && this.state.degradedUntil <= now)
      this.state.degradedUntil = null;
  }

  private persist(): void {
    this.store.saveGovernor(this.state);
  }

  /** Test seam: replace the whole state. */
  loadState(state: Partial<GovernorState>): void {
    this.state = { ...emptyState(), ...state };
  }
}

/** Minutes-of-day in IST for an instant. */
export function istMinutes(epochMs: number): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(epochMs));
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return hour * 60 + minute;
}

function parseHhMm(value: string): number {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return 0;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Whether an instant falls in the night window (handles windows over midnight). */
export function isNightIst(epochMs: number, night: { startIST: string; endIST: string }): boolean {
  const now = istMinutes(epochMs);
  const start = parseHhMm(night.startIST);
  const end = parseHhMm(night.endIST);
  return start <= end ? now >= start && now < end : now >= start || now < end;
}
