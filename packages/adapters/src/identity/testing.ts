import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Marketplace } from '@pricepulse/shared';
import { DEFAULT_SCRAPING_CONFIG } from './config.js';
import { IpGovernor } from './governor.js';
import { IdentityPool } from './pool.js';
import { IdentitySession } from './session.js';
import { IdentityStore } from './store.js';
import type { ScrapingConfig } from './types.js';

/**
 * Test scaffolding: a real pool, governor and session over a throwaway store
 * directory.
 *
 * Tests use the REAL objects rather than a stub session on purpose. The whole
 * point of the identity layer is that headers, jar, referer chain and pacing
 * agree with each other, and a stub that returns canned headers would assert
 * nothing about the property under test.
 */
export interface TestRig {
  dir: string;
  store: IdentityStore;
  pool: IdentityPool;
  governor: IpGovernor;
  config: ScrapingConfig;
}

export function createTestRig(overrides: Partial<ScrapingConfig> = {}): TestRig {
  const dir = mkdtempSync(join(tmpdir(), 'pricepulse-identity-'));
  const config: ScrapingConfig = { ...DEFAULT_SCRAPING_CONFIG, ...overrides };
  const store = new IdentityStore(dir);
  const pool = new IdentityPool(config, store);
  // A cap that never gates, so a test asserting parsing does not wait 60 s for a
  // slot. Cap behaviour has its own tests, which set the cap explicitly.
  const governor = new IpGovernor(
    { ...config, ipCap: { ...config.ipCap, mode: 'fixed', dayPerMin: 600, nightPerMin: 600 } },
    store,
  );
  return { dir, store, pool, governor, config };
}

/** One warmed identity's session, ready to fetch. */
export function createTestSession(
  marketplace: Marketplace = 'flipkart',
  rig: TestRig = createTestRig(),
): IdentitySession {
  rig.pool.ensureSize();
  const identity = rig.pool.list()[0]!;
  // Pre-warm so a test fetch does not first go and load a homepage.
  const site = marketplace === 'amazon_in' ? 'amazon.in' : 'flipkart.com';
  rig.pool.noteWarmed(identity, site);
  return new IdentitySession(identity, rig.pool, rig.governor, marketplace);
}
