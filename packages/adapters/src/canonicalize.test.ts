import { describe, expect, it } from 'vitest';
import { createDefaultRegistry } from './default-registry.js';

const registry = createDefaultRegistry();

function expectListing(input: string, canonicalUrl: string, productId: string): void {
  const result = registry.recognize(input);
  expect(result).toEqual({
    kind: 'listing',
    marketplace: expect.any(String),
    canonicalUrl,
    productId,
  });
}

describe('Amazon URL canonicalization (WP-1.1)', () => {
  const canonical = 'https://www.amazon.in/dp/B0CHX1W1XY';

  it.each([
    ['plain dp', 'https://www.amazon.in/dp/B0CHX1W1XY'],
    ['slugged dp', 'https://www.amazon.in/Apple-iPhone-15-128GB-Black/dp/B0CHX1W1XY'],
    ['ref-tagged', 'https://www.amazon.in/dp/B0CHX1W1XY/ref=sr_1_3?keywords=iphone&qid=17203'],
    ['affiliate-tagged', 'https://www.amazon.in/dp/B0CHX1W1XY?tag=affiliate-21&linkCode=ogi'],
    ['gp/product', 'https://www.amazon.in/gp/product/B0CHX1W1XY'],
    ['mobile aw/d', 'https://www.amazon.in/gp/aw/d/B0CHX1W1XY'],
    ['no-www', 'https://amazon.in/dp/B0CHX1W1XY'],
    ['m-dot subdomain', 'https://m.amazon.in/dp/B0CHX1W1XY'],
    ['trailing slash', 'https://www.amazon.in/dp/B0CHX1W1XY/'],
    ['tracking soup', 'https://www.amazon.in/dp/B0CHX1W1XY?pd_rd_w=x&pf_rd_p=y&pd_rd_r=z&psc=1'],
    ['whitespace-padded', '  https://www.amazon.in/dp/B0CHX1W1XY  '],
  ])('%s → canonical', (_label, input) => {
    expectListing(input, canonical, 'B0CHX1W1XY');
  });

  it.each([
    ['home page', 'https://www.amazon.in/'],
    ['search page', 'https://www.amazon.in/s?k=iphone'],
    ['bestsellers', 'https://www.amazon.in/gp/bestsellers/electronics'],
    ['cart', 'https://www.amazon.in/gp/cart/view.html'],
  ])('%s → not_a_listing', (_label, input) => {
    expect(registry.recognize(input)).toEqual({ kind: 'not_a_listing', marketplace: 'amazon_in' });
  });

  it('two decorated links to one listing share a canonical URL (FR-1.5)', () => {
    const a = registry.recognize('https://www.amazon.in/Some-Slug/dp/B0CHX1W1XY?tag=x');
    const b = registry.recognize('https://m.amazon.in/gp/product/B0CHX1W1XY/ref=share');
    expect(a.kind).toBe('listing');
    expect(a).toEqual(
      expect.objectContaining({ canonicalUrl: 'https://www.amazon.in/dp/B0CHX1W1XY' }),
    );
    expect(b).toEqual(
      expect.objectContaining({ canonicalUrl: 'https://www.amazon.in/dp/B0CHX1W1XY' }),
    );
  });
});

describe('Flipkart URL canonicalization (WP-1.1)', () => {
  const itemUrl =
    'https://www.flipkart.com/oneplus-12r-cool-blue-256-gb/p/itm4d2f8c3ba9e21?pid=MOBGXKZ4GFWZHQCE';

  it('canonicalises with pid retained (variant discipline, R-5)', () => {
    expectListing(
      itemUrl,
      'https://www.flipkart.com/product/p/itm4d2f8c3ba9e21?pid=MOBGXKZ4GFWZHQCE',
      'MOBGXKZ4GFWZHQCE',
    );
  });

  it.each([
    ['tracking params', `${itemUrl}&lid=LSTMOB&marketplace=FLIPKART&srno=s_1_1`],
    [
      'different slug, same item',
      'https://www.flipkart.com/other-slug/p/itm4d2f8c3ba9e21?pid=MOBGXKZ4GFWZHQCE&ref=x',
    ],
  ])('%s → same canonical', (_label, input) => {
    const result = registry.recognize(input);
    expect(result).toEqual(
      expect.objectContaining({
        canonicalUrl: 'https://www.flipkart.com/product/p/itm4d2f8c3ba9e21?pid=MOBGXKZ4GFWZHQCE',
      }),
    );
  });

  it('canonicalises without pid using the item id', () => {
    expectListing(
      'https://www.flipkart.com/some-slug/p/itm4d2f8c3ba9e21',
      'https://www.flipkart.com/product/p/itm4d2f8c3ba9e21',
      'itm4d2f8c3ba9e21',
    );
  });

  it.each([
    ['home', 'https://www.flipkart.com/'],
    ['search', 'https://www.flipkart.com/search?q=laptop'],
    ['category', 'https://www.flipkart.com/mobiles/pr?sid=tyy,4io'],
  ])('%s → not_a_listing', (_label, input) => {
    expect(registry.recognize(input)).toEqual({ kind: 'not_a_listing', marketplace: 'flipkart' });
  });
});

describe('unsupported sites (FR-1.2)', () => {
  it.each([
    'https://www.myntra.com/tshirt/p/123',
    'https://www.amazon.com/dp/B0CHX1W1XY',
    'https://www.croma.com/phone/p/300',
  ])('%s is rejected with the detected site', (input) => {
    const result = registry.recognize(input);
    expect(result.kind).toBe('unsupported');
  });
});
