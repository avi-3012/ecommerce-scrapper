import type { ScrapingConfig } from './types.js';

/**
 * Cycle planning: how a set of due products is spread across one window.
 *
 * The old scheduler paced by a fixed 3–8 s gap between checks, which under
 * proxies was fine — the gap was per exit IP, and there were many. On one line
 * that same pattern is a metronome: N requests, evenly spaced, forever. So the
 * plan here is built the other way round. The whole-IP cap is the hard input,
 * the cycle length is the OUTPUT, and every fetch inside the window is jittered
 * so no two cycles look alike.
 *
 * Pure functions with an injected clock and RNG, so the arithmetic that decides
 * whether we are over the cap is testable without running a cycle.
 */

/** ±40% jitter around each fetch's nominal slot. */
export const JITTER_RATIO = 0.4;

export interface CyclePlanInput {
  /** How many fetches this cycle must place (products + noise). */
  fetchCount: number;
  /** The cap in force for this cycle, in requests per minute. */
  capPerMin: number;
  config: Pick<ScrapingConfig, 'cycle'>;
  random?: () => number;
}

export interface CyclePlan {
  /** The window actually used, in ms — stretched past the request if capped. */
  windowMs: number;
  /** The window that was asked for before any stretch, in ms. */
  requestedWindowMs: number;
  /** True when the cap forced the window longer than requested. */
  stretched: boolean;
  /** Offsets from the cycle start, in ms, one per fetch, already jittered. */
  offsetsMs: number[];
}

/**
 * Plan one cycle.
 *
 * If `fetchCount / W` would exceed the cap, W is stretched to
 * `fetchCount / cap` — the scheduler stretches, it never spills over the cap.
 * This is the arithmetic behind the capacity rule of thumb:
 *
 *     maxProducts ≈ dayPerMin × cycleMinutes      (6 × 2.5 ≈ 15)
 */
export function planCycle(input: CyclePlanInput): CyclePlan {
  const random = input.random ?? Math.random;
  const { minSec, maxSec } = input.config.cycle;
  const requestedWindowMs = Math.round((minSec + random() * (maxSec - minSec)) * 1_000);
  if (input.fetchCount <= 0) {
    return { windowMs: requestedWindowMs, requestedWindowMs, stretched: false, offsetsMs: [] };
  }

  const cappedWindowMs = Math.ceil((input.fetchCount / input.capPerMin) * 60_000);
  const stretched = cappedWindowMs > requestedWindowMs;
  const windowMs = Math.max(requestedWindowMs, cappedWindowMs);

  // Nominal slots, then jitter each within ±40% of one slot. Bounded to the
  // window so a jittered fetch can never be scheduled past the cycle's end —
  // and never all at the tick, which is the shape a scraper has and a person
  // does not.
  const slot = windowMs / input.fetchCount;
  const offsetsMs = Array.from({ length: input.fetchCount }, (_, index) => {
    const nominal = slot * (index + 0.5);
    const jitter = (random() * 2 - 1) * JITTER_RATIO * slot;
    return Math.max(0, Math.min(windowMs - 1, Math.round(nominal + jitter)));
  }).sort((a, b) => a - b);

  return { windowMs, requestedWindowMs, stretched, offsetsMs };
}

/**
 * The warning text for a stretched cycle. Emitted once per CHANGE, not once per
 * cycle — a stretched cycle is a standing fact about the catalogue size, and
 * repeating it every two minutes would train everyone to ignore it.
 */
export function stretchWarning(fetchCount: number, capPerMin: number, windowMs: number): string {
  return (
    `${fetchCount} products at cap ${capPerMin}/min → effective cycle ` +
    `${(windowMs / 60_000).toFixed(1)} min`
  );
}

/** The capacity rule of thumb, for the startup banner. */
export function maxProductsFor(capPerMin: number, cycleMinutes: number): number {
  return Math.floor(capPerMin * cycleMinutes);
}
