import { FAILURE_REASON_LABELS, MARKETPLACE_LABELS, formatInr } from '@pricepulse/shared';
import type { AlertType, FailureReason, Marketplace, Offer } from '@pricepulse/shared';

/**
 * Telegram message rendering (WP-1.8, FR-3.7). Every alert type has a default
 * template, and the user may override any of them (notification template
 * editor). Templates are plain text with `{{variable}}` placeholders and
 * Telegram HTML (`<b>`, `<a>`); variable VALUES are HTML-escaped so product
 * names, offers and URLs are always safe.
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

export interface RenderOptions {
  /** User's custom template for this alert type; falls back to the default when empty. */
  template?: string | null;
  /** IANA timezone for the timestamp (defaults to Asia/Kolkata). */
  timezone?: string;
}

/** Human label shown in the editor and as the `{{typeLabel}}` default. */
export const ALERT_TYPE_LABELS: Record<AlertType, string> = {
  target_price: 'Target price reached',
  threshold_drop: 'Price drop',
  price_change: 'Price changed',
  offer_change: 'Offer changed',
  back_in_stock: 'Back in stock',
  auto_paused: 'Monitoring paused',
  system_health: 'System health',
};

/** Default templates — the starting point users customise. */
export const DEFAULT_TEMPLATES: Record<AlertType, string> = {
  target_price: [
    '{{emoji}} <b>{{typeLabel}}</b> — {{marketplace}}',
    '📱 {{productName}}',
    '',
    'Was:     {{oldPrice}}',
    'Now:     {{newPrice}}',
    'Target:  {{target}}',
    '',
    '🔗 {{link}}',
    '⏰ {{time}}',
  ].join('\n'),
  threshold_drop: [
    '{{emoji}} <b>{{typeLabel}}</b> — {{marketplace}}',
    '📱 {{productName}}',
    '',
    'Was:     {{oldPrice}}',
    'Now:     {{newPrice}}',
    'Change:  {{changeArrow}} {{changePct}}',
    '',
    '🔗 {{link}}',
    '⏰ {{time}}',
  ].join('\n'),
  price_change: [
    '{{emoji}} <b>{{typeLabel}}</b> — {{marketplace}}',
    '📱 {{productName}}',
    '',
    'Was:     {{oldPrice}}',
    'Now:     {{newPrice}}',
    'Change:  {{changeArrow}} {{changePct}}',
    '',
    '🔗 {{link}}',
    '⏰ {{time}}',
  ].join('\n'),
  offer_change: [
    '{{emoji}} <b>{{typeLabel}}</b> — {{marketplace}}',
    '📱 {{productName}}',
    '',
    'Price:   {{price}}',
    '',
    'Old offers:',
    '{{oldOffers}}',
    '',
    'New offers:',
    '{{newOffers}}',
    '',
    '🔗 {{link}}',
    '⏰ {{time}}',
  ].join('\n'),
  back_in_stock: [
    '{{emoji}} <b>{{typeLabel}}</b> — {{marketplace}}',
    '📱 {{productName}}',
    '',
    'Now available at {{price}}',
    '',
    '🔗 {{link}}',
    '⏰ {{time}}',
  ].join('\n'),
  auto_paused: [
    '{{emoji}} <b>{{typeLabel}}</b> — {{marketplace}}',
    '📱 {{productName}}',
    '',
    '{{failureReason}}.',
    'Paused after {{failureCount}} consecutive failed checks. Resume it once the listing looks right.',
    '',
    '🔗 {{link}}',
    '⏰ {{time}}',
  ].join('\n'),
  system_health: [
    '{{emoji}} <b>{{typeLabel}}</b>',
    '',
    '{{healthMessage}}',
    '',
    '⏰ {{time}}',
  ].join('\n'),
};

/** Variables available to a template of the given alert type (for the editor palette). */
export interface TemplateVariable {
  name: string;
  description: string;
}

const COMMON_VARS: TemplateVariable[] = [
  { name: 'emoji', description: 'Status emoji for this alert' },
  { name: 'typeLabel', description: 'Human label, e.g. “Price changed”' },
  { name: 'productName', description: 'Product display name' },
  { name: 'marketplace', description: 'Amazon India / Flipkart' },
  { name: 'link', description: 'Tappable “Open on <marketplace>” link (hides the long URL)' },
  { name: 'url', description: 'Raw listing URL (shows the full link text)' },
  { name: 'time', description: 'When the alert fired (your timezone)' },
];
const PRICE_VARS: TemplateVariable[] = [
  { name: 'oldPrice', description: 'Previous price' },
  { name: 'newPrice', description: 'New price' },
  { name: 'price', description: 'Current price' },
  { name: 'changePct', description: 'Percentage change (no sign)' },
  { name: 'changeArrow', description: '▲ up / ▼ down' },
  { name: 'changeSign', description: '+ or −' },
];
const OFFER_VARS: TemplateVariable[] = [
  { name: 'price', description: 'Current price' },
  { name: 'oldOffers', description: 'Previous offers (bulleted list)' },
  { name: 'newOffers', description: 'Current offers (bulleted list)' },
  { name: 'addedOffers', description: 'Offers that appeared' },
  { name: 'removedOffers', description: 'Offers that disappeared' },
];

export function templateVariablesFor(type: AlertType): TemplateVariable[] {
  switch (type) {
    case 'target_price':
      return [...COMMON_VARS, ...PRICE_VARS, { name: 'target', description: 'Your target price' }];
    case 'threshold_drop':
    case 'price_change':
      return [...COMMON_VARS, ...PRICE_VARS];
    case 'offer_change':
      return [...COMMON_VARS, ...OFFER_VARS];
    case 'back_in_stock':
      return [...COMMON_VARS, { name: 'price', description: 'Current price' }];
    case 'auto_paused':
      return [
        ...COMMON_VARS,
        { name: 'failureReason', description: 'Why it failed' },
        { name: 'failureCount', description: 'Consecutive failed checks' },
      ];
    case 'system_health':
      return [
        { name: 'emoji', description: 'Status emoji' },
        { name: 'typeLabel', description: 'Human label' },
        { name: 'healthMessage', description: 'The health message' },
        { name: 'time', description: 'When it fired' },
      ];
  }
}

const EMOJI: Record<AlertType, string> = {
  target_price: '🎯',
  threshold_drop: '📉',
  price_change: '↕️',
  offer_change: '🏷️',
  back_in_stock: '📦',
  auto_paused: '⚠️',
  system_health: '🩺',
};

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function money(v: unknown): string {
  const n = num(v);
  return n === null ? '—' : formatInr(n);
}

function offerList(value: unknown): string {
  const offers = Array.isArray(value) ? (value as Offer[]) : [];
  if (offers.length === 0) return 'No offers';
  return offers.map((o) => `• ${escapeHtml(o.description)}`).join('\n');
}

function formatTime(date: Date, timezone: string): string {
  const s = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
    timeZone: timezone,
  }).format(date);
  return s.replace(/\b(am|pm)\b/i, (m) => m.toUpperCase());
}

/** Compute every template variable's value for an alert. */
export function buildAlertVariables(
  input: AlertMessageInput,
  timezone = 'Asia/Kolkata',
): Record<string, string> {
  const oldVal = (input.oldValue ?? {}) as Record<string, unknown>;
  const newVal = (input.newValue ?? {}) as Record<string, unknown>;

  const oldP = num(oldVal.price);
  const newP = num(newVal.price);
  let changePct = input.changePct;
  if (changePct === null && oldP !== null && newP !== null && oldP !== 0) {
    changePct = Math.round(((newP - oldP) / oldP) * 1000) / 10;
  }
  const direction =
    newP !== null && oldP !== null ? Math.sign(newP - oldP) : Math.sign(changePct ?? 0);

  let emoji = EMOJI[input.type];
  let typeLabel = ALERT_TYPE_LABELS[input.type];
  if (input.type === 'price_change') {
    emoji = direction > 0 ? '🟡' : '🟢';
    typeLabel = direction > 0 ? 'Price Increased' : 'Price Decreased';
  }

  return {
    emoji,
    typeLabel,
    productName: escapeHtml(input.productName),
    marketplace: MARKETPLACE_LABELS[input.marketplace],
    url: escapeHtml(input.listingUrl),
    link: input.listingUrl
      ? `<a href="${escapeHtml(input.listingUrl)}">Open on ${MARKETPLACE_LABELS[input.marketplace]}</a>`
      : '',
    time: formatTime(input.firedAt, timezone),
    oldPrice: money(oldVal.price),
    newPrice: money(newVal.price),
    price: money(newVal.price ?? oldVal.price),
    changePct: changePct === null ? '—' : `${Math.abs(changePct)}%`,
    changeArrow: direction > 0 ? '▲' : direction < 0 ? '▼' : '■',
    changeSign: direction > 0 ? '+' : direction < 0 ? '−' : '',
    target: money(newVal.target),
    oldOffers: offerList(oldVal.offers),
    newOffers: offerList(newVal.offers),
    addedOffers: offerList(newVal.added),
    removedOffers: offerList(newVal.removed),
    failureReason:
      FAILURE_REASON_LABELS[newVal.failureReason as FailureReason] ?? 'Repeated failures',
    failureCount: String(num(newVal.consecutiveFailures) ?? 0),
    healthMessage: escapeHtml(String(newVal.message ?? 'Attention needed')),
  };
}

/** Substitute `{{variable}}` placeholders; unknown names render empty. */
export function applyTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
}

export function renderAlertMessage(input: AlertMessageInput, opts: RenderOptions = {}): string {
  const template =
    opts.template && opts.template.trim() ? opts.template : DEFAULT_TEMPLATES[input.type];
  return applyTemplate(template, buildAlertVariables(input, opts.timezone)).trimEnd();
}

/** Realistic sample data so the editor can render a live preview per type. */
export function sampleAlertInput(type: AlertType): AlertMessageInput {
  const base = {
    type,
    productName: 'Apple iPhone 16 (Black, 128 GB)',
    marketplace: 'flipkart' as Marketplace,
    listingUrl: 'https://www.flipkart.com/apple-iphone-16-black-128-gb/p/itmb07d67f995271',
    changePct: null as number | null,
    firedAt: new Date('2026-07-01T01:51:00+05:30'),
    oldValue: {} as unknown,
    newValue: {} as unknown,
  };
  const offers: Offer[] = [
    { type: 'cashback', description: 'Flipkart Axis — Credit Card • Cashback — ₹3,495 off' },
    { type: 'cashback', description: 'Flipkart SBI — Credit Card • Cashback — ₹3,495 off' },
    { type: 'cashback', description: 'Paytm — UPI • Cashback — ₹50 off' },
  ];
  switch (type) {
    case 'target_price':
      return {
        ...base,
        changePct: -7.7,
        oldValue: { price: 74900 },
        newValue: { price: 64900, target: 65000 },
      };
    case 'threshold_drop':
      return {
        ...base,
        changePct: -7.7,
        oldValue: { price: 69900 },
        newValue: { price: 64900, thresholdPct: 5 },
      };
    case 'price_change':
      return { ...base, changePct: 7.7, oldValue: { price: 64900 }, newValue: { price: 69900 } };
    case 'offer_change':
      return {
        ...base,
        oldValue: { offers: [] },
        newValue: { offers, added: offers, removed: [], price: 69900 },
      };
    case 'back_in_stock':
      return {
        ...base,
        oldValue: { stockStatus: 'out_of_stock' },
        newValue: { stockStatus: 'in_stock', price: 69900 },
      };
    case 'auto_paused':
      return { ...base, newValue: { failureReason: 'fetch_blocked', consecutiveFailures: 5 } };
    case 'system_health':
      return {
        ...base,
        productName: 'PricePulse',
        newValue: { message: 'Worker heartbeat is stale — checks may be delayed.' },
      };
  }
}

export function renderTestMessage(now: Date = new Date()): string {
  return `✅ <b>PricePulse test notification</b>\nYour Telegram configuration works. Sent at ${now.toISOString()}.`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
