import type { PrismaClient, Settings, User } from '@pricepulse/db';

/**
 * Settings are read from the database each time they are needed so that
 * changes take effect live (FR-6.2) — no restart, no cache invalidation
 * protocol. One row per user; exactly one user in Phase 1.
 */
export async function getUserWithSettings(
  prisma: PrismaClient,
): Promise<{ user: User; settings: Settings }> {
  const user = await prisma.user.findFirst({
    include: { settings: true },
    orderBy: { createdAt: 'asc' },
  });
  if (!user) throw new Error('No user account exists — run the seed');
  let settings = user.settings;
  if (!settings) {
    settings = await prisma.settings.create({ data: { userId: user.id } });
  }
  return { user, settings };
}
