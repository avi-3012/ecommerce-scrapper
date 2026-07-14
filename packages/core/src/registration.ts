import type { PrismaClient, Product } from '@pricepulse/db';
import type { AdapterRegistry, FetchFn } from '@pricepulse/adapters';
import { resolveListingUrl } from '@pricepulse/adapters';
import type { Marketplace, ProductSnapshot } from '@pricepulse/shared';
import { performCheck } from './scrape/pipeline.js';
import { recordCheck } from './scrape/record.js';
import { getUserWithSettings } from './settings.js';

export type PreviewResult =
  | {
      kind: 'preview';
      snapshot: ProductSnapshot;
      url: string;
      canonicalUrl: string;
      marketplace: Marketplace;
      productId: string;
    }
  | { kind: 'duplicate'; existingId: string; displayName: string; status: string }
  | { kind: 'unsupported'; detectedSite: string | null }
  | { kind: 'not_a_listing'; marketplace: Marketplace }
  | { kind: 'fetch_failed'; reason: string; message: string };

export interface RegistrationDeps {
  prisma: PrismaClient;
  registry: AdapterRegistry;
  browserFetch?: FetchFn;
}

export interface RegisterParams {
  url: string;
  canonicalUrl: string;
  marketplace: Marketplace;
  marketplaceProductId: string;
  snapshot: ProductSnapshot;
  displayName?: string;
  targetPrice?: number | null;
  dropThresholdPct?: number | null;
  notes?: string;
  tags?: string[];
}

/**
 * The single registration path (WP-1.6) used identically by the API and the
 * Telegram bot (parity rule): recognise → duplicate-check → live fetch →
 * preview. Persists nothing.
 */
export async function previewUrl(deps: RegistrationDeps, input: string): Promise<PreviewResult> {
  const { prisma, registry } = deps;
  const trimmed = input.trim();
  let recognition = registry.recognize(trimmed);
  let effectiveUrl = trimmed;

  // Any share/affiliate short link (fkrt.co, amzn.in, amzn.to, pwap.in, …)
  // carries no product id — follow its redirects to the real marketplace URL.
  // resolveListingUrl stops at the listing URL without loading the marketplace
  // page, so it's fast, cheap on proxy bandwidth, and dodges the anti-bot; it
  // routes through SCRAPER_PROXY_URL when set.
  if (recognition.kind !== 'listing') {
    try {
      const final = await resolveListingUrl(
        trimmed,
        (u) => registry.recognize(u).kind === 'listing',
      );
      if (final && final !== trimmed) {
        effectiveUrl = final;
        recognition = registry.recognize(final);
      }
    } catch {
      // resolution failed (blocked/unreachable) — fall through to the messages below
    }
  }

  if (recognition.kind === 'unsupported') {
    return { kind: 'unsupported', detectedSite: recognition.detectedSite };
  }
  if (recognition.kind === 'not_a_listing') {
    return { kind: 'not_a_listing', marketplace: recognition.marketplace };
  }

  const { user } = await getUserWithSettings(prisma);
  const existing = await prisma.product.findUnique({
    where: { userId_canonicalUrl: { userId: user.id, canonicalUrl: recognition.canonicalUrl } },
  });
  if (existing) {
    return {
      kind: 'duplicate',
      existingId: existing.id,
      displayName: existing.displayName,
      status: existing.status,
    };
  }

  const adapter = registry.all().find((a) => a.marketplace === recognition.marketplace)!;
  const outcome = await performCheck(adapter, recognition.canonicalUrl, {
    browserFetch: deps.browserFetch,
  });
  if (!outcome.ok) {
    return { kind: 'fetch_failed', reason: outcome.error.reason, message: outcome.error.message };
  }

  return {
    kind: 'preview',
    snapshot: outcome.snapshot,
    url: effectiveUrl,
    canonicalUrl: recognition.canonicalUrl,
    marketplace: recognition.marketplace,
    productId: recognition.productId,
  };
}

/**
 * Persist a confirmed preview (FR-1.1/1.4): creates the product, writes the
 * preview snapshot as its first history row through the standard recordCheck
 * path (so first-check alert semantics apply), and schedules it immediately.
 */
export async function registerProduct(
  deps: RegistrationDeps,
  params: RegisterParams,
): Promise<Product> {
  const { prisma } = deps;
  const { user, settings } = await getUserWithSettings(prisma);

  const product = await prisma.product.create({
    data: {
      userId: user.id,
      marketplace: params.marketplace,
      url: params.url,
      canonicalUrl: params.canonicalUrl,
      marketplaceProductId: params.marketplaceProductId,
      displayName: params.displayName?.trim() || params.snapshot.name,
      tags: params.tags ?? [],
      notes: params.notes ?? '',
      targetPrice: params.targetPrice ?? null,
      dropThresholdPct: params.dropThresholdPct ?? null,
      status: 'active',
      nextCheckAt: new Date(),
    },
  });

  await recordCheck(
    prisma,
    product,
    { ok: true, snapshot: params.snapshot, tier: 'http', durationMs: 0 },
    settings,
  );

  return (await prisma.product.findUnique({ where: { id: product.id } }))!;
}

export async function pauseProduct(prisma: PrismaClient, id: string): Promise<Product> {
  return prisma.product.update({ where: { id }, data: { status: 'paused_user' } });
}

/** Resume from either user-pause or auto-pause: clean failure counter, immediate check. */
export async function resumeProduct(prisma: PrismaClient, id: string): Promise<Product> {
  return prisma.product.update({
    where: { id },
    data: { status: 'active', consecutiveFailures: 0, nextCheckAt: new Date() },
  });
}

/** What deletion destroys — shown in the FR-1.6 confirmation step. */
export async function deletionImpact(
  prisma: PrismaClient,
  id: string,
): Promise<{ historyCount: number; alertCount: number }> {
  const [historyCount, alertCount] = await Promise.all([
    prisma.priceHistory.count({ where: { productId: id } }),
    prisma.alert.count({ where: { productId: id } }),
  ]);
  return { historyCount, alertCount };
}

/** Hard delete; history and alerts cascade (FR-1.6). Confirmation is the caller's job. */
export async function deleteProduct(prisma: PrismaClient, id: string): Promise<void> {
  await prisma.product.delete({ where: { id } });
}
