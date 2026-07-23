import type { AlertType, Offer, ProductSnapshot, StockStatus } from '@pricepulse/shared';
import { diffOffers, offersHash } from '@pricepulse/adapters';

/**
 * The alert engine (WP-1.7): a pure function of previous state, new
 * snapshot, product rules, and global settings. No I/O, no clock, no
 * hidden state — which is how crossing semantics and every edge case
 * get exhaustively unit-tested.
 */

/** The product's state as of its last SUCCESSFUL check (null = never succeeded). */
export interface PreviousState {
  /** Last known price, or null if the last successful check had no price (out of stock). */
  price: number | null;
  offers: Offer[];
  offersHash: string;
  stockStatus: StockStatus;
}

export interface ProductRules {
  targetPrice: number | null;
  /** Per-product override; null = inherit global; 0 = disabled for this product. */
  dropThresholdPct: number | null;
  /** The FR-3.1 crossing latch as persisted on the product. */
  targetCrossed: boolean;
}

export interface AlertToggles {
  globalDropThresholdPct: number;
  alertTargetPrice: boolean;
  alertThresholdDrop: boolean;
  alertAnyChange: boolean;
  /** Offers that appeared since the last check. */
  alertOfferAdded: boolean;
  /** Offers that disappeared since the last check. */
  alertOfferRemoved: boolean;
  alertBackInStock: boolean;
}

export interface AlertEvent {
  type: AlertType;
  oldValue: unknown;
  newValue: unknown;
  changePct: number | null;
}

export interface EvaluationResult {
  events: AlertEvent[];
  /** New latch value to persist on the product. */
  targetCrossed: boolean;
}

export function evaluateAlerts(
  previous: PreviousState | null,
  snapshot: ProductSnapshot,
  rules: ProductRules,
  toggles: AlertToggles,
): EvaluationResult {
  const events: AlertEvent[] = [];
  const price = snapshot.price;
  let targetCrossed = rules.targetCrossed;

  // No trustworthy current price (out of stock / unknown) ⇒ no price-based
  // alerts this check. Offer-change and back-in-stock still evaluate below.
  // (Each price rule checks `price !== null` inline so the type narrows.)

  // ── Target price (FR-3.1) — crossing semantics with latch ──
  if (price !== null && rules.targetPrice !== null && snapshot.stockStatus !== 'out_of_stock') {
    const atOrBelow = price <= rules.targetPrice;
    if (atOrBelow && !rules.targetCrossed) {
      // Fires on the transition, including a first-ever check at/below target
      // (the user registered wanting to know).
      if (toggles.alertTargetPrice) {
        events.push({
          type: 'target_price',
          oldValue: { price: previous?.price ?? null, target: rules.targetPrice },
          newValue: { price, target: rules.targetPrice },
          changePct:
            previous && previous.price !== null ? signedChangePct(previous.price, price) : null,
        });
      }
      targetCrossed = true;
    } else if (!atOrBelow) {
      // Price back above target re-arms the alert.
      targetCrossed = false;
    }
  }
  if (rules.targetPrice === null) targetCrossed = false;

  let firedSpecificPriceAlert = events.length > 0;

  // ── Threshold drop (FR-3.2) — against the last successful check ──
  if (price !== null && previous && previous.price !== null && toggles.alertThresholdDrop) {
    const threshold = rules.dropThresholdPct ?? toggles.globalDropThresholdPct;
    if (threshold > 0 && previous.price > 0) {
      const dropPct = ((previous.price - price) / previous.price) * 100;
      if (dropPct >= threshold) {
        events.push({
          type: 'threshold_drop',
          oldValue: { price: previous.price },
          newValue: { price, thresholdPct: threshold },
          changePct: signedChangePct(previous.price, price),
        });
        firedSpecificPriceAlert = true;
      }
    }
  }

  // ── Any-change (FR-3.3) — suppressed when a more specific price alert fired ──
  if (
    price !== null &&
    previous &&
    previous.price !== null &&
    toggles.alertAnyChange &&
    price !== previous.price &&
    !firedSpecificPriceAlert
  ) {
    events.push({
      type: 'price_change',
      oldValue: { price: previous.price },
      newValue: { price },
      changePct: signedChangePct(previous.price, price),
    });
  }

  // ── Offer change (FR-3.4) — independent of price movement ──
  // Additions and removals are separate alerts with independent toggles, so a
  // check that both adds and removes an offer fires up to two alerts, each
  // carrying only its own side of the diff.
  if (
    previous &&
    (toggles.alertOfferAdded || toggles.alertOfferRemoved) &&
    previous.offersHash !== offersHash(snapshot.offers)
  ) {
    const { added, removed } = diffOffers(previous.offers, snapshot.offers);
    if (added.length > 0 && toggles.alertOfferAdded) {
      events.push({
        type: 'offer_added',
        oldValue: { offers: previous.offers },
        newValue: { offers: snapshot.offers, added, price },
        changePct: null,
      });
    }
    if (removed.length > 0 && toggles.alertOfferRemoved) {
      events.push({
        type: 'offer_removed',
        oldValue: { offers: previous.offers },
        newValue: { offers: snapshot.offers, removed, price },
        changePct: null,
      });
    }
  }

  // ── Back in stock (FR-3.5) — out_of_stock → in_stock only; unknown never participates ──
  if (
    previous &&
    toggles.alertBackInStock &&
    previous.stockStatus === 'out_of_stock' &&
    snapshot.stockStatus === 'in_stock'
  ) {
    events.push({
      type: 'back_in_stock',
      oldValue: { stockStatus: 'out_of_stock' },
      newValue: { stockStatus: 'in_stock', price },
      changePct: null,
    });
  }

  return { events, targetCrossed };
}

function signedChangePct(oldPrice: number, newPrice: number): number {
  if (oldPrice <= 0) return 0;
  return Math.round(((newPrice - oldPrice) / oldPrice) * 10000) / 100;
}
