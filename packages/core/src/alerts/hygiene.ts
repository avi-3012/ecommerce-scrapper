import type { AlertType } from '@pricepulse/shared';

/**
 * Alert hygiene (WP-3.1). Governing principle: hygiene alters DELIVERY,
 * never evaluation or records — suppressed/held alerts are always recorded.
 */

/** Types where every firing is inherently meaningful — never cooled down. */
const COOLDOWN_EXEMPT: ReadonlySet<AlertType> = new Set([
  'auto_paused',
  'back_in_stock',
  'system_health',
]);

export function isCooldownExempt(type: AlertType): boolean {
  return COOLDOWN_EXEMPT.has(type);
}

/** Health alerts delivered immediately during quiet hours unless the user opts to hold them. */
export function isHealthAlert(type: AlertType): boolean {
  return type === 'auto_paused' || type === 'system_health';
}

/** Minutes since local midnight in the given IANA timezone. */
export function minutesOfDayIn(timezone: string, now: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hour * 60 + minute;
}

function parseHhMm(value: string): number | null {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Quiet-hours window test (FR-3.9), midnight-spanning correct:
 * start 22:00 / end 07:00 covers 22:00→24:00 and 00:00→07:00.
 */
export function isWithinQuietHours(
  start: string | null,
  end: string | null,
  timezone: string,
  now: Date,
): boolean {
  if (!start || !end) return false;
  const startMin = parseHhMm(start);
  const endMin = parseHhMm(end);
  if (startMin === null || endMin === null || startMin === endMin) return false;
  const nowMin = minutesOfDayIn(timezone, now);
  return startMin < endMin
    ? nowMin >= startMin && nowMin < endMin
    : nowMin >= startMin || nowMin < endMin;
}

/** Is a daily/weekly digest due (FR-3.10)? Time-of-day gated + a repeat guard. */
export function isDigestDue(
  frequency: 'off' | 'daily' | 'weekly',
  digestTime: string | null,
  timezone: string,
  lastDigestAt: Date | null,
  now: Date,
): boolean {
  if (frequency === 'off') return false;
  const sendAt = parseHhMm(digestTime ?? '09:00') ?? 540;
  if (minutesOfDayIn(timezone, now) < sendAt) return false;
  if (!lastDigestAt) return true;
  const hoursSince = (now.getTime() - lastDigestAt.getTime()) / 3600_000;
  return frequency === 'daily' ? hoursSince >= 20 : hoursSince >= 6 * 24;
}
