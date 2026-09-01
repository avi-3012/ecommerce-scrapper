import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIERS,
  computeNextCheck,
  idleMultiplier,
  requestsPerMinute,
  stillnessMs,
  tierFor,
} from './record.js';

const HOUR = 3600_000;

describe('idle backoff — the lever that makes a large catalogue affordable', () => {
  it('does not slow down a product that has only just been added', () => {
    // No recorded change yet is NOT the same as "never changes".
    expect(idleMultiplier(null)).toBe(1);
    expect(stillnessMs({ lastChangedAt: null }, new Date())).toBeNull();
  });

  it('checks a recently-moving product at its full configured rate', () => {
    expect(tierFor(HOUR)).toBe('hot');
    expect(idleMultiplier(HOUR)).toBe(1);
  });

  it('demotes a product the longer its price sits still', () => {
    expect(tierFor(DEFAULT_TIERS.warmAfterHours * HOUR)).toBe('warm');
    expect(tierFor(DEFAULT_TIERS.coldAfterHours * HOUR)).toBe('cold');
    expect(idleMultiplier(DEFAULT_TIERS.warmAfterHours * HOUR)).toBe(DEFAULT_TIERS.warmMultiplier);
    expect(idleMultiplier(DEFAULT_TIERS.coldAfterHours * HOUR)).toBe(DEFAULT_TIERS.coldMultiplier);
  });

  it('never stretches without bound — a cold product is still checked', () => {
    expect(idleMultiplier(365 * 24 * HOUR)).toBe(DEFAULT_TIERS.coldMultiplier);
  });

  it('makes a 300-product catalogue fit a rate that one IP can serve', () => {
    // The whole argument in one assertion. 300 products at 1 minute is 300
    // req/min flat — roughly fifty times what Amazon grants its own affiliate
    // API. Tiered, where most of the catalogue is static at any moment, the
    // same 300 products cost a rate this connection has actually sustained.
    const flat = 300 / 1;
    const tiered = requestsPerMinute({ hot: 20, warm: 60, cold: 220 }, 1);
    expect(flat).toBe(300);
    expect(tiered).toBeLessThan(50);
    // And the hot products keep their 1-minute cadence — that is the point.
    expect(requestsPerMinute({ hot: 20, warm: 0, cold: 0 }, 1)).toBe(20);
  });

  it('applies the stretch to the scheduled time, jitter included', () => {
    const from = new Date('2026-08-30T00:00:00Z');
    const still = DEFAULT_TIERS.warmAfterHours * HOUR; // warm → ×4
    const gaps = Array.from(
      { length: 40 },
      () => computeNextCheck(10, from, still).getTime() - from.getTime(),
    );
    // 10 min × 4 = 40 min, ±10% jitter.
    const expected = 10 * DEFAULT_TIERS.warmMultiplier * 60_000;
    for (const g of gaps) {
      expect(g).toBeGreaterThanOrEqual(expected * 0.9);
      expect(g).toBeLessThanOrEqual(expected * 1.1);
    }
    // Jitter is load-bearing: without it a whole import fires in one burst.
    expect(new Set(gaps).size).toBeGreaterThan(30);
  });
});
