/**
 * Phase 0 seed (WP-0.4): exactly one user account and its default settings row.
 * Idempotent — safe to run repeatedly.
 *
 * Credentials come from SEED_USER_EMAIL / SEED_USER_PASSWORD (dev defaults
 * below are for local development only; staging/production values are set
 * in that environment's env file and delivered out-of-band).
 */
import { PrismaClient } from '@prisma/client';
import argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const email = process.env.SEED_USER_EMAIL ?? 'admin@pricepulse.local';
  const password = process.env.SEED_USER_PASSWORD ?? 'change-me-in-real-environments';

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });

  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, passwordHash },
  });

  await prisma.settings.upsert({
    where: { userId: user.id },
    update: {},
    create: { userId: user.id },
  });

  await prisma.systemStatus.upsert({
    where: { id: 1 },
    update: {},
    create: { id: 1 },
  });

  console.log(`Seeded user ${email} with default settings.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
