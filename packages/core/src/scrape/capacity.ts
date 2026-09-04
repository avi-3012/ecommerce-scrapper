import type { PrismaClient } from '@pricepulse/db';

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
 * The ordering is deliberately total — priority, then creation order, then id.
 * A partial order would let equal-priority products trade places between
 * cycles, so a product could sit at the boundary being checked every other
 * cycle, which is worse than either being in or being out.
 *
 * Only `active` products compete. A paused or auto-paused listing holds no
 * slot, so a dead product does not permanently deny one to a live one.
 */
export const CAPACITY_ORDER = [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] as const;

/**
 * The ids inside capacity, in priority order. Returns null when capacity is
 * disabled (0) — meaning "no restriction", which callers must distinguish from
 * an empty set, i.e. "nothing may be scraped".
 */
export async function inCapacityIds(
  prisma: PrismaClient,
  capacity: number,
): Promise<Set<string> | null> {
  if (capacity <= 0) return null;
  const rows = await prisma.product.findMany({
    where: { status: 'active' },
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
): Promise<{ capacity: number; active: number; scraped: number; waiting: number }> {
  const active = await prisma.product.count({ where: { status: 'active' } });
  const scraped = capacity > 0 ? Math.min(active, capacity) : active;
  return { capacity, active, scraped, waiting: active - scraped };
}
