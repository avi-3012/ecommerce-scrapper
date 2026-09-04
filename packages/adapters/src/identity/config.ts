import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CapMode, ConnectionType, RotationMode, ScrapingConfig } from './types.js';

/**
 * Scraping config: pool size and shape, cycle window, and the whole-IP request
 * budget.
 *
 * These are properties of the CONNECTION, not of a user's account, so they live
 * next to the code rather than in the settings table — the repo's config
 * taxonomy puts environment-level knobs outside the database. A JSON file so it
 * can be edited without a redeploy, with every key optional and defaulted.
 *
 *   config/scraping.json   (override with SCRAPING_CONFIG=/path/to/file.json)
 *
 * The clamps below are sanity bounds, not policy. They exist to catch a typo
 * (`dayPerMin: 6000000`), not to enforce a view about how hard you should run
 * your own connection — that decision belongs to whoever owns the line.
 */

export const DEFAULT_SCRAPING_CONFIG: ScrapingConfig = {
  connection: { type: 'home' },
  identities: {
    count: 8,
    minGapMs: { min: 60_000, max: 150_000 },
    rotation: 'sticky',
  },
  cycle: { minSec: 120, maxSec: 180 },
  ipCap: {
    mode: 'fixed',
    dayPerMin: 6,
    nightPerMin: 2,
    adaptive: {
      startPerMin: 6,
      maxPerMin: 240,
      minPerMin: 2,
      increaseEverySec: 120,
      decreaseFactor: 0.5,
      tolerateBlockRatio: 0.02,
    },
  },
  night: { startIST: '00:00', endIST: '07:00' },
  noiseRatio: 0.1,
  funnelRatio: 0.1,
  maxConcurrent: 2,
  diurnal: { enabled: true },
  tiers: { warmAfterHours: 6, coldAfterHours: 72, warmMultiplier: 4, coldMultiplier: 15 },
  limits: { capacity: 0, maxProducts: 0, refuseWhenStretched: true },
};

/**
 * A home line hosting more than a dozen browsers is not a household — it is a
 * tell. Office lines with many real users can legitimately run 20–40, and a
 * CGNAT'd Indian residential line fronts many subscribers already, so this
 * stays a WARNING rather than a limit.
 */
export const HOME_IDENTITY_WARN_THRESHOLD = 12;

export function configPath(): string {
  return process.env.SCRAPING_CONFIG ?? join(process.cwd(), 'config', 'scraping.json');
}

export function loadScrapingConfig(path: string = configPath()): ScrapingConfig {
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw new Error(
        `Could not read scraping config ${path}: ${err instanceof Error ? err.message : err}`,
      );
    }
    // Absent is fine and is the common case — every key has a default.
  }
  return mergeConfig(raw);
}

export function mergeConfig(raw: unknown): ScrapingConfig {
  const input = (raw ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const d = DEFAULT_SCRAPING_CONFIG;
  const identities = input.identities ?? {};
  const ipCap = input.ipCap ?? {};
  const adaptiveIn = (ipCap.adaptive ?? {}) as Record<string, unknown>;
  const limits = input.limits ?? {};
  const tiers = input.tiers ?? {};
  const diurnal = input.diurnal ?? {};

  const gap = (identities.minGapMs ?? {}) as Record<string, unknown>;
  const minGapMin = int(gap.min, d.identities.minGapMs.min, 0, 3_600_000);
  const minGapMax = int(gap.max, d.identities.minGapMs.max, 0, 3_600_000);

  const config: ScrapingConfig = {
    connection: { type: connectionType(input.connection?.type) ?? d.connection.type },
    identities: {
      count: int(identities.count, d.identities.count, 1, 512),
      minGapMs: { min: Math.min(minGapMin, minGapMax), max: Math.max(minGapMin, minGapMax) },
      rotation: rotationMode(identities.rotation) ?? d.identities.rotation,
    },
    cycle: {
      minSec: int(input.cycle?.minSec, d.cycle.minSec, 5, 86_400),
      maxSec: int(input.cycle?.maxSec, d.cycle.maxSec, 5, 86_400),
    },
    ipCap: {
      mode: capMode(ipCap.mode) ?? d.ipCap.mode,
      dayPerMin: num(ipCap.dayPerMin, d.ipCap.dayPerMin, 0.1, 10_000),
      nightPerMin: num(ipCap.nightPerMin, d.ipCap.nightPerMin, 0.1, 10_000),
      adaptive: {
        startPerMin: num(adaptiveIn.startPerMin, d.ipCap.adaptive.startPerMin, 0.1, 10_000),
        maxPerMin: num(adaptiveIn.maxPerMin, d.ipCap.adaptive.maxPerMin, 0.1, 10_000),
        minPerMin: num(adaptiveIn.minPerMin, d.ipCap.adaptive.minPerMin, 0.1, 10_000),
        increaseEverySec: num(
          adaptiveIn.increaseEverySec,
          d.ipCap.adaptive.increaseEverySec,
          1,
          3_600,
        ),
        decreaseFactor: num(adaptiveIn.decreaseFactor, d.ipCap.adaptive.decreaseFactor, 0.05, 0.95),
        tolerateBlockRatio: num(
          adaptiveIn.tolerateBlockRatio,
          d.ipCap.adaptive.tolerateBlockRatio,
          0,
          0.5,
        ),
      },
    },
    night: {
      startIST: hhmm(input.night?.startIST, d.night.startIST),
      endIST: hhmm(input.night?.endIST, d.night.endIST),
    },
    noiseRatio: num(input.noiseRatio as unknown, d.noiseRatio, 0, 0.5),
    funnelRatio: num(input.funnelRatio as unknown, d.funnelRatio, 0, 1),
    maxConcurrent: int(input.maxConcurrent as unknown, d.maxConcurrent, 1, 256),
    diurnal: { enabled: bool(diurnal.enabled, d.diurnal.enabled) },
    tiers: {
      warmAfterHours: num(tiers.warmAfterHours, d.tiers.warmAfterHours, 0.1, 24 * 30),
      coldAfterHours: num(tiers.coldAfterHours, d.tiers.coldAfterHours, 0.1, 24 * 90),
      warmMultiplier: num(tiers.warmMultiplier, d.tiers.warmMultiplier, 1, 200),
      coldMultiplier: num(tiers.coldMultiplier, d.tiers.coldMultiplier, 1, 500),
    },
    limits: {
      capacity: int(limits.capacity, d.limits.capacity, 0, 100_000),
      maxProducts: int(limits.maxProducts, d.limits.maxProducts, 0, 100_000),
      refuseWhenStretched: bool(limits.refuseWhenStretched, d.limits.refuseWhenStretched),
    },
  };

  if (config.cycle.maxSec < config.cycle.minSec) {
    throw new Error(
      `scraping config: cycle.maxSec (${config.cycle.maxSec}) is below cycle.minSec (${config.cycle.minSec})`,
    );
  }
  if (config.ipCap.adaptive.maxPerMin < config.ipCap.adaptive.minPerMin) {
    throw new Error(
      `scraping config: ipCap.adaptive.maxPerMin (${config.ipCap.adaptive.maxPerMin}) is below minPerMin (${config.ipCap.adaptive.minPerMin})`,
    );
  }
  return config;
}

/**
 * Startup warnings. Advisory, never fatal — every one of these describes a
 * configuration that is legitimate for somebody, and the person who edited the
 * file is better placed than this function to know whether it is legitimate
 * for them.
 */
export function configWarnings(config: ScrapingConfig): string[] {
  const warnings: string[] = [];
  const { identities, ipCap, maxConcurrent } = config;

  if (config.connection.type === 'home' && identities.count > HOME_IDENTITY_WARN_THRESHOLD) {
    warnings.push(
      `connection.type=home with ${identities.count} identities — more devices than a household has. ` +
        `Legitimate on a CGNAT'd residential line (many subscribers already share one public IP), ` +
        `but it is not what a single home looks like.`,
    );
  }

  // The rate one identity has to sustain to carry the configured cap. Past a
  // few per minute, an "identity" is no longer modelling a person.
  const effectiveCap = ipCap.mode === 'adaptive' ? ipCap.adaptive.maxPerMin : ipCap.dayPerMin;
  const perIdentityPerMin = effectiveCap / Math.max(identities.count, 1);
  if (perIdentityPerMin > 4) {
    warnings.push(
      `${effectiveCap}/min across ${identities.count} identities is ${perIdentityPerMin.toFixed(1)} ` +
        `requests per identity per minute, sustained. No person browses at that rate — the personas are ` +
        `consistent, but their BEHAVIOUR is not. Raise identities.count to spread the load.`,
    );
  }

  // The pool's own ceiling, from the average gap (gaps are drawn uniformly from
  // the range). A pool below the budget is not an error — the budget is a
  // ceiling, and being identity-bound rather than cap-bound is a perfectly safe
  // place to sit. It is worth saying only when the two are badly mismatched,
  // because then the budget number is fiction and tuning it changes nothing.
  const avgGapMs = (identities.minGapMs.min + identities.minGapMs.max) / 2;
  const poolCapacity = avgGapMs > 0 ? (60_000 / avgGapMs) * identities.count : Infinity;
  if (poolCapacity < effectiveCap * 0.5) {
    warnings.push(
      `the pool, not the budget, is the ceiling: ${identities.count} identities at a ` +
        `${Math.round(avgGapMs / 1000)}s average gap top out near ${poolCapacity.toFixed(0)}/min, ` +
        `far below the ${effectiveCap}/min budget — so raising the budget will do nothing. ` +
        `To actually reach ${effectiveCap}/min you need about ` +
        `${Math.ceil((effectiveCap * avgGapMs) / 60_000)} identities at this gap, ` +
        `or a gap of about ${Math.floor((identities.count * 60_000) / effectiveCap / 1000)}s at this count.`,
    );
  }

  if (maxConcurrent > identities.count) {
    warnings.push(
      `maxConcurrent (${maxConcurrent}) exceeds identities.count (${identities.count}); ` +
        `one identity holds one request at a time, so the extra concurrency is unreachable.`,
    );
  }

  if (ipCap.mode === 'fixed' && ipCap.dayPerMin > 60) {
    warnings.push(
      `ipCap.mode=fixed at ${ipCap.dayPerMin}/min is a number somebody guessed. ` +
        `ipCap.mode=adaptive finds the rate this connection actually tolerates instead.`,
    );
  }

  if (config.funnelRatio > 0.35) {
    warnings.push(
      `funnelRatio=${config.funnelRatio} — each funnelled check costs an EXTRA request, so a high ` +
        `ratio spends budget to improve traffic shape. Above ~0.35 you are paying more in volume ` +
        `than you gain in plausibility, and volume is the thing that is metered.`,
    );
  }

  if (!config.diurnal.enabled) {
    warnings.push(
      `diurnal.enabled=false — the request rate will be flat around the clock. A constant rate ` +
        `from one address at 4 a.m. and 7 p.m. alike is the most machine-like property traffic ` +
        `can have, and no header or identity makes up for it.`,
    );
  }

  if (config.tiers.coldMultiplier <= 1 && config.tiers.warmMultiplier <= 1) {
    warnings.push(
      `tiers are disabled (all multipliers 1) — every product is polled at its full rate ` +
        `regardless of whether its price ever moves. On a large catalogue this is the difference ` +
        `between fitting the request budget and not.`,
    );
  }

  if (!config.limits.refuseWhenStretched) {
    warnings.push(
      `limits.refuseWhenStretched=false — the worker will start however far the catalogue ` +
        `stretches the cycle. Watch the effective cycle in the banner.`,
    );
  }

  return warnings;
}

function connectionType(value: unknown): ConnectionType | null {
  return value === 'home' || value === 'office' ? value : null;
}

function rotationMode(value: unknown): RotationMode | null {
  return value === 'sticky' || value === 'per-request' ? value : null;
}

function capMode(value: unknown): CapMode | null {
  return value === 'fixed' || value === 'adaptive' ? value : null;
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (value === undefined || value === null || value === '' || !Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.min(Math.max(parsed, min), max);
}

function int(value: unknown, fallback: number, min: number, max: number): number {
  return Math.round(num(value, fallback, min, max));
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function hhmm(value: unknown, fallback: string): string {
  return typeof value === 'string' && /^\d{1,2}:\d{2}$/.test(value) ? value : fallback;
}
