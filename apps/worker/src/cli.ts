import 'reflect-metadata';
import { config as loadDotenv } from 'dotenv';
import { fileURLToPath } from 'node:url';

loadDotenv({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

import {
  DEFAULT_SCRAPING_CONFIG,
  IdentityPool,
  IdentitySession,
  IdentityStore,
  IpGovernor,
  configWarnings,
  createBrowserTier,
  createDefaultRegistry,
  defaultStoreDir,
  describeState,
  loadScrapingConfig,
  maxProductsFor,
  planCycle,
} from '@pricepulse/adapters';
import type { ScrapingConfig } from '@pricepulse/adapters';
import { performCheck, requestsPerMinute, stillnessMs, tierFor } from '@pricepulse/core';
import { PrismaClient } from '@pricepulse/db';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Operator commands for the identity layer. Both read the SAME store the daemon
 * writes, so they work while it is running:
 *
 *   pnpm --filter @pricepulse/worker cli status
 *   pnpm --filter @pricepulse/worker cli once <url> [--force]
 *   pnpm --filter @pricepulse/worker cli banner [--force]
 */

async function main(): Promise<void> {
  const [, , command, ...rest] = process.argv;
  switch (command) {
    case 'status':
      await status();
      return;
    case 'once':
      await once(rest);
      return;
    case 'banner':
      await banner(rest.includes('--force'));
      return;
    case 'failures':
      failures(rest);
      return;
    case 'plan':
      await plan(rest);
      return;
    default:
      console.log(
        'Usage: cli <status | once <url> | banner [--force] | failures [--n 20] [--reason X] | ' +
          'plan [--products N] [--interval M]>',
      );
      process.exitCode = 1;
  }
}

function loadConfigOrDefault(): ScrapingConfig {
  try {
    return loadScrapingConfig();
  } catch (err) {
    console.error(`Scraping config invalid: ${err instanceof Error ? err.message : err}`);
    return DEFAULT_SCRAPING_CONFIG;
  }
}

/**
 * What the pool looks like right now — read from storage, so this is the
 * daemon's real state rather than a second opinion about it.
 */
async function status(): Promise<void> {
  const config = loadConfigOrDefault();
  const store = new IdentityStore(defaultStoreDir());
  const pool = new IdentityPool(config, store);
  const governor = new IpGovernor(config, store);
  const now = Date.now();
  const snapshot = governor.snapshot(now);

  console.log(`store            ${store.dir}`);
  console.log(`connection       ${config.connection.type}`);
  console.log(`rotation         ${config.identities.rotation}`);
  console.log(
    `rate             ${snapshot.capPerMin.toFixed(1)}/min (${snapshot.mode}, ` +
      `${snapshot.isNight ? 'night' : 'day'})` +
      `${snapshot.degradedUntil ? `, halved until ${new Date(snapshot.degradedUntil).toISOString()}` : ''}`,
  );
  if (snapshot.mode === 'adaptive') {
    const { adaptive } = config.ipCap;
    console.log(
      `                 learned ${(snapshot.adaptivePerMin ?? adaptive.startPerMin).toFixed(1)}/min ` +
        `within [${adaptive.minPerMin}, ${adaptive.maxPerMin}] ` +
        `(+1 per ${adaptive.increaseEverySec}s clean, ×${adaptive.decreaseFactor} per block)`,
    );
  }
  console.log(
    `usage            ${snapshot.usedLastMinute} in the last minute, ` +
      `${snapshot.usedLastHour} in the last hour`,
  );
  console.log(
    `backoff          level ${snapshot.backoffLevel}` +
      (snapshot.pausedUntil
        ? `, PAUSED until ${new Date(snapshot.pausedUntil).toISOString()}`
        : ', not paused'),
  );
  console.log(`blocks (1 h)     ${snapshot.blocks.length}`);
  if (governor.killSwitchEngaged()) console.log('kill switch      ENGAGED (PAUSE)');

  const identities = pool.list();
  console.log(`\nidentities       ${identities.length}`);
  console.log(
    ['  id', 'browser/os', 'state', 'req', 'blk', 'susp', 'last used'].join('  ').padEnd(10),
  );
  for (const identity of [...identities].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    console.log(
      [
        `  ${identity.id.slice(0, 10)}`,
        `${identity.browser}/${identity.os}`.padEnd(14),
        String(describeState(identity, now)).padEnd(16),
        String(identity.stats.requests).padStart(5),
        String(identity.stats.blocks).padStart(4),
        String(identity.stats.suspects).padStart(5),
        identity.stats.lastUsedAt ?? 'never',
      ].join(' '),
    );
  }
}

/**
 * One URL, one identity, printed classification + parsed result. The smallest
 * possible live test: it exercises the real session, the real pool, the real
 * cap and the real classifier, and touches the network exactly once.
 */
async function once(args: string[]): Promise<void> {
  const url = args.find((a) => !a.startsWith('--'));
  if (!url) {
    console.error('Usage: cli once <url> [--force]');
    process.exitCode = 1;
    return;
  }
  const config = loadConfigOrDefault();
  const store = new IdentityStore(defaultStoreDir());
  const pool = new IdentityPool(config, store);
  const governor = new IpGovernor(config, store);
  pool.ensureSize();

  const registry = createDefaultRegistry();
  const recognition = registry.recognize(url);
  if (recognition.kind !== 'listing') {
    console.error(`Not a recognised product listing (${recognition.kind}): ${url}`);
    process.exitCode = 1;
    return;
  }
  const adapter = registry.all().find((a) => a.marketplace === recognition.marketplace)!;

  const identity = pool.acquire({
    site: recognition.marketplace === 'amazon_in' ? 'amazon.in' : 'flipkart.com',
  });
  if (!identity) {
    console.error(
      'No identity is free right now (all busy, resting, or cooling). Try again shortly.',
    );
    process.exitCode = 1;
    return;
  }
  const session = new IdentitySession(identity, pool, governor, recognition.marketplace);
  const browserTier = await createBrowserTier();

  const prisma = new PrismaClient();
  try {
    const settings = await prisma.settings.findFirst();
    console.log(
      `identity   ${identity.id} (${identity.browser}/${identity.os}/${identity.device})`,
    );
    console.log(`user-agent ${identity.headers['user-agent']}`);
    console.log(`url        ${recognition.canonicalUrl}`);

    const outcome = await performCheck(adapter, recognition.canonicalUrl, {
      session,
      browserFetch: browserTier?.fetchFor(identity),
      pincode: settings?.pincode ?? null,
      lastAcceptedPrice: null,
    });

    console.log(`\nclassification  ${outcome.classification}`);
    console.log(`tier            ${outcome.tier}`);
    console.log(`duration        ${outcome.durationMs} ms`);
    if ('snapshot' in outcome) {
      const s = outcome.snapshot;
      console.log(`name            ${s.name}`);
      console.log(`price           ${s.price ?? '—'}  (mrp ${s.mrp ?? '—'})`);
      console.log(`stock           ${s.stockStatus}`);
      console.log(`offers          ${s.offers.length}`);
      console.log(`price source    ${s.provenance.price ?? '—'}`);
    }
    if (outcome.classification === 'suspect') {
      console.log(`suspect reason  ${outcome.suspectReason}: ${outcome.error.message}`);
    }
    if (!outcome.ok && outcome.classification !== 'suspect') {
      console.log(`failure         ${outcome.error.reason}: ${outcome.error.message}`);
    }
    console.log(`bytes (wire)    ${outcome.debug.proxy?.wireBytes ?? 0}`);
    process.exitCode = outcome.ok ? 0 : 1;
  } finally {
    pool.release(identity);
    pool.flush();
    await browserTier?.closeAll();
    await prisma.$disconnect();
  }
}

/**
 * Capacity planner: does a catalogue fit the rate this connection sustains?
 *
 * Answers the only question that matters when adding products, and answers it
 * from the real catalogue and the real learned rate rather than from a guess.
 * Requests per minute is `products ÷ interval` adjusted for how much of the
 * catalogue is actually moving, and it is the number the marketplaces judge.
 */
async function plan(args: string[]): Promise<void> {
  const config = loadConfigOrDefault();
  const store = new IdentityStore(defaultStoreDir());
  const governor = new IpGovernor(config, store);
  const hypothetical = Number(args[args.indexOf('--products') + 1]) || null;
  const interval = Number(args[args.indexOf('--interval') + 1]) || 1;

  const prisma = new PrismaClient();
  try {
    const products = await prisma.product.findMany({
      where: { status: 'active' },
      select: { lastChangedAt: true, checkIntervalMinutes: true },
    });
    const now = new Date();
    const counts = { hot: 0, warm: 0, cold: 0 };
    for (const p of products) counts[tierFor(stillnessMs(p, now), config.tiers)] += 1;

    // A hypothetical catalogue keeps the observed tier MIX — that is the only
    // defensible way to extrapolate, since it is the mix that decides the cost.
    const total = products.length || 1;
    const scaled = hypothetical
      ? {
          hot: Math.round((counts.hot / total) * hypothetical),
          warm: Math.round((counts.warm / total) * hypothetical),
          cold: Math.round((counts.cold / total) * hypothetical),
        }
      : counts;

    const flat = (hypothetical ?? products.length) / interval;
    const tiered = requestsPerMinute(scaled, interval, config.tiers);
    const sustained = governor.learnedPerMin();
    const spendable = governor.capPerMin();

    console.log(`catalogue        ${hypothetical ?? products.length} products @ ${interval} min`);
    console.log(
      `tier mix         ${scaled.hot} hot / ${scaled.warm} warm / ${scaled.cold} cold` +
        (hypothetical ? '   (extrapolated from the live mix)' : ''),
    );
    console.log(`cost, flat       ${flat.toFixed(1)} req/min  (no tiering)`);
    console.log(`cost, tiered     ${tiered.toFixed(1)} req/min`);
    console.log(`learned ceiling  ${sustained.toFixed(1)} req/min`);
    console.log(`spendable now    ${spendable.toFixed(1)} req/min  (after diurnal pacing)`);
    console.log('');
    if (tiered <= sustained) {
      console.log(`FITS — ${((tiered / sustained) * 100).toFixed(0)}% of the learned ceiling.`);
    } else {
      const needed = (hypothetical ?? products.length) / sustained;
      console.log(
        `DOES NOT FIT — ${tiered.toFixed(1)} req/min wanted against a ${sustained.toFixed(1)} ceiling.\n` +
          `Either raise the interval to about ${Math.ceil(needed)} min, or shrink the catalogue.\n` +
          `Raising ipCap will not help: the ceiling is what the marketplaces tolerate, not a setting.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * List captured failure bodies, newest first.
 *
 * Every failed check writes the full response it received to disk, gzipped.
 * This is the index over them, so "what did Amazon actually send when that
 * check failed at 3 a.m." is a question you can answer afterwards instead of
 * re-provoking the failure against an IP that is already unhappy.
 */
function failures(args: string[]): void {
  const limit = Number(args[args.indexOf('--n') + 1]) || 20;
  const reasonFilter = args.includes('--reason') ? args[args.indexOf('--reason') + 1] : null;
  const dir = defaultStoreDir();
  const indexPath = join(dir, 'failures', 'index.jsonl');

  let lines: string[];
  try {
    lines = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  } catch {
    console.log(`No failure captures yet (${indexPath} does not exist).`);
    return;
  }

  const entries = lines
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, string | number | null>;
      } catch {
        return null;
      }
    })
    .filter((e): e is Record<string, string | number | null> => e !== null)
    .filter((e) => !reasonFilter || String(e.reason).includes(reasonFilter))
    .reverse()
    .slice(0, limit);

  if (entries.length === 0) {
    console.log(reasonFilter ? `No captures matching "${reasonFilter}".` : 'No captures yet.');
    return;
  }

  console.log(`store ${dir}\n`);
  for (const e of entries) {
    const kb = Math.round(Number(e.bytesStored ?? 0) / 1024);
    console.log(
      `${String(e.at).slice(0, 19)}  ${String(e.marketplace).padEnd(9)} ` +
        `${String(e.reason).padEnd(26)} ${String(kb).padStart(5)} KB  ${e.path}`,
    );
    console.log(`    ${String(e.detail).slice(0, 110)}`);
    console.log(`    ${String(e.url).slice(0, 110)}`);
  }
  console.log(
    `\nRead one:  gunzip -c "${join(dir, String(entries[0]!.path))}" > /tmp/page.html && open /tmp/page.html`,
  );
}

/**
 * The startup banner, and the refusal that goes with it.
 *
 * If the catalogue is so large that the cap stretches the cycle past three
 * times what was asked for, that is worth stopping over — not because anything
 * is broken, but because someone should decide whether to shrink the catalogue,
 * raise the cap, or accept the longer cycle, rather than discover it later from
 * a chart.
 */
async function banner(force: boolean): Promise<void> {
  const config = loadConfigOrDefault();
  const store = new IdentityStore(defaultStoreDir());
  const pool = new IdentityPool(config, store);
  const governor = new IpGovernor(config, store);
  pool.ensureSize();

  const prisma = new PrismaClient();
  try {
    const productCount = await prisma.product.count({ where: { status: 'active' } });
    const capPerMin = governor.capPerMin();
    const plan = planCycle({
      fetchCount: productCount,
      capPerMin,
      config: { cycle: config.cycle },
    });
    const effectiveMin = plan.windowMs / 60_000;
    const requestedMin = (config.cycle.minSec + config.cycle.maxSec) / 2 / 60;

    for (const line of bannerLines(
      config,
      pool.list().length,
      productCount,
      effectiveMin,
      capPerMin,
    )) {
      console.log(line);
    }
    for (const warning of configWarnings(config)) console.warn(`WARN  ${warning}`);

    if (effectiveMin > requestedMin * 3 && !force) {
      console.error(
        `\nREFUSING TO START: ${productCount} products at ${capPerMin}/min needs a ` +
          `${effectiveMin.toFixed(1)} min cycle, more than 3× the ${requestedMin.toFixed(1)} min requested.\n` +
          `This is arithmetic, not a fault. Either shrink the catalogue, raise ipCap.dayPerMin ` +
          `(at the cost of looking busier from one IP), lengthen cycle.minSec/maxSec so the ` +
          `expectation matches reality, or pass --force to run anyway.`,
      );
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

function bannerLines(
  config: ScrapingConfig,
  identityCount: number,
  productCount: number,
  effectiveMin: number,
  capPerMin: number,
): string[] {
  const cycleMid = (config.cycle.minSec + config.cycle.maxSec) / 2 / 60;
  return [
    '─── PricePulse scraping ───────────────────────────────',
    `  connection      ${config.connection.type} (own ISP line, no proxies)`,
    `  identities      ${identityCount}`,
    `  identity mode   ${config.identities.rotation} rotation, ` +
      `${Math.round(config.identities.minGapMs.min / 1000)}–${Math.round(config.identities.minGapMs.max / 1000)}s per-identity gap`,
    config.ipCap.mode === 'adaptive'
      ? `  IP budget       adaptive within [${config.ipCap.adaptive.minPerMin}, ${config.ipCap.adaptive.maxPerMin}]/min; ` +
        `in force now: ${capPerMin.toFixed(1)}/min`
      : `  IP budget       fixed, ${config.ipCap.dayPerMin}/min day, ${config.ipCap.nightPerMin}/min night; ` +
        `in force now: ${capPerMin.toFixed(1)}/min`,
    `  concurrency     ${config.maxConcurrent} in flight, 1 per identity`,
    `  noise           ${Math.round(config.noiseRatio * 100)}% of fetches browse instead`,
    `  products        ${productCount}`,
    `  cycle           requested ${config.cycle.minSec}–${config.cycle.maxSec}s, ` +
      `effective ${effectiveMin.toFixed(1)} min`,
    `  capacity        maxProducts ≈ perMin × cycleMinutes = ` +
      `${capPerMin.toFixed(0)} × ${cycleMid.toFixed(1)} ≈ ${maxProductsFor(capPerMin, cycleMid)}`,
    '───────────────────────────────────────────────────────',
  ];
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : err);
  process.exit(1);
});
