/**
 * Typed API client (WP-2.2 rule 3): one fetch wrapper, credentials included,
 * 401 → login redirect, uniform error shape surfaced to forms.
 */
import type {
  AlertType,
  DeliveryStatus,
  FailureReason,
  Marketplace,
  Offer,
  ProductStatus,
  StockStatus,
} from '@pricepulse/shared';

export interface ApiError {
  status: number;
  message: string;
  errors?: Array<{ field: string; message: string }>;
  impact?: { historyCount: number; alertCount: number };
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers:
      init?.body && !(init.body instanceof FormData)
        ? { 'Content-Type': 'application/json' }
        : undefined,
    ...init,
  });
  if (res.status === 401 && !path.startsWith('/auth/')) {
    window.location.href = '/login';
    throw Object.assign(new Error('Signed out'), { status: 401 });
  }
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err: ApiError = {
      status: res.status,
      message: (body as { message?: string })?.message ?? `Request failed (${res.status})`,
      ...(body as object),
    };
    throw err;
  }
  return body as T;
}

// ── Response types (mirror the API; shared enums come from @pricepulse/shared) ──

/** A user-defined product category (never scraped). */
export interface Category {
  id: string;
  name: string;
  color: string | null;
  productCount: number;
}

/** Category as embedded on a product (no count). */
export type CategoryRef = Pick<Category, 'id' | 'name' | 'color'>;

export interface Product {
  id: string;
  marketplace: Marketplace;
  url: string;
  canonicalUrl: string;
  displayName: string;
  imageUrl: string | null;
  tags: string[];
  categoryId: string | null;
  category: CategoryRef | null;
  notes: string;
  targetPrice: string | null;
  dropThresholdPct: string | null;
  status: ProductStatus;
  consecutiveFailures: number;
  currentPrice: string | null;
  currentMrp: string | null;
  currentDiscountPct: string | null;
  currentOffers: Offer[];
  currentStockStatus: StockStatus;
  allTimeLow: string | null;
  allTimeHigh: string | null;
  linkedProductId: string | null;
  lastCheckedAt: string | null;
  lastSuccessAt: string | null;
  lastChangedAt: string | null;
  createdAt: string;
}

/** FR-5.5: current price at or within the near-low margin of the recorded low. */
export function isNearLow(p: Product, marginPct = 2): boolean {
  if (p.currentPrice === null || p.allTimeLow === null) return false;
  return Number(p.currentPrice) <= Number(p.allTimeLow) * (1 + marginPct / 100);
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface HistoryRow {
  id: string;
  checkedAt: string;
  success: boolean;
  price: string | null;
  mrp: string | null;
  discountPct: string | null;
  offers: Offer[];
  stockStatus: StockStatus;
  failureReason: FailureReason | null;
  failureDetail: string | null;
  extractionTier: 'http' | 'browser' | null;
}

export interface AlertRow {
  id: string;
  productId: string | null;
  type: AlertType;
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  changePct: string | null;
  firedAt: string;
  deliveryStatus: DeliveryStatus;
  deliveryError: string | null;
  deliveredAt: string | null;
  message: string | null;
  product: { displayName: string; marketplace: Marketplace; url: string } | null;
}

export interface TemplateVariable {
  name: string;
  description: string;
}

/** A per-alert-type notification template (custom override + built-in default). */
export interface NotificationTemplate {
  type: AlertType;
  label: string;
  /** The user's custom template; '' means the default is in use. */
  template: string;
  default: string;
  variables: TemplateVariable[];
}

export interface SystemStatusReport {
  products: {
    total: number;
    active: number;
    pausedUser: number;
    pausedAuto: number;
    failing: number;
  };
  alertsLast24h: number;
  dropsLast24h: number;
  lastCycle: {
    startedAt: string | null;
    endedAt: string | null;
    due: number;
    succeeded: number;
    failed: number;
  } | null;
  successRate7d: string | null;
  workerHeartbeatAt: string | null;
  workerStale: boolean;
}

export interface SettingsView {
  checkIntervalMinutes: number;
  globalDropThresholdPct: string;
  consecutiveFailureLimit: number;
  monitoringPaused: boolean;
  alertTargetPrice: boolean;
  alertThresholdDrop: boolean;
  alertAnyChange: boolean;
  alertOfferChange: boolean;
  alertBackInStock: boolean;
  timezone: string;
  telegramBotTokenSet: boolean;
  telegramChatId: string | null;
  cooldownMinutes: number;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
  quietHoursHoldHealth: boolean;
  digestFrequency: 'off' | 'daily' | 'weekly';
  digestTime: string | null;
  nearLowThresholdPct: string;
  pincode: string | null;
}

export interface PreviewSnapshot {
  marketplace: Marketplace;
  marketplaceProductId: string;
  name: string;
  price: number | null;
  mrp: number | null;
  discountPct: number;
  offers: Offer[];
  stockStatus: StockStatus;
  imageUrl: string | null;
  provenance: Record<string, string>;
}

export type PreviewResult =
  | {
      kind: 'preview';
      snapshot: PreviewSnapshot;
      url: string;
      canonicalUrl: string;
      marketplace: Marketplace;
      productId: string;
    }
  | { kind: 'duplicate'; existingId: string; displayName: string; status: string }
  | { kind: 'unsupported'; detectedSite: string | null }
  | { kind: 'not_a_listing'; marketplace: Marketplace }
  | { kind: 'fetch_failed'; reason: string; message: string };

export interface ChartData {
  points: Array<{ t: string; price: number | null; mrp: number | null; outOfStock: boolean }>;
  failures: Array<{ t: string; reason: FailureReason | null }>;
  stats: { allTimeLow: number | null; allTimeHigh: number | null; average: number | null };
}

export interface CompareData {
  a: { product: Product; points: Array<{ t: string; price: number | null }> };
  b: { product: Product; points: Array<{ t: string; price: number | null }> };
}

export interface ImportReview {
  filename: string;
  totalRows: number;
  valid: Array<Record<string, unknown> & { rowNumber: number; url: string; name?: string }>;
  duplicates: Array<{ rowNumber: number; url: string; reason: string }>;
  invalid: Array<{ rowNumber: number; url: string; reason: string }>;
}

export function inr(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  const num = typeof value === 'string' ? Number(value) : value;
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(num);
}

/** Signed percentage for price-change chips, e.g. "-12.5%" / "+3%". */
export function inrDelta(pct: number): string {
  const sign = pct > 0 ? '+' : '';
  return `${sign}${Math.round(pct * 10) / 10}%`;
}

export function relTime(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** Extract a display message from any thrown error (fetch errors are ApiError-shaped). */
export function errorMessage(err: unknown): string {
  return (err as { message?: string })?.message ?? 'Something went wrong';
}
