import { describe, expect, it } from 'vitest';
import { normalizeOffers, offersHash } from '@pricepulse/adapters';
import type { ProductSnapshot, StockStatus } from '@pricepulse/shared';
import { evaluateAlerts } from './engine.js';
import type { AlertToggles, PreviousState, ProductRules } from './engine.js';

function snap(price: number, overrides: Partial<ProductSnapshot> = {}): ProductSnapshot {
  return {
    marketplace: 'amazon_in',
    marketplaceProductId: 'B0TEST00001',
    name: 'Test Product',
    price,
    mrp: price,
    discountPct: 0,
    offers: [],
    stockStatus: 'in_stock',
    imageUrl: null,
    provenance: {},
    ...overrides,
  };
}

function prev(price: number | null, overrides: Partial<PreviousState> = {}): PreviousState {
  const offers = overrides.offers ?? [];
  return {
    price,
    offers,
    offersHash: offersHash(offers),
    stockStatus: (overrides.stockStatus ?? 'in_stock') as StockStatus,
    ...overrides,
  };
}

const allOn: AlertToggles = {
  globalDropThresholdPct: 5,
  alertTargetPrice: true,
  alertThresholdDrop: true,
  alertAnyChange: true,
  alertOfferAdded: true,
  alertOfferRemoved: true,
  alertBackInStock: true,
};

function rules(overrides: Partial<ProductRules> = {}): ProductRules {
  return { targetPrice: null, dropThresholdPct: null, targetCrossed: false, ...overrides };
}

const types = (r: { events: Array<{ type: string }> }) => r.events.map((e) => e.type);

describe('target price crossing semantics (FR-3.1)', () => {
  const target = rules({ targetPrice: 1000 });

  it('fires when price drops to the target from above', () => {
    const r = evaluateAlerts(prev(1100), snap(1000), target, allOn);
    expect(types(r)).toContain('target_price');
    expect(r.targetCrossed).toBe(true);
  });

  it('does NOT fire again while latched at/below target', () => {
    const r = evaluateAlerts(
      prev(1000),
      snap(950),
      rules({ targetPrice: 1000, targetCrossed: true }),
      allOn,
    );
    expect(types(r)).not.toContain('target_price');
    expect(r.targetCrossed).toBe(true);
  });

  it('re-arms when price rises above target, fires on the next crossing', () => {
    const risen = evaluateAlerts(
      prev(950),
      snap(1200),
      rules({ targetPrice: 1000, targetCrossed: true }),
      allOn,
    );
    expect(risen.targetCrossed).toBe(false);
    const reCrossed = evaluateAlerts(
      prev(1200),
      snap(999),
      rules({ targetPrice: 1000, targetCrossed: false }),
      allOn,
    );
    expect(types(reCrossed)).toContain('target_price');
  });

  it('fires on a first-ever check at/below target', () => {
    const r = evaluateAlerts(null, snap(900), target, allOn);
    expect(types(r)).toContain('target_price');
  });

  it('does not fire for an out-of-stock listing price artifact', () => {
    const r = evaluateAlerts(
      prev(1100),
      snap(0, { stockStatus: 'out_of_stock', price: 0 }),
      target,
      allOn,
    );
    expect(types(r)).not.toContain('target_price');
  });

  it('clears the latch when the target is removed', () => {
    const r = evaluateAlerts(
      prev(900),
      snap(900),
      rules({ targetPrice: null, targetCrossed: true }),
      allOn,
    );
    expect(r.targetCrossed).toBe(false);
  });

  it('respects the toggle but still maintains the latch', () => {
    const r = evaluateAlerts(prev(1100), snap(1000), target, { ...allOn, alertTargetPrice: false });
    expect(types(r)).not.toContain('target_price');
    expect(r.targetCrossed).toBe(true); // latch semantics unaffected by delivery toggles
  });
});

describe('threshold drop (FR-3.2)', () => {
  it('fires at exactly the threshold boundary', () => {
    const r = evaluateAlerts(prev(1000), snap(950), rules(), allOn); // exactly 5%
    expect(types(r)).toContain('threshold_drop');
    expect(r.events.find((e) => e.type === 'threshold_drop')?.changePct).toBe(-5);
  });

  it('does not fire below the threshold', () => {
    expect(types(evaluateAlerts(prev(1000), snap(951), rules(), allOn))).not.toContain(
      'threshold_drop',
    );
  });

  it('per-product override wins over the global default', () => {
    const r = evaluateAlerts(prev(1000), snap(980), rules({ dropThresholdPct: 2 }), allOn);
    expect(types(r)).toContain('threshold_drop');
  });

  it('per-product zero disables threshold alerts for the product', () => {
    const r = evaluateAlerts(prev(1000), snap(500), rules({ dropThresholdPct: 0 }), allOn);
    expect(types(r)).not.toContain('threshold_drop');
  });

  it('never fires on a first-ever check (no previous)', () => {
    expect(types(evaluateAlerts(null, snap(1), rules(), allOn))).not.toContain('threshold_drop');
  });
});

describe('any-change (FR-3.3)', () => {
  it('fires on a rise when enabled', () => {
    const r = evaluateAlerts(prev(1000), snap(1010), rules(), allOn);
    expect(types(r)).toEqual(['price_change']);
  });

  it('is suppressed when a more specific price alert fired for the same movement', () => {
    const r = evaluateAlerts(prev(1000), snap(900), rules({ targetPrice: 950 }), allOn);
    expect(types(r)).toContain('target_price');
    expect(types(r)).toContain('threshold_drop');
    expect(types(r)).not.toContain('price_change');
  });

  it('is silent when toggled off (default)', () => {
    const r = evaluateAlerts(prev(1000), snap(1010), rules(), { ...allOn, alertAnyChange: false });
    expect(r.events).toHaveLength(0);
  });

  it('is silent when price is unchanged even if MRP changed', () => {
    const r = evaluateAlerts(prev(1000), snap(1000, { mrp: 1500 }), rules(), allOn);
    expect(r.events).toHaveLength(0);
  });
});

describe('offer change (FR-3.4) — split into added / removed', () => {
  const bankOffer = normalizeOffers(['Bank Offer: 10% off HDFC Cards']);
  const otherOffer = normalizeOffers(['Coupon: Flat ₹500 off']);

  it('fires offer_added when an offer appears, carrying only the added offers', () => {
    const r = evaluateAlerts(prev(1000), snap(1000, { offers: bankOffer }), rules(), allOn);
    expect(types(r)).toEqual(['offer_added']);
    const payload = r.events[0]?.newValue as { added: unknown[]; removed?: unknown[] };
    expect(payload.added).toHaveLength(1);
    // The removed side is not part of an addition alert.
    expect(payload.removed).toBeUndefined();
  });

  it('fires offer_removed when an offer disappears, carrying only the removed offers', () => {
    const r = evaluateAlerts(prev(1000, { offers: bankOffer }), snap(1000), rules(), allOn);
    expect(types(r)).toEqual(['offer_removed']);
    const payload = r.events[0]?.newValue as { removed: unknown[]; added?: unknown[] };
    expect(payload.removed).toHaveLength(1);
    expect(payload.added).toBeUndefined();
  });

  it('fires BOTH when one offer is added and another removed in the same check', () => {
    const r = evaluateAlerts(
      prev(1000, { offers: bankOffer }),
      snap(1000, { offers: otherOffer }),
      rules(),
      allOn,
    );
    expect(types(r).sort()).toEqual(['offer_added', 'offer_removed']);
  });

  it('is silent when offers are unchanged (order-insensitive)', () => {
    const r = evaluateAlerts(
      prev(1000, { offers: bankOffer }),
      snap(1000, { offers: bankOffer }),
      rules(),
      allOn,
    );
    expect(r.events).toHaveLength(0);
  });

  it('respects each toggle independently', () => {
    // Added off, removed on: an addition-only change is silent.
    const addedOff = evaluateAlerts(prev(1000), snap(1000, { offers: bankOffer }), rules(), {
      ...allOn,
      alertOfferAdded: false,
    });
    expect(addedOff.events).toHaveLength(0);

    // Same change with removed off but added on still fires the addition.
    const removedOff = evaluateAlerts(prev(1000), snap(1000, { offers: bankOffer }), rules(), {
      ...allOn,
      alertOfferRemoved: false,
    });
    expect(types(removedOff)).toEqual(['offer_added']);

    // A both-sided change with added off yields only the removal.
    const both = evaluateAlerts(
      prev(1000, { offers: bankOffer }),
      snap(1000, { offers: otherOffer }),
      rules(),
      { ...allOn, alertOfferAdded: false },
    );
    expect(types(both)).toEqual(['offer_removed']);
  });
});

describe('back in stock (FR-3.5)', () => {
  it('fires on out_of_stock → in_stock', () => {
    const r = evaluateAlerts(
      prev(1000, { stockStatus: 'out_of_stock' }),
      snap(1000),
      rules(),
      allOn,
    );
    expect(types(r)).toContain('back_in_stock');
  });

  it.each([
    ['unknown → in_stock', 'unknown', 'in_stock'],
    ['in_stock → out_of_stock', 'in_stock', 'out_of_stock'],
    ['out_of_stock → unknown', 'out_of_stock', 'unknown'],
  ])('%s is silent', (_label, from, to) => {
    const r = evaluateAlerts(
      prev(1000, { stockStatus: from as StockStatus }),
      snap(1000, { stockStatus: to as StockStatus }),
      rules(),
      allOn,
    );
    expect(types(r)).not.toContain('back_in_stock');
  });

  it('first-ever check in stock is silent', () => {
    expect(types(evaluateAlerts(null, snap(1000), rules(), allOn))).toHaveLength(0);
  });
});

describe('null price (out of stock)', () => {
  it('fires no price-based alerts when the current price is null', () => {
    const oos = snap(0, { price: null, stockStatus: 'out_of_stock' });
    const r = evaluateAlerts(prev(1000), oos, rules({ targetPrice: 5000 }), allOn);
    expect(types(r)).not.toContain('target_price');
    expect(types(r)).not.toContain('threshold_drop');
    expect(types(r)).not.toContain('price_change');
  });

  it('still fires back_in_stock when a null-price OOS product returns in stock', () => {
    const r = evaluateAlerts(
      prev(null, { stockStatus: 'out_of_stock' }),
      snap(999),
      rules(),
      allOn,
    );
    expect(types(r)).toContain('back_in_stock');
  });

  it('does not fire a threshold drop against a null previous price', () => {
    const r = evaluateAlerts(
      prev(null, { stockStatus: 'out_of_stock' }),
      snap(500),
      rules(),
      allOn,
    );
    expect(types(r)).not.toContain('threshold_drop');
    expect(types(r)).not.toContain('price_change');
  });
});

describe('multi-condition checks and determinism', () => {
  it('one drop can fire target + threshold + offer-added as distinct events', () => {
    const offers = normalizeOffers(['Apply ₹500 coupon']);
    const r = evaluateAlerts(prev(1000), snap(900, { offers }), rules({ targetPrice: 950 }), allOn);
    expect(types(r).sort()).toEqual(['offer_added', 'target_price', 'threshold_drop']);
  });

  it('is deterministic: same inputs, same outputs', () => {
    const args = [prev(1000), snap(900), rules({ targetPrice: 950 }), allOn] as const;
    expect(evaluateAlerts(...args)).toEqual(evaluateAlerts(...args));
  });
});
