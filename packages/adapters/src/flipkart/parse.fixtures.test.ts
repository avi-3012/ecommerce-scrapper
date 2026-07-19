import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseFlipkartPage } from './parse.js';
import { injectPincodePricing } from './location.js';

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

  it('applies an injected pincode price override (location-aware pricing)', () => {
    const html = injectPincodePricing(fixture('jsonld-in-stock'), {
      price: 37999,
      mrp: 45999,
      stockStatus: 'in_stock',
      pincode: '400001',
    });
    const snap = parseFlipkartPage(html, { pid: 'MOBGXKZ4GFWZHQCE' });
    expect(snap.price).toBe(37999);
    expect(snap.mrp).toBe(45999);
    expect(snap.provenance.price).toBe('pincode-api');
    expect(snap.provenance.pincode).toBe('400001');
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

  it('does NOT false-positive as blocked when "request blocked" appears in a real page\'s JS', () => {
    // Regression: a genuine product page whose embedded JS contains the phrase
    // "request blocked" must still parse, not be reported as fetch_blocked.
    const html = `<!doctype html><html><head>
      <link rel="canonical" href="https://www.flipkart.com/x/p/itm017656bdd097b?pid=MOBH9JUSZHCX3JRG" />
      <script type="application/ld+json">{"@type":"Product","name":"Vivo T4x 5G","offers":{"price":"18999","availability":"https://schema.org/InStock"}}</script>
      <script>var errs={accessDenied:"access denied",blocked:"request blocked"};</script>
      </head><body><h1><span>Vivo T4x 5G</span></h1></body></html>`;
    const snap = parseFlipkartPage(html, { pid: 'MOBH9JUSZHCX3JRG' });
    expect(snap.price).toBe(18999);
    expect(snap.stockStatus).toBe('in_stock');
  });

  it('extracts price from embedded state JSON when JSON-LD lacks it (obfuscated DOM)', () => {
    const html = `<!doctype html><html><head>
      <link rel="canonical" href="https://www.flipkart.com/x/p/itm017656bdd097b?pid=MOBH9JUSZHCX3JRG" />
      <script type="application/ld+json">{"@type":"Product","name":"Vivo T4x 5G"}</script>
      </head><body><h1><span>Vivo T4x 5G</span></h1>
      <script>window.__STATE__={"pricing":{"finalPrice":18999,"mrp":19499}};</script>
      </body></html>`;
    const snap = parseFlipkartPage(html, { pid: 'MOBH9JUSZHCX3JRG' });
    expect(snap.price).toBe(18999);
    expect(snap.mrp).toBe(19499);
    expect(snap.stockStatus).toBe('in_stock');
    expect(snap.provenance.price).toBe('embedded-json');
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
