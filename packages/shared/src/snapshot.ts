import type { Marketplace, OfferType, StockStatus } from './enums.js';

/** A single normalized promotional offer on a listing. */
export interface Offer {
  type: OfferType;
  description: string;
}

/**
 * The normalized output of every marketplace adapter (Milestone 1, WP-1.1) and
 * the exact shape the registration preview card renders (FR-1.3).
 * `provenance` records which extraction strategy produced each field —
 * consumed by scraper-health monitoring.
 */
export interface ProductSnapshot {
  marketplace: Marketplace;
  marketplaceProductId: string;
  name: string;
  /** Selling price in rupees. */
  price: number;
  /** Listed MRP in rupees; may equal price when no strikethrough is shown. */
  mrp: number;
  /** Derived: (mrp - price) / mrp, as a percentage rounded to 2 decimals. */
  discountPct: number;
  offers: Offer[];
  stockStatus: StockStatus;
  imageUrl: string | null;
  provenance: Record<string, string>;
}

export function computeDiscountPct(price: number, mrp: number): number {
  if (mrp <= 0 || price >= mrp) return 0;
  return Math.round(((mrp - price) / mrp) * 10000) / 100;
}
