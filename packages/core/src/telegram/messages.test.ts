import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TEMPLATES,
  applyTemplate,
  buildAlertVariables,
  renderAlertMessage,
  sampleAlertInput,
} from './messages.js';

const firedAt = new Date('2026-07-01T01:51:00+05:30');

describe('template variables', () => {
  it('builds price + offer variables for an offer change', () => {
    const vars = buildAlertVariables(sampleAlertInput('offer_change'), 'Asia/Kolkata');
    expect(vars.price).toBe('₹69,900');
    expect(vars.newOffers).toContain('• Flipkart Axis — Credit Card • Cashback — ₹3,495 off');
    expect(vars.oldOffers).toBe('No offers');
    expect(vars.marketplace).toBe('Flipkart');
    expect(vars.time).toBe('01 Jul 2026, 01:51 AM');
  });

  it('directional label + arrow for a price increase vs decrease', () => {
    const up = buildAlertVariables({
      type: 'price_change',
      productName: 'x',
      marketplace: 'flipkart',
      listingUrl: '',
      oldValue: { price: 100 },
      newValue: { price: 110 },
      changePct: 10,
      firedAt,
    });
    expect(up.typeLabel).toBe('Price Increased');
    expect(up.changeArrow).toBe('▲');
    expect(up.changePct).toBe('10%');
    const down = buildAlertVariables({
      type: 'price_change',
      productName: 'x',
      marketplace: 'flipkart',
      listingUrl: '',
      oldValue: { price: 110 },
      newValue: { price: 100 },
      changePct: -9.1,
      firedAt,
    });
    expect(down.typeLabel).toBe('Price Decreased');
    expect(down.changeArrow).toBe('▼');
  });

  it('HTML-escapes dynamic values (product name, url)', () => {
    const vars = buildAlertVariables({
      type: 'price_change',
      productName: 'A & B <phone>',
      marketplace: 'amazon_in',
      listingUrl: 'https://x.in/?a=1&b=2',
      oldValue: { price: 100 },
      newValue: { price: 90 },
      changePct: -10,
      firedAt,
    });
    expect(vars.productName).toBe('A &amp; B &lt;phone&gt;');
    expect(vars.url).toBe('https://x.in/?a=1&amp;b=2');
  });
});

describe('applyTemplate', () => {
  it('substitutes known variables and drops unknown ones', () => {
    expect(applyTemplate('Hi {{name}} — {{missing}}!', { name: 'Sam' })).toBe('Hi Sam — !');
  });
});

describe('renderAlertMessage', () => {
  it('uses a custom template when provided', () => {
    const msg = renderAlertMessage(sampleAlertInput('price_change'), {
      template: 'PRICE {{oldPrice}}->{{newPrice}} {{changeArrow}}{{changePct}}',
    });
    expect(msg).toBe('PRICE ₹64,900->₹69,900 ▲7.7%');
  });

  it('falls back to the default template when none provided', () => {
    const msg = renderAlertMessage(sampleAlertInput('offer_change'));
    expect(msg).toContain('🏷️ <b>Offer changed</b> — Flipkart');
    expect(msg).toContain('New offers:');
  });

  it('every alert type has a non-empty default template', () => {
    for (const [type, template] of Object.entries(DEFAULT_TEMPLATES)) {
      expect(template.length).toBeGreaterThan(0);
      // Renders without throwing and produces output.
      const msg = renderAlertMessage(sampleAlertInput(type as keyof typeof DEFAULT_TEMPLATES));
      expect(msg.length).toBeGreaterThan(0);
    }
  });
});
