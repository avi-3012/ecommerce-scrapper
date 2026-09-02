import { describe, expect, it } from 'vitest';
import { resolveListingUrl, shortLinkMarketplace } from './http.js';
import type { ResolveHop } from './http.js';

/** A hop that fails the test if it is ever called. */
const noHop: ResolveHop = () => {
  throw new Error('resolveListingUrl made a request it should not have made');
};

/** A hop driven by a fixed url → Location map; anything else answers 200. */
function hopFrom(redirects: Record<string, string>): { hop: ResolveHop; seen: string[] } {
  const seen: string[] = [];
  const hop: ResolveHop = (url) => {
    seen.push(url);
    const location = redirects[url];
    return Promise.resolve(location ? { statusCode: 302, location } : { statusCode: 200 });
  };
  return { hop, seen };
}

describe('resolveListingUrl', () => {
  it('returns immediately without a request when the URL is already a listing', async () => {
    const url = 'https://www.flipkart.com/x/p/itm1234567890abc?pid=ABCD1234EFGH5678';
    expect(await resolveListingUrl(url, () => true, { hop: noHop })).toBe(url);
  });

  it('follows redirects until the URL recognizes as a listing', async () => {
    const listing = 'https://www.flipkart.com/x/p/itm123?pid=ABCD1234EFGH5678';
    const { hop, seen } = hopFrom({
      'https://fkrt.co/abc': 'https://dl.flipkart.com/s/xyz',
      'https://dl.flipkart.com/s/xyz': listing,
    });
    const result = await resolveListingUrl('https://fkrt.co/abc', (u) => u === listing, { hop });
    expect(result).toBe(listing);
    // Stops AT the listing: the heavy marketplace page is never requested.
    expect(seen).toEqual(['https://fkrt.co/abc', 'https://dl.flipkart.com/s/xyz']);
  });

  it('absolutises a relative Location header', async () => {
    const { hop } = hopFrom({ 'https://pwap.in/a': '/dp/B0TEST12345' });
    const result = await resolveListingUrl('https://pwap.in/a', () => false, { hop });
    expect(result).toBe('https://pwap.in/dp/B0TEST12345');
  });

  it('stops at maxHops instead of following a redirect loop forever', async () => {
    const { hop, seen } = hopFrom({
      'https://a.test/1': 'https://a.test/2',
      'https://a.test/2': 'https://a.test/1',
    });
    await resolveListingUrl('https://a.test/1', () => false, { hop, maxHops: 3 });
    expect(seen).toHaveLength(4); // hops 0..3 inclusive
  });

  it('returns the best-effort URL when a hop throws', async () => {
    const hop: ResolveHop = () => Promise.reject(new Error('blocked'));
    expect(await resolveListingUrl('https://fkrt.co/abc', () => false, { hop })).toBe(
      'https://fkrt.co/abc',
    );
  });
});

describe('shortLinkMarketplace', () => {
  it('identifies marketplace-operated short links, which must be followed as that site', () => {
    expect(shortLinkMarketplace('https://fkrt.co/abc')).toBe('flipkart');
    expect(shortLinkMarketplace('https://dl.flipkart.com/s/xyz')).toBe('flipkart');
    expect(shortLinkMarketplace('https://amzn.in/d/abc')).toBe('amazon_in');
    expect(shortLinkMarketplace('https://www.amzn.to/abc')).toBe('amazon_in');
  });

  it('returns null for third-party shorteners, which have no site relationship', () => {
    expect(shortLinkMarketplace('https://pwap.in/a')).toBeNull();
    expect(shortLinkMarketplace('https://bit.ly/a')).toBeNull();
    expect(shortLinkMarketplace('not a url')).toBeNull();
  });
});
