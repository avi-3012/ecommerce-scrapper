import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Badge, StockBadge } from './ui.js';
import { PagerBar } from './components.js';
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

describe('pager bar', () => {
  const bar = (page: number, pageSize: number, total: number): string =>
    renderToStaticMarkup(
      <PagerBar
        page={page}
        pageSize={pageSize}
        total={total}
        onPage={() => undefined}
        onPageSize={() => undefined}
      />,
    );

  it('says which rows these are, of how many, on which page', () => {
    const html = bar(2, 200, 632);
    expect(html).toContain('201–400');
    expect(html).toContain('632');
    expect(html).toContain('Page 2 of 4');
  });

  it('offers 25 to 200 a page, with the current size chosen', () => {
    const html = bar(1, 200, 632);
    for (const size of [25, 50, 100, 200]) expect(html).toContain(`<option value="${size}"`);
    expect(html).toContain('<option value="200" selected="">');
  });

  it('ends the last page at the last row', () => {
    expect(bar(4, 200, 632)).toContain('601–632');
  });

  it('stays out of the way of an empty list', () => {
    expect(bar(1, 25, 0)).toBe('');
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
