/**
 * Milestone 1 end-to-end smoke (run manually: pnpm --filter @pricepulse/worker exec tsx smoke.e2e.mts)
 * Exercises the real database path: register → successful check with a price
 * drop (target + threshold alerts) → offer change → 5 consecutive failures
 * (auto-pause + alert) → cleanup. No live marketplace calls.
 */
import { PrismaClient } from '@pricepulse/db';
import { CheckError, createDefaultRegistry, normalizeOffers } from '@pricepulse/adapters';
import { getUserWithSettings, recordCheck, registerProduct } from '@pricepulse/core';
import type { CheckOutcome } from '@pricepulse/core';
import type { ProductSnapshot } from '@pricepulse/shared';

const prisma = new PrismaClient();
const assert = (cond: unknown, label: string): void => {
  if (!cond) throw new Error(`SMOKE FAIL: ${label}`);
  console.log(`✓ ${label}`);
};

function snapshot(price: number, offers: string[] = [], stock = 'in_stock'): ProductSnapshot {
  return {
    marketplace: 'amazon_in',
    marketplaceProductId: 'B0SMOKE001',
    name: 'Smoke Test Phone (256 GB)',
    price,
    mrp: 50000,
    discountPct: 0,
    offers: normalizeOffers(offers),
    stockStatus: stock as ProductSnapshot['stockStatus'],
    imageUrl: null,
    provenance: { price: 'smoke' },
  };
}

const ok = (price: number, offers: string[] = [], stock = 'in_stock'): CheckOutcome => ({
  ok: true,
  snapshot: snapshot(price, offers, stock),
  tier: 'http',
  durationMs: 10,
});

const fail = (): CheckOutcome => ({
  ok: false,
  error: new CheckError('parse_failed', 'smoke-injected failure'),
  tier: 'http',
  durationMs: 10,
});

async function main(): Promise<void> {
  const { settings } = await getUserWithSettings(prisma);

  // Register with target price 45000 (current 48000)
  const product = await registerProduct(
    { prisma, registry: createDefaultRegistry() },
    {
      url: 'https://www.amazon.in/dp/B0SMOKE0001',
      canonicalUrl: 'https://www.amazon.in/dp/B0SMOKE0001',
      marketplace: 'amazon_in',
      marketplaceProductId: 'B0SMOKE001',
      snapshot: snapshot(48000),
      targetPrice: 45000,
    },
  );
  assert(
    product.currentPrice !== null && Number(product.currentPrice) === 48000,
    'registered with first history row',
  );
  assert(
    (await prisma.priceHistory.count({ where: { productId: product.id } })) === 1,
    'exactly one history row after registration',
  );

  // Price drop crossing target AND exceeding threshold
  let p = (await prisma.product.findUnique({ where: { id: product.id } }))!;
  const drop = await recordCheck(prisma, p, ok(44000), settings);
  const types = drop.events.map((e) => e.type).sort();
  assert(
    drop.success && types.includes('target_price') && types.includes('threshold_drop'),
    `drop fired target+threshold (${types.join(',')})`,
  );

  // Repeated check at same price — crossing latch must keep it silent
  p = (await prisma.product.findUnique({ where: { id: product.id } }))!;
  assert(p.targetCrossed, 'crossing latch persisted');
  const silent = await recordCheck(prisma, p, ok(44000), settings);
  assert(silent.events.length === 0, 'no repeat alert while latched (FR-3.1)');

  // Offer appears with no price movement (UC-5)
  p = (await prisma.product.findUnique({ where: { id: product.id } }))!;
  const offer = await recordCheck(prisma, p, ok(44000, ['Bank Offer: 10% off HDFC']), settings);
  assert(offer.events.map((e) => e.type).join() === 'offer_change', 'offer change alert fired');

  // Out of stock is a successful check and resets nothing (FR-2.7)
  p = (await prisma.product.findUnique({ where: { id: product.id } }))!;
  const oos = await recordCheck(
    prisma,
    p,
    ok(44000, ['Bank Offer: 10% off HDFC'], 'out_of_stock'),
    settings,
  );
  assert(oos.success, 'out-of-stock recorded as successful check');

  // 5 consecutive failures → auto-pause + alert (FR-2.6)
  let autoPaused = false;
  for (let i = 0; i < settings.consecutiveFailureLimit; i++) {
    p = (await prisma.product.findUnique({ where: { id: product.id } }))!;
    const result = await recordCheck(prisma, p, fail(), settings);
    autoPaused = result.autoPaused;
  }
  p = (await prisma.product.findUnique({ where: { id: product.id } }))!;
  assert(
    autoPaused && p.status === 'paused_auto',
    `auto-paused after ${settings.consecutiveFailureLimit} failures`,
  );
  const pauseAlert = await prisma.alert.findFirst({
    where: { productId: product.id, type: 'auto_paused' },
  });
  assert(pauseAlert !== null, 'auto_paused alert recorded (FR-3.6)');

  const history = await prisma.priceHistory.count({ where: { productId: product.id } });
  assert(
    history === 1 + 4 + settings.consecutiveFailureLimit,
    `every check produced exactly one history row (${history})`,
  );
  const failedRows = await prisma.priceHistory.count({
    where: { productId: product.id, success: false },
  });
  assert(
    failedRows === settings.consecutiveFailureLimit,
    'failures recorded with reasons (FR-2.3)',
  );

  // Cleanup: cascade delete
  await prisma.product.delete({ where: { id: product.id } });
  assert(
    (await prisma.priceHistory.count({ where: { productId: product.id } })) === 0,
    'delete cascades history (FR-1.6)',
  );
  console.log('\nSMOKE PASSED');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
