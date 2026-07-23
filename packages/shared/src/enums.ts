/**
 * Canonical enumerations shared by API, worker, web, and the database layer.
 * Values are stored in PostgreSQL — renaming a value is a data migration.
 */

export const MARKETPLACES = ['amazon_in', 'flipkart'] as const;
export type Marketplace = (typeof MARKETPLACES)[number];

export const MARKETPLACE_LABELS: Record<Marketplace, string> = {
  amazon_in: 'Amazon India',
  flipkart: 'Flipkart',
};

export const PRODUCT_STATUSES = ['active', 'paused_user', 'paused_auto'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

export const STOCK_STATUSES = ['in_stock', 'out_of_stock', 'unknown'] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const ALERT_TYPES = [
  'target_price',
  'threshold_drop',
  'price_change',
  // Deprecated: superseded by offer_added / offer_removed. Kept so historical
  // alerts still resolve a label/template; never emitted for new checks.
  'offer_change',
  'offer_added',
  'offer_removed',
  'back_in_stock',
  'auto_paused',
  'system_health',
] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

/**
 * The offer alert that is no longer generated. It stays in the enum for
 * historical rows but is hidden from the settings/template editor UI.
 */
export const DEPRECATED_ALERT_TYPES: readonly AlertType[] = ['offer_change'];

export const DELIVERY_STATUSES = [
  'pending',
  'delivered',
  'failed',
  'held_quiet_hours',
  'suppressed',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Fixed failure taxonomy (Milestone 1 doc, WP-1.4). */
export const FAILURE_REASONS = [
  'fetch_blocked',
  'fetch_timeout',
  'http_error',
  'parse_failed',
  'listing_removed',
  'captcha',
  'other',
] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** User-facing phrasing for each failure category (never show raw categories to the user). */
export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  fetch_blocked: 'The marketplace temporarily blocked automated access',
  fetch_timeout: 'The marketplace did not respond in time',
  http_error: 'The marketplace returned an error',
  parse_failed: 'The page layout has changed; maintenance may be required',
  listing_removed: 'The listing appears to have been removed',
  captcha: 'The marketplace presented a verification challenge',
  other: 'An unexpected error occurred',
};

export const EXTRACTION_TIERS = ['http', 'browser'] as const;
export type ExtractionTier = (typeof EXTRACTION_TIERS)[number];

export const PRIORITY_TIERS = ['normal', 'high'] as const;
export type PriorityTier = (typeof PRIORITY_TIERS)[number];

export const OFFER_TYPES = [
  'bank_offer',
  'no_cost_emi',
  // Bank/card EMI offers that carry a discount (Flipkart's "EMI offers" section),
  // distinct from genuinely-interest-free "No Cost EMI".
  'emi',
  'cashback',
  'coupon',
  'exchange',
  'partner',
  'other',
] as const;
export type OfferType = (typeof OFFER_TYPES)[number];

/** User-facing label for each offer category (shown as a tag in the UI). */
export const OFFER_TYPE_LABELS: Record<OfferType, string> = {
  bank_offer: 'Bank Offer',
  no_cost_emi: 'No Cost EMI',
  emi: 'EMI Offer',
  cashback: 'Cashback',
  coupon: 'Coupon',
  exchange: 'Exchange',
  partner: 'Partner Offer',
  other: 'Offer',
};
