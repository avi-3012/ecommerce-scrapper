import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAmazonPage } from './parse.js';
import { CheckError } from '../errors.js';

function fixture(name: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../fixtures/amazon/${name}.html`, import.meta.url)),
    'utf8',
  );
}

describe('amazon fixture suite (WP-1.2)', () => {
  it('fixture: in-stock listing with MRP', () => {
    const snap = parseAmazonPage(fixture('in-stock-basic'), 'B0CHX1W1XY');
    expect(snap.name).toBe('Apple iPhone 15 (128 GB) - Black');
    expect(snap.price).toBe(65999);
    expect(snap.mrp).toBe(69900);
    expect(snap.discountPct).toBeCloseTo(5.58, 1);
    expect(snap.stockStatus).toBe('in_stock');
    expect(snap.marketplaceProductId).toBe('B0CHX1W1XY');
    expect(snap.imageUrl).toContain('media-amazon.com');
    expect(snap.provenance.price).toBe('core-price-block');
  });

  it('fixture: deal price with coupon and bank offers', () => {
    const snap = parseAmazonPage(fixture('deal-coupon-bank'), 'B0CS5XW6TN');
    expect(snap.price).toBe(62999);
    expect(snap.mrp).toBe(79999);
    expect(snap.offers.length).toBeGreaterThanOrEqual(3);
    const types = snap.offers.map((o) => o.type);
    expect(types).toContain('coupon');
    expect(types).toContain('bank_offer');
  });

  it('fixture: out-of-stock is a successful check with NULL price (no garbage price)', () => {
    const snap = parseAmazonPage(fixture('out-of-stock'), 'B09XS7JWHH');
    expect(snap.stockStatus).toBe('out_of_stock');
    expect(snap.name).toContain('Sony WH-1000XM5');
    // Out of stock ⇒ no trustworthy buy-box price; must be null, never a scraped number.
    expect(snap.price).toBeNull();
    expect(snap.mrp).toBeNull();
  });

  it('does not grab an accessory/EMI price on an out-of-stock page', () => {
    // Unavailable listing whose only prices on the page are unrelated (an
    // add-on and an EMI). The old page-wide fallback grabbed ₹499; must not now.
    const html = `<!doctype html><html><body>
      <span id="productTitle">Some Laptop</span>
      <div id="availability"><span>Currently unavailable.</span></div>
      <div id="protectionPlan"><span class="a-price"><span class="a-offscreen">₹499</span></span></div>
      <div id="emiOptions"><span class="a-price"><span class="a-offscreen">₹4,999</span></span></div>
    </body></html>`;
    const snap = parseAmazonPage(html);
    expect(snap.stockStatus).toBe('out_of_stock');
    expect(snap.price).toBeNull();
  });

  it('fixture: CAPTCHA page fails as captcha', () => {
    expect(() => parseAmazonPage(fixture('captcha'))).toThrowError(
      expect.objectContaining({ reason: 'captcha' }),
    );
  });

  it('fixture: robot-check page fails as fetch_blocked', () => {
    expect(() => parseAmazonPage(fixture('robot-blocked'))).toThrowError(
      expect.objectContaining({ reason: 'fetch_blocked' }),
    );
  });

  it('fixture: ASIN mismatch fails as parse_failed (variant discipline, R-5)', () => {
    try {
      parseAmazonPage(fixture('wrong-variant'), 'B0CHX1W1XY');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CheckError);
      expect((err as CheckError).reason).toBe('parse_failed');
      expect((err as CheckError).message).toContain('B0CHX2ZLPQ');
    }
  });

  it('fixture: unknown future layout fails cleanly as parse_failed', () => {
    expect(() =>
      parseAmazonPage('<html><body><div>totally new layout</div></body></html>'),
    ).toThrowError(expect.objectContaining({ reason: 'parse_failed' }));
  });
});
