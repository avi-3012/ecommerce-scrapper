import { describe, expect, it, vi } from 'vitest';
import { JobsService } from './jobs.service.js';
import type { ApiConfig } from './config.js';

/** A JobsService whose pg-boss answers every job instantly, echoing the input. */
function rig() {
  const service = new JobsService({ DATABASE_URL: 'postgresql://x' } as ApiConfig);
  const sent: Array<{ queue: string; data: Record<string, unknown> }> = [];
  const boss = {
    send: vi.fn(async (queue: string, data: Record<string, unknown>) => {
      sent.push({ queue, data });
      return `job-${sent.length}`;
    }),
    // Resolve jobs "complete" by answering each URL with a marker naming the
    // queue it went through, so the test can see where each row was routed.
    getJobById: vi.fn(async (queue: string, id: string) => {
      const job = sent[Number(id.split('-')[1]) - 1]!;
      const urls = (job.data.urls as string[] | undefined) ?? [];
      return { state: 'completed', output: { resolved: urls.map((u) => `${queue}|${u}`) } };
    }),
  };
  (service as unknown as { boss: unknown }).boss = boss;
  return { service, sent };
}

describe('API job routing', () => {
  it('maps a URL to the marketplace whose worker must handle it', () => {
    const { service } = rig();
    expect(service.marketplaceFor('https://www.amazon.in/dp/B0TEST12345')).toBe('amazon_in');
    expect(service.marketplaceFor('https://www.flipkart.com/x/p/itm123?pid=ABCD1234EFGH5678')).toBe(
      'flipkart',
    );
    // Share links go by the host that issued them.
    expect(service.marketplaceFor('https://fkrt.co/abc')).toBe('flipkart');
    expect(service.marketplaceFor('https://amzn.in/d/abc')).toBe('amazon_in');
    // A third-party shortener has no owner; Amazon always has a worker.
    expect(service.marketplaceFor('https://bit.ly/abc')).toBe('amazon_in');
  });

  it("sends an on-demand check to the product's own marketplace queue", async () => {
    const { service, sent } = rig();
    await service.enqueueCheckProduct('p1', 'flipkart');
    expect(sent).toEqual([{ queue: 'check_product.flipkart', data: { productId: 'p1' } }]);
  });

  it('splits an import by marketplace and puts every answer back on its own row', async () => {
    const { service, sent } = rig();
    const urls = ['https://fkrt.co/a', 'https://amzn.in/d/b', '', 'https://fkrt.co/c'];

    const resolved = await service.resolveLinks(urls, 5_000);

    // One job per marketplace, on that marketplace's queue.
    expect(sent.map((s) => s.queue).sort()).toEqual([
      'resolve_links.amazon_in',
      'resolve_links.flipkart',
    ]);
    expect(resolved).toEqual([
      'resolve_links.flipkart|https://fkrt.co/a',
      'resolve_links.amazon_in|https://amzn.in/d/b',
      null,
      'resolve_links.flipkart|https://fkrt.co/c',
    ]);
  });
});
