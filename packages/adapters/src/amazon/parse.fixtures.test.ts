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
    expect(snap.provenance.price).toBe('buy-box');
  });

  it('extracts price from the total-price block / a-price-whole layout variant', () => {
    // Amazon variant where priceToPay .a-offscreen is empty and the price lives
    // in #tp_price_block_total_price_ww and .a-price-whole (regression for a
    // real page that parsed 5× then failed as "could not extract price").
    const html = `<!doctype html><html><body>
      <span id="productTitle">realme NARZO 90x 5G</span>
      <div id="availability"><span>In stock</span></div>
      <div id="corePriceDisplay_desktop_feature_div">
        <span class="a-price priceToPay"><span class="a-offscreen"></span>
          <span class="a-price-whole">18,999</span></span>
        <span class="a-price a-text-price apex-basisprice-value"><span class="a-offscreen">₹33,999</span></span>
      </div>
      <div id="tp_price_block_total_price_ww"><span class="a-price"><span class="a-offscreen">₹18,999.00</span></span></div>
      <div id="warranty"><span class="a-price"><span class="a-offscreen">₹1,149</span></span></div>
    </body></html>`;
    const snap = parseAmazonPage(html, 'B0GZGBXWJZ');
    expect(snap.price).toBe(18999); // not the ₹1,149 warranty
    expect(snap.mrp).toBe(33999);
    expect(snap.stockStatus).toBe('in_stock');
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

  it('parses enriched individual offers injected by the adapter (classified by card)', () => {
    const offers = JSON.stringify([
      {
        label: 'Bank Offer',
        description: 'Flat INR 8000 Instant Discount on ICICI Bank Credit Card',
      },
      {
        label: 'No Cost EMI',
        description: 'Upto ₹5,855 EMI interest savings on select Credit Cards',
      },
      { label: 'Cashback', description: 'Upto ₹2,609 cashback with Amazon Pay' },
    ]);
    const html = `<!doctype html><html><body>
      <span id="productTitle">vivo X300 FE</span>
      <div id="availability"><span>In stock</span></div>
      <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">₹86,999</span></span></div>
      <script type="application/json" id="pp-amazon-offers">${offers}</script>
    </body></html>`;
    const snap = parseAmazonPage(html, 'B0GX94B58L');
    expect(snap.offers).toHaveLength(3);
    const byDesc = Object.fromEntries(snap.offers.map((o) => [o.description, o.type]));
    expect(byDesc['Flat INR 8000 Instant Discount on ICICI Bank Credit Card']).toBe('bank_offer');
    expect(byDesc['Upto ₹5,855 EMI interest savings on select Credit Cards']).toBe('no_cost_emi');
    expect(byDesc['Upto ₹2,609 cashback with Amazon Pay']).toBe('cashback');
  });

  it('fails as parse_failed when a multi-offer card is present but was not expanded (no toleration)', () => {
    // Simulates the browser tier (or missing enrichment): the page shows a
    // "3 offers" card but carries no injected individual offers — must fail
    // rather than record summary-only data.
    const html = `<!doctype html><html><body>
      <span id="productTitle">vivo X300 FE</span>
      <div id="availability"><span>In stock</span></div>
      <div id="corePriceDisplay_desktop_feature_div"><span class="a-price priceToPay"><span class="a-offscreen">₹86,999</span></span></div>
      <div class="offers-items"><h6 class="offers-items-title">Bank Offer</h6>
        <div class="offers-items-content">Upto ₹8,000 discount</div>
        <a class="vsx-offers-count">3 offers</a></div>
    </body></html>`;
    expect(() => parseAmazonPage(html, 'B0GX94B58L')).toThrowError(
      expect.objectContaining({ reason: 'parse_failed' }),
    );
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
