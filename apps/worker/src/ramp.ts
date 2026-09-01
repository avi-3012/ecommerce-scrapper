import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import {
  DEFAULT_SCRAPING_CONFIG,
  IdentityPool,
  IdentitySession,
  IdentityStore,
  IpGovernor,
  classifyResponse,
  createDefaultRegistry,
  defaultStoreDir,
  loadScrapingConfig,
} from '@pricepulse/adapters';
import type { ScrapingConfig } from '@pricepulse/adapters';
import { PrismaClient } from '@pricepulse/db';

/**
 * Find the request rate this connection actually tolerates.
 *
 * No configuration file knows this number. It is a property of the far end —
 * unpublished, and it moves — so the only honest way to get it is to walk the
 * rate up against real product pages until the first block, and report what
 * survived. That is what the adaptive controller does continuously; this does
 * it deliberately, in one sitting, so you have a number before you commit to a
 * catalogue size and a check interval.
 *
 *   pnpm --filter @pricepulse/worker ramp
 *   pnpm --filter @pricepulse/worker ramp --start 10 --step 10 --hold 120 --max 200
 *
 * It stops at the FIRST hard block and reports the last clean rate. Expect it
 * to take a while: each step has to run long enough to mean something.
 */

interface RampOptions {
  startPerMin: number;
  stepPerMin: number;
  holdSec: number;
  maxPerMin: number;
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main(): Promise<void> {
  const options: RampOptions = {
    startPerMin: arg('start', 10),
    stepPerMin: arg('step', 10),
    holdSec: arg('hold', 120),
    maxPerMin: arg('max', 200),
  };

  let config: ScrapingConfig;
  try {
    config = loadScrapingConfig();
  } catch {
    config = DEFAULT_SCRAPING_CONFIG;
  }

  const prisma = new PrismaClient();
  const store = new IdentityStore(defaultStoreDir());
  const pool = new IdentityPool(config, store);
  // The ramp sets the rate itself, so the governor must not also be gating.
  const governor = new IpGovernor(
    {
      ...config,
      ipCap: { ...config.ipCap, mode: 'fixed', dayPerMin: 10_000, nightPerMin: 10_000 },
    },
    store,
  );
  pool.ensureSize();
  const registry = createDefaultRegistry();

  try {
    const products = await prisma.product.findMany({
      where: { status: 'active' },
      select: { canonicalUrl: true, marketplace: true },
    });
    if (products.length === 0) throw new Error('No active products to ramp against.');

    console.log(
      `Ramping ${options.startPerMin} → ${options.maxPerMin}/min in steps of ${options.stepPerMin}, ` +
        `${options.holdSec}s per step, against ${products.length} real listings.\n` +
        `Stops at the first hard block. Ctrl-C is safe at any point.\n`,
    );
    console.log('  rate/min   sent    ok  suspect  blocked   notes');

    let cursor = 0;
    let lastCleanRate = 0;
    let blockedAt: number | null = null;

    for (
      let rate = options.startPerMin;
      rate <= options.maxPerMin && blockedAt === null;
      rate += options.stepPerMin
    ) {
      const gapMs = 60_000 / rate;
      const requests = Math.max(1, Math.round((rate * options.holdSec) / 60));
      let ok = 0;
      let suspect = 0;
      let blocked = 0;
      let skipped = 0;
      const stepStarted = Date.now();

      for (let n = 0; n < requests && blockedAt === null; n++) {
        const product = products[cursor++ % products.length]!;
        const identity = pool.acquire({
          site: product.marketplace === 'amazon_in' ? 'amazon.in' : 'flipkart.com',
        });
        if (!identity) {
          skipped++;
          await sleep(gapMs);
          continue;
        }
        const session = new IdentitySession(identity, pool, governor, product.marketplace);
        const adapter = registry.all().find((a) => a.marketplace === product.marketplace)!;

        // Fire and forget at the target spacing — the ramp is measuring the RATE
        // requests arrive at, which is not the same as how fast they complete.
        void (async () => {
          try {
            const page = await adapter.fetch(product.canonicalUrl, { session });
            const verdict = classifyResponse({
              marketplace: product.marketplace,
              status: 200,
              body: page.body,
            });
            if (verdict.classification === 'hard_block') {
              blocked++;
              blockedAt = rate;
            } else {
              adapter.parse(page);
              ok++;
            }
          } catch (err) {
            const reason = (err as { reason?: string }).reason;
            if (reason === 'fetch_blocked' || reason === 'captcha') {
              blocked++;
              blockedAt = rate;
            } else {
              suspect++;
            }
          } finally {
            pool.release(identity);
          }
        })();

        const drift = stepStarted + (n + 1) * gapMs - Date.now();
        if (drift > 0) await sleep(drift);
      }

      // Let the tail of the step finish before judging it.
      await sleep(15_000);
      const note =
        blockedAt !== null ? '← first hard block' : skipped ? `${skipped} no identity` : '';
      console.log(
        `  ${String(rate).padStart(8)} ${String(requests).padStart(6)} ` +
          `${String(ok).padStart(5)} ${String(suspect).padStart(8)} ${String(blocked).padStart(8)}   ${note}`,
      );
      if (blockedAt === null) lastCleanRate = rate;
    }

    pool.flush();
    console.log('\n─── result ───');
    if (blockedAt === null) {
      console.log(
        `No hard block up to ${options.maxPerMin}/min. Either this connection tolerates more than\n` +
          `the ramp asked for, or the marketplaces are being lenient today — re-run at a higher --max\n` +
          `to find the real edge.`,
      );
    } else {
      console.log(`Last clean rate:  ${lastCleanRate}/min`);
      console.log(`First blocked at: ${blockedAt}/min`);
    }
    const sustainable = blockedAt === null ? options.maxPerMin : lastCleanRate;
    console.log(
      `\nAt ${sustainable}/min sustained:\n` +
        `  1-minute checks   → about ${sustainable} products\n` +
        `  5-minute checks   → about ${sustainable * 5} products\n` +
        `  15-minute checks  → about ${sustainable * 15} products\n` +
        `\nSet ipCap.adaptive.maxPerMin near ${Math.floor(sustainable * 0.8)} (80% of the last clean rate)\n` +
        `and let the controller work below it. Running at exactly the number that just blocked you\n` +
        `is not a plan.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
