/**
 * Guards the contract that Prisma enums and @pricepulse/shared enums never
 * drift: shared is the vocabulary the whole system speaks; the database
 * must speak the same one.
 */
import { describe, expect, it } from 'vitest';
import {
  Marketplace,
  ProductStatus,
  StockStatus,
  AlertType,
  DeliveryStatus,
  FailureReason,
  ExtractionTier,
  PriorityTier,
} from '@prisma/client';
import {
  MARKETPLACES,
  PRODUCT_STATUSES,
  STOCK_STATUSES,
  ALERT_TYPES,
  DELIVERY_STATUSES,
  FAILURE_REASONS,
  EXTRACTION_TIERS,
  PRIORITY_TIERS,
} from '@pricepulse/shared';

describe('Prisma ↔ shared enum parity', () => {
  const cases: Array<[string, Record<string, string>, readonly string[]]> = [
    ['Marketplace', Marketplace, MARKETPLACES],
    ['ProductStatus', ProductStatus, PRODUCT_STATUSES],
    ['StockStatus', StockStatus, STOCK_STATUSES],
    ['AlertType', AlertType, ALERT_TYPES],
    ['DeliveryStatus', DeliveryStatus, DELIVERY_STATUSES],
    ['FailureReason', FailureReason, FAILURE_REASONS],
    ['ExtractionTier', ExtractionTier, EXTRACTION_TIERS],
    ['PriorityTier', PriorityTier, PRIORITY_TIERS],
  ];

  it.each(cases)('%s values match', (_name, prismaEnum, sharedValues) => {
    expect(Object.values(prismaEnum).sort()).toEqual([...sharedValues].sort());
  });
});
