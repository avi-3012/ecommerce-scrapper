import type { ProductSnapshot } from '@pricepulse/shared';
import { CheckError } from './errors.js';

/**
 * Snapshot sanity rules (WP-1.1 rule 6): a parsed snapshot that violates
 * these is a parse failure, never stored as fact. Keeps garbage out of the
 * permanent history.
 */
export function validateSnapshot(snapshot: ProductSnapshot): ProductSnapshot {
  if (!snapshot.name || snapshot.name.trim().length === 0) {
    throw new CheckError('parse_failed', 'Snapshot has an empty product name');
  }
  if (snapshot.stockStatus === 'in_stock') {
    if (snapshot.price === null || !Number.isFinite(snapshot.price) || snapshot.price <= 0) {
      throw new CheckError(
        'parse_failed',
        `In-stock listing parsed with invalid price ${snapshot.price}`,
      );
    }
  }
  if (
    snapshot.price !== null &&
    snapshot.mrp !== null &&
    snapshot.mrp > 0 &&
    snapshot.price > snapshot.mrp * 1.005
  ) {
    throw new CheckError(
      'parse_failed',
      `Selling price ${snapshot.price} exceeds MRP ${snapshot.mrp} beyond tolerance`,
    );
  }
  return snapshot;
}
