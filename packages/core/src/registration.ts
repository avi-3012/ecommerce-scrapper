import type { PrismaClient, Product } from '@pricepulse/db';
import type { AdapterRegistry, FetchFn, IdentitySession } from '@pricepulse/adapters';
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
  | { kind: 'fetch_failed'; reason: string; message: string }
  /**
   * Every identity is busy, resting, or the IP is backing off. A preview is a
   * live fetch on a capped line, so "not right now" is a real answer — far
   * better than reaching for an anonymous request to get around it.
   */
  | { kind: 'no_capacity'; message: string }
  /** The catalogue is at its configured hard cap. */
  | { kind: 'at_capacity'; message: string; maxProducts: number; current: number };

export interface RegistrationDeps {
  prisma: PrismaClient;
  registry: AdapterRegistry;
  /**
   * Borrow an identity for one preview fetch, and hand it back afterwards.
   * Returns null when the pool has nothing free. Absent ⇒ no live fetching
   * (the bulk-import path, which only ever resolves short links).
   */
  acquireIdentity?: (
    marketplace: Marketplace,
  ) => { session: IdentitySession; browserFetch?: FetchFn } | null;
  releaseIdentity?: (session: IdentitySession) => void;
  /**
   * Hard cap on tracked products, from the scraping config. 0 or absent = no
   * cap. Checked before the live preview fetch, so hitting the cap costs no
   * marketplace request.
   */
  maxProducts?: number;
}

/** Thrown when a write would exceed the configured product cap. */
export class ProductLimitError extends Error {
  constructor(
    readonly maxProducts: number,
    readonly current: number,
  ) {
    super(
      `Product limit reached: tracking ${current} of a maximum ${maxProducts}. ` +
        `Requests per minute is products ÷ interval, so this cap is what keeps the catalogue ` +
        `inside what the connection can serve. Raise limits.maxProducts in the scraping config.`,
    );
    this.name = 'ProductLimitError';
  }
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
  categoryId?: string | null;
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
  // page, so it's fast, cheap on bandwidth, and never touches the marketplace —
  // which is why it needs no identity of its own.
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

  // Checked as early as possible: refusing at the cap should cost nothing —
  // not a marketplace request from an IP that is by definition already at its
  // limit, and not even a user lookup.
  if (deps.maxProducts && deps.maxProducts > 0) {
    const current = await prisma.product.count({ where: { status: { not: 'paused_user' } } });
    if (current >= deps.maxProducts) {
      return {
        kind: 'at_capacity',
        maxProducts: deps.maxProducts,
        current,
        message:
          `Tracking ${current} of a maximum ${deps.maxProducts} products. This cap exists because ` +
          `requests per minute is products ÷ interval — the connection can only serve so many. ` +
          `Remove a product, lengthen the check interval, or raise limits.maxProducts in the ` +
          `scraping config once you know the connection can carry it.`,
      };
    }
  }

  const { user, settings } = await getUserWithSettings(prisma);
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
  const borrowed = deps.acquireIdentity?.(recognition.marketplace) ?? null;
  if (!borrowed) {
    return {
      kind: 'no_capacity',
      message:
        'Every browser identity is busy or resting, or the connection is backing off. Try again in a minute.',
    };
  }

  let outcome;
  try {
    outcome = await performCheck(adapter, recognition.canonicalUrl, {
      session: borrowed.session,
      browserFetch: borrowed.browserFetch,
      pincode: settings.pincode,
      // A preview has no history to compare against, so the 40%-jump check has
      // nothing to say; the title/price checks still apply.
      lastAcceptedPrice: null,
    });
  } finally {
    deps.releaseIdentity?.(borrowed.session);
  }
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

  // Enforced here as well as at preview. Preview is where a person meets the
  // cap, but this is the function that actually writes a row — and it is
  // reachable directly by anyone posting to the endpoint, so the guard belongs
  // where the write happens rather than only where the UI happens to look.
  if (deps.maxProducts && deps.maxProducts > 0) {
    const current = await prisma.product.count({ where: { status: { not: 'paused_user' } } });
    if (current >= deps.maxProducts) {
      throw new ProductLimitError(deps.maxProducts, current);
    }
  }

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
      categoryId: params.categoryId ?? null,
      status: 'active',
      nextCheckAt: new Date(),
    },
  });

  await recordCheck(
    prisma,
    product,
    {
      ok: true,
      classification: 'ok',
      snapshot: params.snapshot,
      tier: 'http',
      durationMs: 0,
      debug: {},
    },
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

/**
 * Bulk-resume every paused product (auto- or user-paused) — the recovery path
 * after a systemic outage auto-pauses the whole catalogue. Clears failure
 * counters; the scheduler's cycle planner and the whole-IP cap spread the first
 * checks across as many windows as the cap requires, so this won't stampede.
 * Returns how many were resumed.
 */
export async function resumeAllProducts(prisma: PrismaClient): Promise<number> {
  const { count } = await prisma.product.updateMany({
    where: { status: { in: ['paused_auto', 'paused_user'] } },
    data: { status: 'active', consecutiveFailures: 0, nextCheckAt: new Date() },
  });
  return count;
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
