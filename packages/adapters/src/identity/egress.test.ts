import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_SCRAPING_CONFIG } from './config.js';
import { IdentityPool } from './pool.js';
import { IdentityStore } from './store.js';
import { IpGovernor } from './governor.js';
import type { ScrapingConfig } from './types.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs.length = 0;
});

function rig(egress: string[], count = 6): { pool: IdentityPool; store: IdentityStore } {
  const dir = mkdtempSync(join(tmpdir(), 'pp-egress-'));
  dirs.push(dir);
  const config: ScrapingConfig = {
    ...DEFAULT_SCRAPING_CONFIG,
    egress,
    identities: { ...DEFAULT_SCRAPING_CONFIG.identities, count },
  };
  const store = new IdentityStore(dir);
  const pool = new IdentityPool(config, store);
  pool.ensureSize(Date.now());
  return { pool, store };
}

describe('egress rebalancing', () => {
  // 12 Sep 2026: two addresses were added to a pool of 48 already split across
  // two others. Nothing moved, so the new addresses sat at zero requests while
  // the budget they carried was still counted in the total the cycle planner
  // spent against — half the allowance stranded, and the interval it was bought
  // for never achieved.
  it('drains onto an address added after the pool already exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-egress-'));
    dirs.push(dir);
    const store = new IdentityStore(dir);
    const base = {
      ...DEFAULT_SCRAPING_CONFIG,
      identities: { ...DEFAULT_SCRAPING_CONFIG.identities, count: 12 },
    };

    const two = { ...base, egress: ['10.0.0.1', '10.0.0.2'] };
    new IdentityPool(two, store).ensureSize(Date.now());

    const four = { ...base, egress: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'] };
    const pool = new IdentityPool(four, store);

    const load = (): Record<string, number> => {
      const counts: Record<string, number> = {
        '10.0.0.1': 0,
        '10.0.0.2': 0,
        '10.0.0.3': 0,
        '10.0.0.4': 0,
      };
      for (const identity of pool.list())
        counts[identity.egressId!] = (counts[identity.egressId!] ?? 0) + 1;
      return counts;
    };

    // Gradual, not all at once: retiring half the pool in one pass would be a
    // wave of warm-ups, which is the burst shape that earns a block.
    pool.ensureSize(Date.now());
    expect(load()['10.0.0.3']! + load()['10.0.0.4']!).toBeLessThanOrEqual(2);

    for (let pass = 0; pass < 20; pass++) pool.ensureSize(Date.now());

    const after = load();
    expect(pool.list()).toHaveLength(12);
    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4']) {
      expect(after[ip]).toBeGreaterThanOrEqual(2);
    }
  });

  it('fills new addresses from growth, retiring no established identity', () => {
    // Adding addresses AND raising the pool in one change: the refill should
    // place every new identity on the empty addresses, and not one aged persona
    // should be retired to make room it was never going to need.
    const dir = mkdtempSync(join(tmpdir(), 'pp-egress-'));
    dirs.push(dir);
    const store = new IdentityStore(dir);
    const ids = DEFAULT_SCRAPING_CONFIG.identities;

    const before = {
      ...DEFAULT_SCRAPING_CONFIG,
      egress: ['10.0.0.1', '10.0.0.2'],
      identities: { ...ids, count: 8 },
    };
    new IdentityPool(before, store).ensureSize(Date.now());
    const established = new IdentityPool(before, store).list().map((i) => i.id);

    const after = {
      ...DEFAULT_SCRAPING_CONFIG,
      egress: ['10.0.0.1', '10.0.0.2', '10.0.0.3', '10.0.0.4'],
      identities: { ...ids, count: 16 },
    };
    const pool = new IdentityPool(after, store);
    for (let pass = 0; pass < 20; pass++) pool.ensureSize(Date.now());

    const live = new Set(pool.list().map((i) => i.id));
    for (const id of established) expect(live.has(id)).toBe(true);
    expect(pool.list()).toHaveLength(16);
    const load = (ip: string): number => pool.list().filter((i) => i.egressId === ip).length;
    for (const ip of after.egress) expect(load(ip)).toBe(4);
  });

  it('leaves a balanced pool alone', () => {
    const { pool } = rig(['10.0.0.1', '10.0.0.2'], 8);
    const before = new Map(pool.list().map((i) => [i.id, i.egressId]));
    for (let pass = 0; pass < 5; pass++) pool.ensureSize(Date.now());
    // No churn at all: rebalancing a balanced pool would retire personas for
    // nothing, and history is what makes a persona credible.
    for (const identity of pool.list()) {
      expect(before.get(identity.id)).toBe(identity.egressId);
    }
    expect(pool.list()).toHaveLength(8);
  });
});

describe('egress binding', () => {
  it('spreads identities evenly across the configured addresses', () => {
    const { pool } = rig(['10.0.0.1', '10.0.0.2', '10.0.0.3'], 6);
    const counts = new Map<string, number>();
    for (const identity of pool.list()) {
      const ip = identity.egressId!;
      counts.set(ip, (counts.get(ip) ?? 0) + 1);
    }
    expect([...counts.values()].sort()).toEqual([2, 2, 2]);
  });

  it('leaves identities on the default route when no egress is configured', () => {
    const { pool } = rig([], 4);
    expect(pool.list().every((i) => i.egressId === undefined)).toBe(true);
  });

  it('keeps an identity on the same address for its whole life', () => {
    const { pool } = rig(['10.0.0.1', '10.0.0.2'], 4);
    const before = new Map(pool.list().map((i) => [i.id, i.egressId]));
    // Several more passes must not reshuffle anyone: a persona that appears on
    // two addresses is a signal no real browser produces.
    for (let i = 0; i < 3; i++) pool.ensureSize(Date.now());
    for (const identity of pool.list()) {
      expect(identity.egressId).toBe(before.get(identity.id));
    }
  });

  it('re-homes identities whose address was removed from the config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-egress-'));
    dirs.push(dir);
    const base = {
      ...DEFAULT_SCRAPING_CONFIG,
      identities: { ...DEFAULT_SCRAPING_CONFIG.identities, count: 4 },
    };
    const store = new IdentityStore(dir);
    new IdentityPool({ ...base, egress: ['10.0.0.1', '10.0.0.9'] }, store).ensureSize(Date.now());

    // 10.0.0.9 is decommissioned. Nobody may be left pointing at it.
    const after = new IdentityPool({ ...base, egress: ['10.0.0.1'] }, store);
    after.ensureSize(Date.now());
    expect(after.list().every((i) => i.egressId === '10.0.0.1')).toBe(true);
  });
});

describe('per-egress governor state', () => {
  it('keeps each address accounting for itself alone', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-egress-'));
    dirs.push(dir);
    const store = new IdentityStore(dir);
    const a = new IpGovernor(DEFAULT_SCRAPING_CONFIG, store, () => {}, '10.0.0.1');
    const b = new IpGovernor(DEFAULT_SCRAPING_CONFIG, store, () => {}, '10.0.0.2');

    for (let i = 0; i < 20; i++) a.recordRequest(Date.now());

    // Budgets must not leak between addresses — that is the whole point of
    // splitting them.
    expect(a.snapshot().usedLastMinute).toBe(20);
    expect(b.snapshot().usedLastMinute).toBe(0);
  });

  it('survives a restart with each address keeping its own state', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pp-egress-'));
    dirs.push(dir);
    const now = Date.now();
    const first = new IpGovernor(
      DEFAULT_SCRAPING_CONFIG,
      new IdentityStore(dir),
      () => {},
      '10.0.0.1',
    );
    for (let i = 0; i < 5; i++) first.recordRequest(now);

    const reloaded = new IpGovernor(
      DEFAULT_SCRAPING_CONFIG,
      new IdentityStore(dir),
      () => {},
      '10.0.0.1',
    );
    expect(reloaded.snapshot(now).usedLastMinute).toBe(5);
    const other = new IpGovernor(
      DEFAULT_SCRAPING_CONFIG,
      new IdentityStore(dir),
      () => {},
      '10.0.0.2',
    );
    expect(other.snapshot(now).usedLastMinute).toBe(0);
  });
});
