import { describe, expect, it } from 'vitest';
import { allQueueNames, marketplaceQueue, MARKETPLACE_QUEUES } from './jobs.js';
import { coversMarketplace, isWorkerLive, marketplaceHasLiveWorker } from './workers.js';

const NOW = Date.parse('2026-09-24T12:00:00Z');
const beat = (msAgo: number): Date => new Date(NOW - msAgo);

describe('worker liveness', () => {
  it('treats an empty marketplace list as "all of them"', () => {
    expect(coversMarketplace({ marketplaces: [] }, 'flipkart')).toBe(true);
    expect(coversMarketplace({ marketplaces: ['amazon_in'] }, 'flipkart')).toBe(false);
  });

  it('counts a worker as live for two minutes after its last heartbeat', () => {
    expect(isWorkerLive({ workerHeartbeatAt: beat(60_000) }, NOW)).toBe(true);
    expect(isWorkerLive({ workerHeartbeatAt: beat(121_000) }, NOW)).toBe(false);
    expect(isWorkerLive({ workerHeartbeatAt: null }, NOW)).toBe(false);
  });

  it('knows when a marketplace has no live worker — the state that otherwise looks like a stall', () => {
    const rows = [
      { workerHeartbeatAt: beat(10_000), marketplaces: ['amazon_in'] as const },
      { workerHeartbeatAt: beat(600_000), marketplaces: ['flipkart'] as const },
    ];
    expect(marketplaceHasLiveWorker(rows, 'amazon_in', NOW)).toBe(true);
    // A Flipkart worker exists, but it stopped reporting ten minutes ago.
    expect(marketplaceHasLiveWorker(rows, 'flipkart', NOW)).toBe(false);
  });
});

describe('marketplace queues', () => {
  it('names one queue per marketplace', () => {
    expect(marketplaceQueue(MARKETPLACE_QUEUES.checkProduct, 'flipkart')).toBe(
      'check_product.flipkart',
    );
  });

  it('creates every queue, marketplace ones included, and only valid pg-boss names', () => {
    const names = allQueueNames();
    expect(names).toContain('check_product');
    expect(names).toContain('preview_product.amazon_in');
    expect(names).toContain('resolve_links.flipkart');
    for (const name of names) expect(name).toMatch(/^[\w.\-/]+$/);
  });
});
