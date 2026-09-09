import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import { NestFactory } from '@nestjs/core';
import {
  DEFAULT_SCRAPING_CONFIG,
  IdentityStore,
  IpGovernor,
  configWarnings,
  defaultStoreDir,
  loadScrapingConfig,
  planCycle,
} from '@pricepulse/adapters';
import { PrismaClient } from '@pricepulse/db';
import { WorkerModule } from './worker.module.js';
import { loadConfig } from './config.js';

/**
 * The worker is a NestJS standalone application context: no HTTP listener.
 * It shares domain modules with the API and talks to it only through the
 * database (architecture §2).
 */
/**
 * Refuse to start when the catalogue is far larger than the connection can
 * carry.
 *
 * The whole-IP cap makes cycle length a function of product count, so a big
 * catalogue silently becomes a slow one. That is arithmetic rather than a
 * fault — but discovering it weeks later from a stale-price chart is worse than
 * being told at boot, so a cycle more than 3× the requested one stops the
 * worker until someone decides what to do about it. `--force` proceeds anyway.
 */
async function checkCapacity(force: boolean): Promise<void> {
  let config;
  try {
    config = loadScrapingConfig();
  } catch (err) {
    console.error(`Scraping config invalid: ${err instanceof Error ? err.message : err}`);
    config = DEFAULT_SCRAPING_CONFIG;
  }
  for (const warning of configWarnings(config)) console.warn(`[identity] WARN ${warning}`);

  const prisma = new PrismaClient();
  try {
    // What will actually be SCRAPED, and what the whole connection will spend.
    //
    // Both inputs used to be wrong once capacity and multiple egress addresses
    // existed: the count was every active product rather than the top
    // `capacity` of them, and the rate came from a single governor rather than
    // the sum across addresses. On a 297-product catalogue with capacity 50 and
    // two addresses that reported "297 products at 3.0/min needs a 99.0 min
    // cycle" for work the scheduler correctly plans as 50 at 12/min over 4.2
    // minutes — a refusal-to-start threshold computed from numbers that
    // describe nothing the worker does.
    const active = await prisma.product.count({ where: { status: 'active' } });
    const capacity = config.limits.capacity;
    const productCount = capacity > 0 ? Math.min(active, capacity) : active;
    if (productCount === 0) return;
    const store = new IdentityStore(defaultStoreDir());
    const addresses = config.egress.length ? config.egress : [undefined];
    const capPerMin = addresses.reduce(
      (total, ip) => total + new IpGovernor(config, store, () => {}, ip).capPerMin(),
      0,
    );
    const plan = planCycle({
      fetchCount: productCount,
      capPerMin,
      config: { cycle: config.cycle },
    });
    const effectiveMin = plan.windowMs / 60_000;
    const requestedMin = (config.cycle.minSec + config.cycle.maxSec) / 2 / 60;
    if (effectiveMin <= requestedMin * 3) return;

    const message =
      `${productCount} products at ${capPerMin.toFixed(1)}/min needs a ${effectiveMin.toFixed(1)} min cycle, ` +
      `more than 3× the ${requestedMin.toFixed(1)} min requested. ` +
      `Shrink the catalogue, raise the IP budget, lengthen cycle.minSec/maxSec, or pass --force.`;
    // Deliberately opt-out-able. The refusal is right for an unattended
    // deployment nobody is watching; it is in the way when someone is
    // deliberately running the connection as hard as it will go and already
    // knows the cycle is long.
    if (force || !config.limits.refuseWhenStretched) {
      console.warn(`[identity] WARN ${message}`);
      return;
    }
    throw new Error(
      `Refusing to start: ${message}\nSet limits.refuseWhenStretched=false in the scraping config to stop asking.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

async function bootstrap(): Promise<void> {
  loadConfig(); // fail fast before Nest starts
  await checkCapacity(process.argv.includes('--force'));

  const app = await NestFactory.createApplicationContext(WorkerModule);
  app.enableShutdownHooks();
  console.log('PricePulse worker running (heartbeat active)');

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down`);
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
