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
): Promise<RecordedCheck> {
  const nextCheckAt = computeNextCheck(settings.checkIntervalMinutes, now);

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
  const { events, targetCrossed } = evaluateAlerts(
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
      alertOfferChange: settings.alertOfferChange,
      alertBackInStock: settings.alertBackInStock,
    },
  );

  const priceChanged = previous === null || previous.price !== snapshot.price;
  const currentOffers = JSON.parse(JSON.stringify(snapshot.offers)) as object;

  // Deal-quality context (FR-5.5): all-time low/high maintained incrementally.
  const existingLow = product.allTimeLow === null ? null : Number(product.allTimeLow);
  const existingHigh = product.allTimeHigh === null ? null : Number(product.allTimeHigh);
  const trackExtremes = snapshot.stockStatus !== 'out_of_stock' && snapshot.price > 0;
  const allTimeLow = trackExtremes
    ? existingLow === null
      ? snapshot.price
      : Math.min(existingLow, snapshot.price)
    : existingLow;
  const allTimeHigh = trackExtremes
    ? existingHigh === null
      ? snapshot.price
      : Math.max(existingHigh, snapshot.price)
    : existingHigh;

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
        offersHash: offersHash(snapshot.offers),
        stockStatus: snapshot.stockStatus,
        extractionTier: outcome.tier,
        durationMs: outcome.durationMs,
      },
    }),
    prisma.product.update({
      where: { id: product.id },
      data: {
        displayName: product.displayName || snapshot.name,
        imageUrl: product.imageUrl ?? snapshot.imageUrl,
        currentPrice: snapshot.price,
        currentMrp: snapshot.mrp,
        currentDiscountPct: snapshot.discountPct,
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
  if (!product.lastSuccessAt || product.currentPrice === null) return null;
  const offers = (product.currentOffers ?? []) as unknown as Offer[];
  return {
    price: Number(product.currentPrice),
    offers,
    offersHash: offersHash(offers),
    stockStatus: product.currentStockStatus,
  };
}

/** Next scheduled check: interval ± up to 10% jitter (FR-2.5 pacing). */
export function computeNextCheck(intervalMinutes: number, from: Date): Date {
  const jitterFactor = 0.9 + Math.random() * 0.2;
  return new Date(from.getTime() + intervalMinutes * 60_000 * jitterFactor);
}
