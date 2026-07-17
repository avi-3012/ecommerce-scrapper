import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, StockBadge } from './ui.js';
import { alertSummary } from './pages/Dashboard.js';
import type { AlertRow } from './api.js';

function alert(
  type: AlertRow['type'],
  newValue: Record<string, unknown>,
  changePct: string | null = null,
): AlertRow {
  return {
    id: 'a1',
    productId: 'p1',
    type,
    oldValue: null,
    newValue,
    changePct,
    firedAt: new Date().toISOString(),
    deliveryStatus: 'delivered',
    deliveryError: null,
    deliveredAt: null,
    message: null,
    product: { displayName: 'Test', marketplace: 'amazon_in', url: 'https://amazon.in' },
  };
}

describe('alertSummary', () => {
  it('describes a target-price alert with the new price', () => {
    expect(alertSummary(alert('target_price', { price: 44000 }))).toContain('₹44,000');
  });
  it('describes a threshold drop with the percentage', () => {
    expect(alertSummary(alert('threshold_drop', { price: 900 }, '-10'))).toContain('-10%');
  });
  it('describes back-in-stock', () => {
    expect(alertSummary(alert('back_in_stock', {}))).toContain('back in stock');
  });
});

describe('badges', () => {
  it('renders stock badges for each state', () => {
    expect(renderToStaticMarkup(<StockBadge stock="in_stock" />)).toContain('In stock');
    expect(renderToStaticMarkup(<StockBadge stock="out_of_stock" />)).toContain('Out of stock');
  });
  it('renders tones', () => {
    expect(renderToStaticMarkup(<Badge tone="danger">x</Badge>)).toContain('bg-danger-subtle');
  });
});
