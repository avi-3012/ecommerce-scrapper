import { describe, expect, it } from 'vitest';
import { formatInr, formatRelativeTime } from './format.js';
import { computeDiscountPct } from './snapshot.js';
import { FAILURE_REASONS, FAILURE_REASON_LABELS } from './enums.js';

describe('formatInr', () => {
  it('uses Indian digit grouping', () => {
    expect(formatInr(1234567)).toBe('₹12,34,567');
  });

  it('shows paise only when present', () => {
    expect(formatInr(999)).toBe('₹999');
    expect(formatInr(999.5)).toBe('₹999.50');
  });
});

describe('formatRelativeTime', () => {
  const now = new Date('2026-07-10T12:00:00Z');
  it.each([
    ['2026-07-10T11:59:50Z', 'just now'],
    ['2026-07-10T11:57:00Z', '3 minutes ago'],
    ['2026-07-10T10:00:00Z', '2 hours ago'],
    ['2026-07-08T12:00:00Z', '2 days ago'],
  ])('%s → %s', (from, expected) => {
    expect(formatRelativeTime(new Date(from), now)).toBe(expected);
  });
});

describe('computeDiscountPct', () => {
  it('computes the percentage off MRP', () => {
    expect(computeDiscountPct(750, 1000)).toBe(25);
  });
  it('is zero when there is no discount or MRP is invalid', () => {
    expect(computeDiscountPct(1000, 1000)).toBe(0);
    expect(computeDiscountPct(1000, 0)).toBe(0);
  });
});

describe('failure taxonomy', () => {
  it('has a user-facing label for every category (NFR-2)', () => {
    for (const reason of FAILURE_REASONS) {
      expect(FAILURE_REASON_LABELS[reason]).toBeTruthy();
    }
  });
});
