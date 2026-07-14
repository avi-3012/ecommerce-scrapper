import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlipkartPage } from './parse.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/flipkart/${name}.html`, import.meta.url)),
    'utf8',
  );
}

describe('flipkart fixture suite (WP-1.3)', () => {
  it('fixture: JSON-LD in-stock listing with offers and MRP', () => {
    const snap = parseFlipkartPage(fixture('jsonld-in-stock'), { pid: 'MOBGXKZ4GFWZHQCE' });
    expect(snap.name).toBe('OnePlus 12R (Cool Blue, 256 GB)');
    expect(snap.price).toBe(39999);
    expect(snap.mrp).toBe(45999);
    expect(snap.stockStatus).toBe('in_stock');
    expect(snap.provenance.price).toBe('jsonld');
    const types = snap.offers.map((o) => o.type);
    expect(types).toContain('bank_offer');
    expect(snap.marketplaceProductId).toBe('MOBGXKZ4GFWZHQCE');
  });

  it('fixture: Coming Soon / Notify Me maps to out_of_stock (FR-2.7)', () => {
    const snap = parseFlipkartPage(fixture('jsonld-coming-soon'), { pid: 'MOBH2QZFDGKXYZAB' });
    expect(snap.stockStatus).toBe('out_of_stock');
    expect(snap.name).toContain('Nothing Phone');
  });

  it('fixture: selector-only page (no JSON-LD) parses via fallbacks', () => {
    const snap = parseFlipkartPage(fixture('selectors-only'), { pid: 'ACCGHXFYPQRSTUVW' });
    expect(snap.name).toContain('boAt Airdopes 141');
    expect(snap.price).toBe(1299);
    expect(snap.mrp).toBe(4490);
    expect(snap.provenance.price).toBe('price-element');
    expect(snap.offers.map((o) => o.type)).toContain('coupon');
  });

  it('nulls the price for a sold-out listing even if JSON-LD carries one', () => {
    const snap = parseFlipkartPage(fixture('jsonld-coming-soon'), { pid: 'MOBH2QZFDGKXYZAB' });
    expect(snap.stockStatus).toBe('out_of_stock');
    expect(snap.price).toBeNull();
  });

  it('fixture: Sold Out page is a successful out-of-stock check', () => {
    const snap = parseFlipkartPage(fixture('sold-out'), { pid: 'MOBG3ZXKWQPMNBVC' });
    expect(snap.stockStatus).toBe('out_of_stock');
    expect(snap.name).toContain('Mi 11X 5G');
  });

  it('fixture: unusual-traffic page fails as captcha', () => {
    expect(() => parseFlipkartPage(fixture('blocked'))).toThrowError(
      expect.objectContaining({ reason: 'captcha' }),
    );
  });

  it('fixture: ID mismatch fails as parse_failed (variant discipline, R-5)', () => {
    expect(() =>
      parseFlipkartPage(fixture('jsonld-in-stock'), { pid: 'WRONGPID12345678' }),
    ).toThrowError(expect.objectContaining({ reason: 'parse_failed' }));
  });

  it('does NOT reject when the page exposes only its itemId and we expect a pid (regression: /a/p/ URLs)', () => {
    // Page canonical carries only the itemId (no pid) — compare itemId↔itemId,
    // never the page itemId against our pid, which falsely flagged a redirect.
    const html = `<!doctype html><html><head>
      <link rel="canonical" href="https://www.flipkart.com/pixel/p/itm1692bd8b2fe84" />
      <script type="application/ld+json">{"@type":"Product","name":"Test Pixel","offers":{"price":"49999","availability":"https://schema.org/InStock"}}</script>
      </head><body><h1><span>Test Pixel</span></h1></body></html>`;
    const snap = parseFlipkartPage(html, { pid: 'COMHHHBZD7A5VNH7', itemId: 'itm1692bd8b2fe84' });
    expect(snap.name).toBe('Test Pixel');
    expect(snap.price).toBe(49999);
  });
});
