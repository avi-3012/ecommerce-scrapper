import type { PrismaClient, Product, Settings } from '@pricepulse/db';
import { offersHash } from '@pricepulse/adapters';
import type { Offer } from '@pricepulse/shared';
import type { CheckOutcome } from './pipeline.js';
import { evaluateAlerts } from '../alerts/engine.js';
import type { AlertEvent, PreviousState } from '../alerts/engine.js';

export interface RecordedCheck {
  success: boolean;
  events: AlertEvent[];
  autoPaused: boolean;
  /** Alert row ids created (pending delivery). */
  alertIds: string[];
}

/**
 * The guaranteed-history-write contract (FR-2.3, principle §1.2-2): every
 * outcome — success or categorised failure — produces exactly one
 * price_history row, updates the product's current state, evaluates alert
 * rules, persists alert records, and applies auto-pause (FR-2.6).
 *
 * Out-of-stock is a SUCCESSFUL check (FR-2.7): it resets the failure
 * counter and records stock status.
 */
export async function recordCheck(
  prisma: PrismaClient,
  product: Product,
  outcome: CheckOutcome,
  settings: Settings,
  now: Date = new Date(),
  /**
   * Polling tiers. A property of the CONNECTION's request budget rather than of
   * the user's preferences, so it arrives from the scraping config rather than
   * the settings table.
   */
  tiers: TierConfig = DEFAULT_TIERS,
): Promise<RecordedCheck> {
  // Per-product interval overrides the global default when set, and stretches
  // for products whose price has not moved in a long time.
  const nextCheckAt = computeNextCheck(
    product.checkIntervalMinutes ?? settings.checkIntervalMinutes,
    now,
    stillnessMs(product, now),
    tiers,
  );

  if (!outcome.ok) {
    const failures = product.consecutiveFailures + 1;
    const shouldAutoPause =
      failures >= settings.consecutiveFailureLimit && product.status === 'active';

    const [, , alert] = await prisma.$transaction([
      prisma.priceHistory.create({
        data: {
          productId: product.id,
          checkedAt: now,
          success: false,
          failureReason: outcome.error.reason,
          failureDetail: outcome.error.message.slice(0, 500),
          extractionTier: outcome.tier,
          durationMs: outcome.durationMs,
          stockStatus: 'unknown',
          identityId: outcome.debug?.identityId ?? null,
        },
      }),
      prisma.product.update({
        where: { id: product.id },
        data: {
          consecutiveFailures: failures,
          lastCheckedAt: now,
          nextCheckAt,
          ...(shouldAutoPause ? { status: 'paused_auto' as const } : {}),
        },
      }),
      ...(shouldAutoPause
        ? [
            prisma.alert.create({
              data: {
                productId: product.id,
                userId: product.userId,
                type: 'auto_paused',
                oldValue: { status: 'active' },
                newValue: {
                  status: 'paused_auto',
                  failureReason: outcome.error.reason,
                  consecutiveFailures: failures,
                },
                firedAt: now,
              },
            }),
          ]
        : []),
    ]);

    return {
      success: false,
      events: [],
      autoPaused: shouldAutoPause,
      alertIds: alert ? [alert.id] : [],
    };
  }

  const { snapshot } = outcome;
  const previous = previousStateOf(product);
  const { events: rawEvents, targetCrossed } = evaluateAlerts(
    previous,
    snapshot,
    {
      targetPrice: product.targetPrice === null ? null : Number(product.targetPrice),
      dropThresholdPct: product.dropThresholdPct === null ? null : Number(product.dropThresholdPct),
      targetCrossed: product.targetCrossed,
    },
    {
      globalDropThresholdPct: Number(settings.globalDropThresholdPct),
      alertTargetPrice: settings.alertTargetPrice,
      alertThresholdDrop: settings.alertThresholdDrop,
      alertAnyChange: settings.alertAnyChange,
      alertOfferAdded: settings.alertOfferAdded,
      alertOfferRemoved: settings.alertOfferRemoved,
      alertBackInStock: settings.alertBackInStock,
    },
  );

  // A "live" price is one we trust: present and in stock. Out-of-stock/unknown
  // checks carry null — we still record the check, but must NOT overwrite the
  // product's last known price with null (that would erase useful data and
  // break drop detection when it comes back in stock).
  // A successful check that returns ZERO offers when we previously had some is
  // almost always a transient extraction miss (especially Flipkart's
  // client-rendered offers) — not every offer genuinely ending at once. Treat it
  // as "offers not read this cycle": keep the last known offers and suppress the
  // spurious all-removed offer alert.
  // An out-of-stock listing is the same situation by another route: marketplaces
  // stop rendering promotions on an unbuyable item, so its offers are absent or
  // truncated rather than genuinely withdrawn. Freeze the last known offers
  // alongside the last known price until the item is buyable again.
  const outOfStock = snapshot.stockStatus === 'out_of_stock';
  const offersUnreliable =
    (snapshot.offers.length === 0 || outOfStock) && previous !== null && previous.offers.length > 0;
  const events = offersUnreliable
    ? rawEvents.filter((event) => event.type !== 'offer_added' && event.type !== 'offer_removed')
    : rawEvents;
  const effectiveOffers = offersUnreliable && previous ? previous.offers : snapshot.offers;

  const hasLivePrice = !outOfStock && snapshot.price !== null && snapshot.price > 0;
  const priceChanged = hasLivePrice && (previous === null || previous.price !== snapshot.price);
  const currentOffers = JSON.parse(JSON.stringify(effectiveOffers)) as object;

  // Deal-quality context (FR-5.5): all-time low/high maintained incrementally
  // from live prices only.
  const existingLow = product.allTimeLow === null ? null : Number(product.allTimeLow);
  const existingHigh = product.allTimeHigh === null ? null : Number(product.allTimeHigh);
  let allTimeLow = existingLow;
  let allTimeHigh = existingHigh;
  if (snapshot.price !== null && hasLivePrice) {
    const p = snapshot.price;
    allTimeLow = existingLow === null ? p : Math.min(existingLow, p);
    allTimeHigh = existingHigh === null ? p : Math.max(existingHigh, p);
  }

  const results = await prisma.$transaction([
    prisma.priceHistory.create({
      data: {
        productId: product.id,
        checkedAt: now,
        success: true,
        price: snapshot.price,
        mrp: snapshot.mrp,
        discountPct: snapshot.discountPct,
        offers: currentOffers,
        offersHash: offersHash(effectiveOffers),
        stockStatus: snapshot.stockStatus,
        extractionTier: outcome.tier,
        durationMs: outcome.durationMs,
        identityId: outcome.debug?.identityId ?? null,
      },
    }),
    prisma.product.update({
      where: { id: product.id },
      data: {
        // Display name always tracks the marketplace title (never user-provided);
        // fall back to the existing name only if this check returned no title.
        displayName: snapshot.name || product.displayName,
        imageUrl: snapshot.imageUrl ?? product.imageUrl,
        // Preserve the last known price/MRP/discount when this check has no
        // live price (out of stock); only the stock status changes.
        ...(hasLivePrice
          ? {
              currentPrice: snapshot.price,
              currentMrp: snapshot.mrp,
              currentDiscountPct: snapshot.discountPct,
            }
          : {}),
        currentOffers,
        currentStockStatus: snapshot.stockStatus,
        allTimeLow,
        allTimeHigh,
        targetCrossed,
        consecutiveFailures: 0,
        lastCheckedAt: now,
        lastSuccessAt: now,
        ...(priceChanged ? { lastChangedAt: now } : {}),
        nextCheckAt,
      },
    }),
    ...events.map((event) =>
      prisma.alert.create({
        data: {
          productId: product.id,
          userId: product.userId,
          type: event.type,
          oldValue: event.oldValue as object,
          newValue: event.newValue as object,
          changePct: event.changePct,
          firedAt: now,
        },
      }),
    ),
  ]);

  const alertIds = results.slice(2).map((row) => (row as { id: string }).id);
  return { success: true, events, autoPaused: false, alertIds };
}

/** The product's last-successful-check state, reconstructed from its snapshot columns. */
export function previousStateOf(product: Product): PreviousState | null {
  // "No previous" means never successfully checked. A product that has only
  // ever been out of stock still counts as previous (price null) so a later
  // back-in-stock transition is detected.
  if (!product.lastSuccessAt) return null;
  const offers = (product.currentOffers ?? []) as unknown as Offer[];
  return {
    price: product.currentPrice === null ? null : Number(product.currentPrice),
    offers,
    offersHash: offersHash(offers),
    stockStatus: product.currentStockStatus,
  };
}

/**
 * How far a product's interval may stretch when its price never moves, and how
 * long it must be still before stretching starts.
 */
export interface TierConfig {
  warmAfterHours: number;
  coldAfterHours: number;
  warmMultiplier: number;
  coldMultiplier: number;
}

/** Used when no scraping config is threaded in (tests, ad-hoc calls). */
export const DEFAULT_TIERS: TierConfig = {
  warmAfterHours: 6,
  coldAfterHours: 72,
  warmMultiplier: 4,
  coldMultiplier: 15,
};

export type Tier = 'hot' | 'warm' | 'cold';

/**
 * Which polling tier a product is in, from how long its price has sat still.
 *
 *   hot   — moved recently, or brand new. Full configured rate.
 *   warm  — still for hours. Checked several times less often.
 *   cold  — still for days. Checked rarely.
 *
 * This is the ONLY lever that makes a large catalogue fit a fixed request
 * budget. Requests per minute is `products ÷ interval`; nothing about identity,
 * headers or pacing changes that arithmetic. A catalogue of 300 is affordable
 * because most of it is cold at any moment, and the handful that is actually
 * moving keeps the fast cadence that made you want 1-minute checks in the
 * first place.
 */
export function tierFor(stillness: number | null, tiers: TierConfig = DEFAULT_TIERS): Tier {
  // Never demote a product that has no recorded change yet: that is a new
  // product, not a static one, and it has never had the chance to move.
  if (stillness === null) return 'hot';
  if (stillness >= tiers.coldAfterHours * 3600_000) return 'cold';
  if (stillness >= tiers.warmAfterHours * 3600_000) return 'warm';
  return 'hot';
}

/**
 * How long a product has gone without its price moving. Null when it has never
 * had a recorded change (a new product, which must not be backed off).
 */
export function stillnessMs(product: Pick<Product, 'lastChangedAt'>, now: Date): number | null {
  if (!product.lastChangedAt) return null;
  return Math.max(0, now.getTime() - product.lastChangedAt.getTime());
}

/**
 * The multiplier applied to a product's interval because its price is not
 * moving. 1 = check at the configured rate.
 *
 * This is the lever that makes a large catalogue affordable. Requests per minute
 * is `products ÷ interval`, and it is the only number the marketplaces judge —
 * so the way to watch 300 products is not to ask 300 times a minute, it is to
 * ask often about the handful that are actually moving and rarely about the rest.
 * A laptop whose price has not changed in a fortnight does not need checking
 * every sixty seconds, and checking it anyway spends budget that a volatile
 * product could have used.
 *
 * It also breaks up the metronome. A catalogue polled on one uniform interval
 * emits a perfectly periodic request pattern from a single address, which is
 * the most machine-like signal there is and one no header can disguise.
 */
export function idleMultiplier(
  stillness: number | null,
  tiers: TierConfig = DEFAULT_TIERS,
): number {
  switch (tierFor(stillness, tiers)) {
    case 'cold':
      return tiers.coldMultiplier;
    case 'warm':
      return tiers.warmMultiplier;
    default:
      return 1;
  }
}

/**
 * Next scheduled check: interval × idle-backoff, ± up to 10% jitter.
 *
 * The jitter is not decoration — without it every product registered in the same
 * import drifts into the same second and the catalogue fires in a burst.
 */
export function computeNextCheck(
  intervalMinutes: number,
  from: Date,
  stillness: number | null = null,
  tiers: TierConfig = DEFAULT_TIERS,
): Date {
  const jitterFactor = 0.9 + Math.random() * 0.2;
  const effective = intervalMinutes * idleMultiplier(stillness, tiers);
  return new Date(from.getTime() + effective * 60_000 * jitterFactor);
}

/**
 * Requests per minute a catalogue costs, given how many products are in each
 * tier. This is the number the marketplaces judge, and the only one that
 * decides whether a catalogue is servable.
 */
export function requestsPerMinute(
  counts: Record<Tier, number>,
  intervalMinutes: number,
  tiers: TierConfig = DEFAULT_TIERS,
): number {
  return (
    counts.hot / intervalMinutes +
    counts.warm / (intervalMinutes * tiers.warmMultiplier) +
    counts.cold / (intervalMinutes * tiers.coldMultiplier)
  );
}
