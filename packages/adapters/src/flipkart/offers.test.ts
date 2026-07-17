import { describe, expect, it } from 'vitest';
import { extractFlipkartOffers, extractInitialState } from './offers.js';

// A trimmed shape mirroring Flipkart's __INITIAL_STATE__ NepOffers objects.
function stateHtml(offers: unknown): string {
  const json = JSON.stringify({ multiWidgetState: { offers } });
  return `<html><body><script id="is_script">window.__INITIAL_STATE__ = ${json};</script></body></html>`;
}

const nepOffer = (
  offerTitle: string,
  contentValue: string,
  amount: string,
  offerType?: string,
): unknown => ({
  type: 'NepOffers',
  offerTitle,
  ...(offerType ? { offerType } : {}),
  offerSubTitleRC: { value: { contentList: [{ contentType: 'TEXT', contentValue }] } },
  action: { tracking: { metaInfoLabelValue: amount } },
});

describe('extractInitialState', () => {
  it('isolates the state object even with sibling script statements', () => {
    const html = `<script>var domain="x";window.__INITIAL_STATE__ = {"a":{"b":"}{"}};var y=1;</script>`;
    expect(extractInitialState(html)).toEqual({ a: { b: '}{' } });
  });

  it('returns null when no state blob is present', () => {
    expect(extractInitialState('<html></html>')).toBeNull();
  });
});

describe('extractFlipkartOffers', () => {
  it('pulls individual offers with title, subtitle and amount', () => {
    const html = stateHtml([
      nepOffer('Flipkart Axis', 'Credit Card • Includes cashback', '₹ 5795 off'),
      nepOffer('BHIM', 'UPI • Cashback', '₹ 75 off'),
      nepOffer('Bank offers', '', '₹ 5,795 off', 'PBO'),
    ]);
    const offers = extractFlipkartOffers(html);
    const descriptions = offers.map((o) => o.description);
    expect(descriptions).toContain('Flipkart Axis — Credit Card • Includes cashback — ₹ 5795 off');
    expect(descriptions).toContain('BHIM — UPI • Cashback — ₹ 75 off');
    expect(descriptions).toContain('Bank offers — ₹ 5,795 off');
  });

  it('excludes EMI installment plans (payment plans, not promotions)', () => {
    const html = stateHtml([
      nepOffer('HDFC Bank', 'Credit Card', '₹ 2,100 off/m (36 months)'),
      nepOffer('ICICI Bank', 'Credit Card', '₹ 2,884 off/m (24 months)'),
      nepOffer('Flipkart Axis', 'Credit Card • Includes cashback', '₹ 5795 off'),
    ]);
    const offers = extractFlipkartOffers(html);
    expect(offers).toHaveLength(1);
    expect(offers[0]?.description).toContain('Flipkart Axis');
  });

  it('drops vague category headers with a UI-prompt subtitle and no amount', () => {
    const html = stateHtml([
      nepOffer('EMI offers', 'Or check these EMI plans', '₹ 0 off', 'PBO_EMI'),
      nepOffer('Exchange offer', 'Change pincode to exchange item', '', 'EXCHANGE'),
      nepOffer('Bank offers', '', '₹ 5,795 off', 'PBO'),
    ]);
    const descriptions = extractFlipkartOffers(html).map((o) => o.description);
    expect(descriptions).toEqual(['Bank offers — ₹ 5,795 off']);
  });

  it('returns nothing when the page has no state blob', () => {
    expect(extractFlipkartOffers('<html><body>no state</body></html>')).toEqual([]);
  });
});
