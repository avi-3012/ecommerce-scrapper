import { describe, expect, it } from 'vitest';
import { AdapterRegistry } from './registry.js';
import type { MarketplaceAdapter } from './adapter.js';

const fakeAmazon: MarketplaceAdapter = {
  marketplace: 'amazon_in',
  domains: ['amazon.in', 'amzn.in'],
  recognize(url) {
    const match = url.pathname.match(/\/dp\/([A-Z0-9]{10})/);
    if (!match || !match[1]) return { kind: 'not_a_listing', marketplace: 'amazon_in' };
    return {
      kind: 'listing',
      marketplace: 'amazon_in',
      canonicalUrl: `https://www.amazon.in/dp/${match[1]}`,
      productId: match[1],
    };
  },
  fetch() {
    return Promise.reject(new Error('not implemented in Phase 0'));
  },
  parse() {
    throw new Error('not implemented in Phase 0');
  },
};

describe('AdapterRegistry', () => {
  const registry = new AdapterRegistry();
  registry.register(fakeAmazon);

  it('recognises a listing URL and canonicalises it', () => {
    const result = registry.recognize(
      'https://www.amazon.in/some-product-name/dp/B0TEST12345?ref=xyz&tag=aff'.replace(
        'B0TEST12345',
        'B0TEST1234',
      ),
    );
    expect(result).toEqual({
      kind: 'listing',
      marketplace: 'amazon_in',
      canonicalUrl: 'https://www.amazon.in/dp/B0TEST1234',
      productId: 'B0TEST1234',
    });
  });

  it('flags supported-site non-listing pages distinctly (WP-1.1 rule)', () => {
    expect(registry.recognize('https://www.amazon.in/gp/bestsellers')).toEqual({
      kind: 'not_a_listing',
      marketplace: 'amazon_in',
    });
  });

  it('rejects unsupported sites with the detected host (FR-1.2)', () => {
    expect(registry.recognize('https://www.myntra.com/product/123')).toEqual({
      kind: 'unsupported',
      detectedSite: 'myntra.com',
    });
  });

  it('never throws on malformed input', () => {
    expect(registry.recognize('not a url at all')).toEqual({
      kind: 'unsupported',
      detectedSite: null,
    });
  });

  it('matches subdomains of a claimed domain', () => {
    const viaSubdomain = registry.recognize('https://m.amazon.in/dp/B0TEST1234');
    expect(viaSubdomain.kind).toBe('listing');
  });

  it('refuses double-claimed domains', () => {
    const dupe = new AdapterRegistry();
    dupe.register(fakeAmazon);
    expect(() => dupe.register({ ...fakeAmazon })).toThrow(/already claimed/);
  });
});
