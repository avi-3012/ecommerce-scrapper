import { FAILURE_REASON_LABELS, MARKETPLACE_LABELS, formatInr } from '@pricepulse/shared';
import type { AlertType, FailureReason, Marketplace, Offer } from '@pricepulse/shared';

/**
 * Telegram message templates (WP-1.8, FR-3.7): every alert states product,
 * marketplace, old → new values, % change where applicable, and a direct
 * listing link. HTML parse mode; glanceable on a phone.
 */

export interface AlertMessageInput {
  type: AlertType;
  productName: string;
  marketplace: Marketplace;
  listingUrl: string;
  oldValue: unknown;
  newValue: unknown;
  changePct: number | null;
  firedAt: Date;
}

export function renderAlertMessage(input: AlertMessageInput): string {
  const title = titleFor(input.type);
  const name = escapeHtml(input.productName);
  const marketplace = MARKETPLACE_LABELS[input.marketplace];
  const body = bodyFor(input);
  const link = `<a href="${escapeHtml(input.listingUrl)}">Open listing on ${marketplace}</a>`;
  return `${title}\n<b>${name}</b> · ${marketplace}\n${body}\n${link}`;
}

function titleFor(type: AlertType): string {
  switch (type) {
    case 'target_price':
      return '🎯 <b>Target price reached</b>';
    case 'threshold_drop':
      return '📉 <b>Price drop</b>';
    case 'price_change':
      return '↕️ <b>Price changed</b>';
    case 'offer_change':
      return '🏷️ <b>Offers changed</b>';
    case 'back_in_stock':
      return '📦 <b>Back in stock</b>';
    case 'auto_paused':
      return '⚠️ <b>Monitoring paused</b>';
    case 'system_health':
      return '🩺 <b>System health</b>';
  }
}

function bodyFor(input: AlertMessageInput): string {
  const oldVal = (input.oldValue ?? {}) as Record<string, unknown>;
  const newVal = (input.newValue ?? {}) as Record<string, unknown>;
  const pct = input.changePct !== null ? ` (${formatPct(input.changePct)})` : '';

  switch (input.type) {
    case 'target_price': {
      const target = Number(newVal.target);
      const price = Number(newVal.price);
      const from =
        oldVal.price !== null && oldVal.price !== undefined
          ? `${formatInr(Number(oldVal.price))} → `
          : '';
      const below = target > 0 ? Math.round(((target - price) / target) * 1000) / 10 : 0;
      const belowText = below > 0 ? `, ${below}% below target` : '';
      return `${from}<b>${formatInr(price)}</b>${pct}\nTarget was ${formatInr(target)}${belowText}`;
    }
    case 'threshold_drop': {
      return `${formatInr(Number(oldVal.price))} → <b>${formatInr(Number(newVal.price))}</b>${pct}\nThreshold: ${Number(newVal.thresholdPct)}%`;
    }
    case 'price_change': {
      return `${formatInr(Number(oldVal.price))} → <b>${formatInr(Number(newVal.price))}</b>${pct}`;
    }
    case 'offer_change': {
      const added = ((newVal.added ?? []) as Offer[]).map((o) => `➕ ${escapeHtml(o.description)}`);
      const removed = ((newVal.removed ?? []) as Offer[]).map(
        (o) => `➖ ${escapeHtml(o.description)}`,
      );
      const price =
        newVal.price !== undefined ? `\nCurrent price: ${formatInr(Number(newVal.price))}` : '';
      return [...added, ...removed].join('\n') + price;
    }
    case 'back_in_stock': {
      const price = newVal.price !== undefined ? ` at ${formatInr(Number(newVal.price))}` : '';
      return `Available again${price}`;
    }
    case 'auto_paused': {
      const reason =
        FAILURE_REASON_LABELS[newVal.failureReason as FailureReason] ?? 'Repeated failures';
      const count = Number(newVal.consecutiveFailures ?? 0);
      return `${reason}.\nPaused after ${count} consecutive failed checks — other products are unaffected. Resume it once the listing looks right.`;
    }
    case 'system_health': {
      return escapeHtml(String(newVal.message ?? 'Attention needed'));
    }
  }
}

export function renderTestMessage(now: Date = new Date()): string {
  return `✅ <b>PricePulse test notification</b>\nYour Telegram configuration works. Sent at ${now.toISOString()}.`;
}

function formatPct(pct: number): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct}%`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
