import { describe, expect, it } from 'vitest';
import { isCooldownExempt, isDigestDue, isWithinQuietHours } from './hygiene.js';

const IST = 'Asia/Kolkata';
// 2026-07-10T23:00 IST == 17:30 UTC
const istNight = new Date('2026-07-10T17:30:00Z');
// 2026-07-10T12:00 IST == 06:30 UTC
const istNoon = new Date('2026-07-10T06:30:00Z');

describe('quiet hours (FR-3.9)', () => {
  it('detects a midnight-spanning window (22:00–07:00)', () => {
    expect(isWithinQuietHours('22:00', '07:00', IST, istNight)).toBe(true);
    expect(isWithinQuietHours('22:00', '07:00', IST, istNoon)).toBe(false);
  });

  it('detects a same-day window (13:00–15:00)', () => {
    expect(isWithinQuietHours('13:00', '15:00', IST, istNoon)).toBe(false);
    const at2pm = new Date('2026-07-10T08:30:00Z'); // 14:00 IST
    expect(isWithinQuietHours('13:00', '15:00', IST, at2pm)).toBe(true);
  });

  it('is off when unset, malformed, or zero-length', () => {
    expect(isWithinQuietHours(null, '07:00', IST, istNight)).toBe(false);
    expect(isWithinQuietHours('22:00', 'bogus', IST, istNight)).toBe(false);
    expect(isWithinQuietHours('22:00', '22:00', IST, istNight)).toBe(false);
  });

  it('is timezone-sensitive', () => {
    // 17:30 UTC is inside a 17:00–18:00 UTC window but outside it in IST (23:00)
    expect(isWithinQuietHours('17:00', '18:00', 'UTC', istNight)).toBe(true);
    expect(isWithinQuietHours('17:00', '18:00', IST, istNight)).toBe(false);
  });
});

describe('cooldown exemptions (WP-3.1 rule 1)', () => {
  it.each(['auto_paused', 'back_in_stock', 'system_health'] as const)('%s is exempt', (type) => {
    expect(isCooldownExempt(type)).toBe(true);
  });
  it.each([
    'target_price',
    'threshold_drop',
    'price_change',
    'offer_change',
    'offer_added',
    'offer_removed',
  ] as const)('%s is subject to cooldown', (type) => {
    expect(isCooldownExempt(type)).toBe(false);
  });
});

describe('digest due (FR-3.10)', () => {
  it('off frequency is never due', () => {
    expect(isDigestDue('off', '09:00', IST, null, istNoon)).toBe(false);
  });
  it('fires after the send time when never sent', () => {
    expect(isDigestDue('daily', '09:00', IST, null, istNoon)).toBe(true);
  });
  it('does not fire before the send time', () => {
    expect(isDigestDue('daily', '13:00', IST, null, istNoon)).toBe(false);
  });
  it('daily repeat-guards within 20 hours', () => {
    const sentRecently = new Date(istNoon.getTime() - 3 * 3600_000);
    expect(isDigestDue('daily', '09:00', IST, sentRecently, istNoon)).toBe(false);
    const sentYesterday = new Date(istNoon.getTime() - 24 * 3600_000);
    expect(isDigestDue('daily', '09:00', IST, sentYesterday, istNoon)).toBe(true);
  });
  it('weekly requires ~6 days', () => {
    const sentTwoDaysAgo = new Date(istNoon.getTime() - 2 * 24 * 3600_000);
    expect(isDigestDue('weekly', '09:00', IST, sentTwoDaysAgo, istNoon)).toBe(false);
    const sentLastWeek = new Date(istNoon.getTime() - 7 * 24 * 3600_000);
    expect(isDigestDue('weekly', '09:00', IST, sentLastWeek, istNoon)).toBe(true);
  });
});
