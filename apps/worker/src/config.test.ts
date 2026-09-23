import { describe, expect, it } from 'vitest';
import { loadConfig, scrapesEverything } from './config.js';
import { consumedQueues } from './jobs.service.js';

const base = {
  DATABASE_URL: 'postgresql://x:y@localhost:5432/z',
  SETTINGS_ENC_KEY: 'ab'.repeat(32),
};

describe('worker scope', () => {
  it('scrapes every marketplace when unset — exactly how one worker always behaved', () => {
    const config = loadConfig(base);
    expect(config.WORKER_MARKETPLACES).toEqual(['amazon_in', 'flipkart']);
    expect(config.WORKER_ROLE).toBe('primary');
    expect(config.WORKER_STATUS_ID).toBe(1);
    expect(scrapesEverything(config)).toBe(true);
  });

  it('parses a scoped list', () => {
    const config = loadConfig({ ...base, WORKER_MARKETPLACES: ' flipkart ' });
    expect(config.WORKER_MARKETPLACES).toEqual(['flipkart']);
    expect(scrapesEverything(config)).toBe(false);
  });

  it('refuses an unknown marketplace rather than silently scraping nothing', () => {
    expect(() => loadConfig({ ...base, WORKER_MARKETPLACES: 'flipcart' })).toThrow(
      /unknown marketplace flipcart/,
    );
  });

  it("refuses a secondary worker on the primary's status row", () => {
    // Two workers on one row overwrite each other's heartbeat: one looks dead
    // while the other looks like both.
    expect(() => loadConfig({ ...base, WORKER_ROLE: 'secondary' })).toThrow(/WORKER_STATUS_ID=2/);
    expect(
      loadConfig({ ...base, WORKER_ROLE: 'secondary', WORKER_STATUS_ID: '2' }).WORKER_STATUS_ID,
    ).toBe(2);
  });
});

describe('queue subscriptions', () => {
  it('a Flipkart worker consumes Flipkart queues and nothing else', () => {
    const queues = consumedQueues({ WORKER_MARKETPLACES: ['flipkart'] });
    expect(queues.checkProduct).toEqual(['check_product.flipkart']);
    expect(queues.previewProduct).toEqual(['preview_product.flipkart']);
    expect(queues.resolveLinks).toEqual(['resolve_links.flipkart']);
  });

  it('an Amazon worker never takes a Flipkart job — it would send it from an address Flipkart refuses', () => {
    const all = Object.values(consumedQueues({ WORKER_MARKETPLACES: ['amazon_in'] })).flat();
    expect(all.some((q) => q.includes('flipkart'))).toBe(false);
    // Nor the unsuffixed queues, which carry work for any marketplace.
    expect(all).not.toContain('check_product');
  });

  it('a single all-marketplace worker also drains the original queues', () => {
    const queues = consumedQueues({ WORKER_MARKETPLACES: ['amazon_in', 'flipkart'] });
    expect(queues.checkProduct).toEqual([
      'check_product.amazon_in',
      'check_product.flipkart',
      'check_product',
    ]);
  });
});
