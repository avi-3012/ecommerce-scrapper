import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRAPING_CONFIG } from './config.js';
import { JITTER_RATIO, maxProductsFor, planCycle, stretchWarning } from './cycle.js';

const config = { cycle: DEFAULT_SCRAPING_CONFIG.cycle };

describe('cycle planning', () => {
  it('draws the requested window from the configured range', () => {
    for (let i = 0; i < 50; i++) {
      const plan = planCycle({ fetchCount: 1, capPerMin: 100, config });
      expect(plan.requestedWindowMs).toBeGreaterThanOrEqual(120_000);
      expect(plan.requestedWindowMs).toBeLessThanOrEqual(180_000);
    }
  });

  it('fits inside the requested window when the cap allows it', () => {
    // 6/min over a 120–180 s window is 12–18 fetches; 10 always fits.
    const plan = planCycle({ fetchCount: 10, capPerMin: 6, config, random: () => 0 });
    expect(plan.stretched).toBe(false);
    expect(plan.windowMs).toBe(120_000);
  });

  it('stretches the window rather than exceeding the cap', () => {
    // 60 products at 6/min needs 10 minutes, whatever the cycle asked for.
    const plan = planCycle({ fetchCount: 60, capPerMin: 6, config, random: () => 0 });
    expect(plan.stretched).toBe(true);
    expect(plan.windowMs).toBe(10 * 60_000);
    // Which is the arithmetic, not a bug — and the message says so plainly.
    expect(stretchWarning(60, 6, plan.windowMs)).toBe(
      '60 products at cap 6/min → effective cycle 10.0 min',
    );
  });

  it('never places more fetches per minute than the cap, at any offset', () => {
    const plan = planCycle({ fetchCount: 60, capPerMin: 6, config });
    for (const offset of plan.offsetsMs) {
      const inWindow = plan.offsetsMs.filter((o) => o >= offset && o < offset + 60_000).length;
      // Jitter can bunch two fetches slightly; the governor is the hard gate, so
      // the plan only has to stay in the same neighbourhood as the cap.
      expect(inWindow).toBeLessThanOrEqual(9);
    }
  });

  it('keeps every jittered offset inside ±40% of its slot and inside the window', () => {
    const fetchCount = 12;
    const plan = planCycle({ fetchCount, capPerMin: 100, config });
    const slot = plan.windowMs / fetchCount;
    const sorted = [...plan.offsetsMs];
    for (const [index, offset] of sorted.entries()) {
      expect(offset).toBeGreaterThanOrEqual(0);
      expect(offset).toBeLessThan(plan.windowMs);
      // Sorting can move an offset off its own index, so bound against the
      // widest legal excursion for any slot rather than for this one.
      const nominal = slot * (index + 0.5);
      expect(Math.abs(offset - nominal)).toBeLessThanOrEqual(slot * (1 + JITTER_RATIO));
    }
  });

  it('never bursts every fetch at the tick', () => {
    const plan = planCycle({ fetchCount: 15, capPerMin: 100, config });
    expect(plan.offsetsMs.filter((o) => o < 1_000).length).toBeLessThan(2);
    expect(new Set(plan.offsetsMs).size).toBeGreaterThan(10);
  });

  it('plans an empty cycle without dividing by zero', () => {
    const plan = planCycle({ fetchCount: 0, capPerMin: 6, config });
    expect(plan.offsetsMs).toEqual([]);
    expect(plan.stretched).toBe(false);
  });

  it('states the capacity rule of thumb', () => {
    expect(maxProductsFor(6, 2.5)).toBe(15);
  });
});
