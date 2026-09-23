import type { Prisma, PrismaClient, Settings } from '@pricepulse/db';
import { MARKETPLACES } from '@pricepulse/shared';
import type { Marketplace } from '@pricepulse/shared';

/**
 * Which products the scraper is allowed to spend requests on.
 *
 * The catalogue and the request budget are different things. You can track any
 * number of products; what the connection can actually check per minute is
 * `products ÷ interval`, and that number is set by what the marketplace
 * tolerates, not by how many listings you find interesting. Capacity is where
 * those two meet: the top `capacity` products by `priority` are scraped, and
 * the rest are simply not checked until they move up.
 *
 * Priority reads HIGHER-WINS: a product at 2 is scraped before one at 1. The
 * ordering is deliberately total — priority, then creation order, then id.
 * A partial order would let equal-priority products trade places between
 * cycles, so a product could sit at the boundary being checked every other
 * cycle, which is worse than either being in or being out.
 *
 * Only `active` products compete. A paused or auto-paused listing holds no
 * slot, so a dead product does not permanently deny one to a live one.
 */
export const CAPACITY_ORDER = [{ priority: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;

/**
 * The capacity in force: the Settings value when set, otherwise the scraping
 * config's. One resolver so the scheduler, the product list and the status
 * report cannot disagree about how many products are being scraped — a
 * disagreement there shows up as products that look active and never update.
 */
export function resolveCapacity(
  settingsCapacity: number | null | undefined,
  configCapacity: number,
): number {
  return settingsCapacity ?? configCapacity;
}

/** The Settings fields the per-marketplace limits are read from. */
export type LimitSettings = Pick<
  Settings,
  | 'checkIntervalMinutes'
  | 'scrapeCapacity'
  | 'flipkartCheckIntervalMinutes'
  | 'flipkartScrapeCapacity'
>;

/**
 * The check interval, in minutes, that a marketplace's products default to. A
 * product's own `checkIntervalMinutes` still wins over this.
 *
 * Amazon's is the original setting with its original meaning. Flipkart's falls
 * back to it until set, so adding the field changed nothing for anyone.
 */
export function intervalFor(marketplace: Marketplace, settings: LimitSettings): number {
  if (marketplace === 'flipkart') {
    return settings.flipkartCheckIntervalMinutes ?? settings.checkIntervalMinutes;
  }
  return settings.checkIntervalMinutes;
}

/**
 * How many of a marketplace's active products are scraped; 0 means no limit.
 *
 * Amazon's rule is exactly the one it always had — the Settings value, else the
 * scraping config's `limits.capacity`. Flipkart's comes from Settings alone,
 * with blank meaning no limit. The API cannot read a second worker's config
 * file, and a limit that only one process can see is how the product list ends
 * up disagreeing with what is actually being scraped.
 */
export function capacityFor(
  marketplace: Marketplace,
  settings: LimitSettings,
  configCapacity: number,
): number {
  if (marketplace === 'flipkart') return settings.flipkartScrapeCapacity ?? 0;
  return resolveCapacity(settings.scrapeCapacity, configCapacity);
}

/**
 * The ids inside capacity, in priority order. Returns null when capacity is
 * disabled (0) — meaning "no restriction", which callers must distinguish from
 * an empty set, i.e. "nothing may be scraped".
 */
export async function inCapacityIds(
  prisma: PrismaClient,
  capacity: number,
  /** Cut within one marketplace only. Omitted = across all of them. */
  marketplace?: Marketplace,
): Promise<Set<string> | null> {
  if (capacity <= 0) return null;
  const rows = await prisma.product.findMany({
    where: { status: 'active', ...(marketplace ? { marketplace } : {}) },
    orderBy: [...CAPACITY_ORDER],
    take: capacity,
    select: { id: true },
  });
  return new Set(rows.map((r) => r.id));
}

/** How many active products there are, and how many of them fit in capacity. */
export async function capacityUsage(
  prisma: PrismaClient,
  capacity: number,
  /** Count within one marketplace only. Omitted = across all of them. */
  marketplace?: Marketplace,
): Promise<{ capacity: number; active: number; scraped: number; waiting: number }> {
  const active = await prisma.product.count({
    where: { status: 'active', ...(marketplace ? { marketplace } : {}) },
  });
  const scraped = capacity > 0 ? Math.min(active, capacity) : active;
  return { capacity, active, scraped, waiting: active - scraped };
}

/**
 * The products a worker scoped to `marketplaces` may check: each marketplace
 * cut to its OWN capacity, independently of the others.
 *
 * Independence is the point. Under one shared cut, adding 300 Flipkart
 * laptops would either push Amazon products out of capacity or sit behind them
 * — either way one marketplace's catalogue decides what the other gets. As a
 * Prisma filter so the scheduler can combine it with "due by" in one query.
 */
export async function scrapeScopeWhere(
  prisma: PrismaClient,
  marketplaces: readonly Marketplace[],
  settings: LimitSettings,
  configCapacity: number,
): Promise<Prisma.ProductWhereInput> {
  const branches = await Promise.all(
    marketplaces.map(async (marketplace): Promise<Prisma.ProductWhereInput> => {
      const capacity = capacityFor(marketplace, settings, configCapacity);
      const ids = await inCapacityIds(prisma, capacity, marketplace);
      return ids ? { marketplace, id: { in: [...ids] } } : { marketplace };
    }),
  );
  return { OR: branches };
}

/** Each marketplace's in-capacity ids (null = no limit), for marking rows. */
export async function capacityByMarketplace(
  prisma: PrismaClient,
  settings: LimitSettings,
  configCapacity: number,
): Promise<Record<Marketplace, Set<string> | null>> {
  const entries = await Promise.all(
    MARKETPLACES.map(
      async (marketplace) =>
        [
          marketplace,
          await inCapacityIds(
            prisma,
            capacityFor(marketplace, settings, configCapacity),
            marketplace,
          ),
        ] as const,
    ),
  );
  return Object.fromEntries(entries) as Record<Marketplace, Set<string> | null>;
}
