import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_SCRAPING_CONFIG,
  IdentityPool,
  IdentityStore,
  IpGovernor,
  classifyResponse,
  configWarnings,
  describeState,
  loadScrapingConfig,
  planCycle,
} from '@pricepulse/adapters';
import type { ScrapingConfig } from '@pricepulse/adapters';
import type { Marketplace } from '@pricepulse/shared';

/**
 * Offline dry run: the whole scheduling and backoff machine driven against
 * saved fixture pages, with a synthetic block rate — no network at all.
 *
 * The point is to watch the layer's behaviour under conditions we cannot
 * conjure on demand and would not want to. A 20% block rate would take days to
 * observe live and would flag the IP while we watched; here it runs in a second
 * and the only thing at risk is a temp directory.
 *
 *   pnpm --filter @pricepulse/worker dryrun [--products 40] [--cycles 6]
 *   pnpm --filter @pricepulse/worker dryrun --ceiling 60      # simulate a real ceiling
 *   pnpm --filter @pricepulse/worker dryrun --blockRate 0.2   # flat block rate instead
 *
 * By default the simulated marketplace has a hidden CEILING: below it almost
 * nothing is blocked, above it the block probability climbs steeply. That is
 * the shape of the real thing, and it is the only shape against which an
 * adaptive controller can be shown to converge — a flat block rate punishes
 * every rate equally, so there is nothing to converge on.
 */

const FIXTURES = fileURLToPath(new URL('../../../packages/adapters/fixtures/', import.meta.url));

interface FixturePage {
  marketplace: Marketplace;
  body: string;
  label: string;
}

function loadFixtures(): { good: FixturePage[]; blocked: FixturePage[] } {
  const read = (name: string): string => readFileSync(join(FIXTURES, name), 'utf8');
  return {
    good: [
      { marketplace: 'amazon_in', body: read('amazon/in-stock-basic.html'), label: 'amazon ok' },
      { marketplace: 'amazon_in', body: read('amazon/out-of-stock.html'), label: 'amazon oos' },
      {
        marketplace: 'flipkart',
        body: read('flipkart/jsonld-in-stock.html'),
        label: 'flipkart ok',
      },
      {
        marketplace: 'flipkart',
        body: read('flipkart/selectors-only.html'),
        label: 'flipkart ok2',
      },
    ],
    blocked: [
      { marketplace: 'amazon_in', body: read('amazon/robot-blocked.html'), label: 'amazon robot' },
      { marketplace: 'amazon_in', body: read('amazon/captcha.html'), label: 'amazon captcha' },
      { marketplace: 'flipkart', body: read('flipkart/blocked.html'), label: 'flipkart wall' },
    ],
  };
}

function arg(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * The chance a request is blocked at a given rate.
 *
 * Below the ceiling: a small background rate, because even a well-behaved
 * client occasionally trips something. Above it: rising sharply, so that
 * pushing twice the tolerated rate gets most requests refused. A flat rate
 * (`--blockRate`) is still available for testing the backoff ladder itself.
 */
function blockProbability(ratePerMin: number, ceiling: number, flat: number | null): number {
  if (flat !== null) return flat;
  const over = ratePerMin / ceiling;
  if (over <= 1) return 0.005;
  return Math.min(0.9, 0.005 + (over - 1) * 0.6);
}

async function main(): Promise<void> {
  const products = Math.round(arg('products', 40));
  const flatBlockRate = process.argv.includes('--blockRate') ? arg('blockRate', 0.2) : null;
  const ceiling = arg('ceiling', 60);
  const cycles = Math.round(arg('cycles', 6));

  const dir = mkdtempSync(join(tmpdir(), 'pricepulse-dryrun-'));
  // The REAL config, not the built-in defaults: the point of a dry run is to
  // see how the configuration you are about to deploy behaves, and a rehearsal
  // of settings nobody is going to use answers nothing.
  let config: ScrapingConfig;
  try {
    config = loadScrapingConfig();
  } catch (err) {
    console.error(`Scraping config invalid: ${err instanceof Error ? err.message : err}`);
    config = DEFAULT_SCRAPING_CONFIG;
  }
  const store = new IdentityStore(dir);
  const pool = new IdentityPool(config, store);
  const governor = new IpGovernor(config, store);
  pool.ensureSize();
  const fixtures = loadFixtures();

  for (const warning of configWarnings(config)) console.warn(`WARN  ${warning}`);
  console.log(
    `Dry run — ${products} products, ${cycles} cycles, ` +
      (flatBlockRate === null
        ? `simulated ceiling ${ceiling}/min.\n`
        : `flat ${(flatBlockRate * 100).toFixed(0)}% block rate.\n`) +
      `Config: ${pool.list().length} identities, ${config.identities.rotation} rotation, ` +
      `${config.ipCap.mode} budget, maxConcurrent ${config.maxConcurrent}. No network.\n`,
  );

  // A simulated clock: the run covers hours of scheduled time in milliseconds.
  let now = Date.UTC(2026, 7, 21, 4, 0, 0); // 09:30 IST
  const tally = { ok: 0, blocked: 0, capped: 0, paused: 0, noIdentity: 0 };

  for (let cycle = 1; cycle <= cycles; cycle++) {
    const capPerMin = governor.capPerMin(now);
    const plan = planCycle({ fetchCount: products, capPerMin, config: { cycle: config.cycle } });
    console.log(
      `cycle ${cycle}: rate ${capPerMin.toFixed(1)}/min, window ${(plan.windowMs / 60_000).toFixed(1)} min` +
        `${plan.stretched ? ' (stretched to fit the budget)' : ''}`,
    );

    for (const offset of plan.offsetsMs) {
      const at = now + offset;
      const decision = governor.canRequest(at);
      if (!decision.allowed) {
        if (decision.reason === 'cap') tally.capped++;
        else tally.paused++;
        continue;
      }
      const identity = pool.acquire({ site: 'amazon.in', now: at });
      if (!identity) {
        tally.noIdentity++;
        continue;
      }
      governor.recordRequest(at);

      // Serve a fixture: mostly real product pages, sometimes a real block page.
      // How often depends on how hard we are pushing, which is the whole point.
      const isBlock = Math.random() < blockProbability(capPerMin, ceiling, flatBlockRate);
      const page = isBlock
        ? fixtures.blocked[Math.floor(Math.random() * fixtures.blocked.length)]!
        : fixtures.good[Math.floor(Math.random() * fixtures.good.length)]!;
      const verdict = classifyResponse({
        marketplace: page.marketplace,
        status: 200,
        body: page.body,
      });

      if (verdict.classification === 'hard_block') {
        tally.blocked++;
        pool.noteBlock(identity, at);
        governor.recordHardBlock(at);
      } else {
        tally.ok++;
        pool.noteOk(identity, 'https://www.amazon.in/dp/X', at);
      }
      pool.release(identity);
    }
    now += plan.windowMs;
  }

  const snapshot = governor.snapshot(now);
  console.log('\n─── result ───');
  if (flatBlockRate === null) {
    console.log(`simulated ceiling ${ceiling}/min`);
    console.log(
      `settled rate     ${snapshot.capPerMin.toFixed(1)}/min ` +
        `(${((snapshot.capPerMin / ceiling) * 100).toFixed(0)}% of the ceiling)`,
    );
  }
  console.log(`ok               ${tally.ok}`);
  console.log(`hard blocks      ${tally.blocked}`);
  console.log(`refused by cap   ${tally.capped}`);
  console.log(`refused, backoff ${tally.paused}`);
  console.log(`no identity free ${tally.noIdentity}`);
  console.log(`backoff level    ${snapshot.backoffLevel}`);
  console.log(`rate now         ${snapshot.capPerMin.toFixed(1)}/min (${snapshot.mode})`);
  console.log(`identities left  ${pool.list().length}`);
  for (const identity of pool.list()) {
    console.log(
      `  ${identity.id.slice(0, 10)} ${identity.browser}/${identity.os} ` +
        `${String(describeState(identity, now)).padEnd(16)} ` +
        `req ${identity.stats.requests}, blocks ${identity.stats.blocks}`,
    );
  }
  console.log(`\nstore (inspect and delete): ${dir}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
