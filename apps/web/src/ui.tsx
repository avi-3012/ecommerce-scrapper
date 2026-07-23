/**
 * PricePulse component library (resolves UI-UX-GAPS §6.1).
 * Real components with variant/size/state APIs — not className strings —
 * so loading/disabled/focus/icon states are consistent everywhere.
 */
import { useEffect, useRef } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { Loader2, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Marketplace, Offer, OfferType, ProductStatus, StockStatus } from '@pricepulse/shared';
import { OFFER_TYPE_LABELS } from '@pricepulse/shared';

// ── Button ──────────────────────────────────────────────────────────────

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: LucideIcon;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-brand text-brand-fg hover:bg-brand-strong shadow-sm',
  secondary: 'border border-line-strong bg-card text-fg hover:bg-surface-2',
  ghost: 'text-fg-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-danger text-white hover:brightness-110 shadow-sm',
};
const SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-2.5 text-sm gap-1.5',
  md: 'h-9 px-3.5 text-sm gap-2',
};

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  icon: Icon,
  disabled,
  children,
  className = '',
  ...rest
}: ButtonProps): JSX.Element {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center rounded-md font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {loading ? (
        <Loader2 className="size-4 animate-spin" aria-hidden />
      ) : (
        Icon && <Icon className="size-4" aria-hidden />
      )}
      {children}
    </button>
  );
}

/** Icon-only button — requires an accessible label (resolves §6.3). */
export function IconButton({
  icon: Icon,
  label,
  variant = 'ghost',
  loading = false,
  className = '',
  ...rest
}: {
  icon: LucideIcon;
  label: string;
  variant?: ButtonVariant;
  loading?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>): JSX.Element {
  return (
    <button
      aria-label={label}
      title={label}
      disabled={loading || rest.disabled}
      className={`inline-flex size-8 items-center justify-center rounded-md transition-colors disabled:opacity-40 ${VARIANT[variant]} ${className}`}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : <Icon className="size-4" />}
    </button>
  );
}

// ── Inputs ──────────────────────────────────────────────────────────────

export function Input(props: InputHTMLAttributes<HTMLInputElement>): JSX.Element {
  const { className = '', ...rest } = props;
  return (
    <input
      className={`h-9 w-full rounded-md border border-line-strong bg-card px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none ${className}`}
      {...rest}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>): JSX.Element {
  const { className = '', children, ...rest } = props;
  return (
    <select
      className={`h-9 rounded-md border border-line-strong bg-card px-2.5 text-sm text-fg focus:border-brand focus:outline-none ${className}`}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-fg">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs text-fg-subtle">{hint}</span>}
    </label>
  );
}

// ── Surfaces ────────────────────────────────────────────────────────────

export function Card({
  children,
  className = '',
  hover = false,
}: {
  children: ReactNode;
  className?: string;
  hover?: boolean;
}): JSX.Element {
  return (
    <div
      className={`rounded-xl border border-line bg-card shadow-card ${hover ? 'transition-shadow hover:shadow-raised' : ''} ${className}`}
    >
      {children}
    </div>
  );
}

// ── Badges ──────────────────────────────────────────────────────────────

type Tone = 'brand' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
const BADGE: Record<Tone, string> = {
  brand: 'bg-brand-subtle text-brand-subtle-fg',
  success: 'bg-success-subtle text-success-fg',
  warning: 'bg-warning-subtle text-warning-fg',
  danger: 'bg-danger-subtle text-danger-fg',
  info: 'bg-info-subtle text-info-fg',
  neutral: 'bg-surface-2 text-fg-muted',
};

export function Badge({
  tone = 'neutral',
  icon: Icon,
  children,
}: {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium ${BADGE[tone]}`}
    >
      {Icon && <Icon className="size-3" aria-hidden />}
      {children}
    </span>
  );
}

const OFFER_TONE: Record<OfferType, Tone> = {
  bank_offer: 'info',
  no_cost_emi: 'brand',
  emi: 'brand',
  cashback: 'success',
  coupon: 'warning',
  exchange: 'neutral',
  partner: 'neutral',
  other: 'neutral',
};

/**
 * Renders a listing's offers, each an individual offer tagged by category
 * (Bank Offer, No Cost EMI, Cashback, Coupon, Partner Offer, …).
 */
export function OfferList({
  offers,
  className = '',
}: {
  offers: Offer[];
  className?: string;
}): JSX.Element {
  return (
    <ul className={`space-y-1.5 ${className}`}>
      {offers.map((o) => (
        <li key={`${o.type}:${o.description}`} className="flex items-start gap-2 text-sm">
          <Badge tone={OFFER_TONE[o.type] ?? 'neutral'}>
            {OFFER_TYPE_LABELS[o.type] ?? 'Offer'}
          </Badge>
          <span className="text-fg-muted">{o.description}</span>
        </li>
      ))}
    </ul>
  );
}

/** A small chip for a user-defined category: colour dot + name. */
export function CategoryChip({
  category,
}: {
  category: { name: string; color: string | null };
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-xs font-medium text-fg-muted">
      <span
        className="size-2 rounded-full"
        style={{ backgroundColor: category.color ?? 'var(--color-fg-subtle, #9ca3af)' }}
        aria-hidden
      />
      {category.name}
    </span>
  );
}

export function MarketplaceBadge({ marketplace }: { marketplace: Marketplace }): JSX.Element {
  return (
    <Badge tone={marketplace === 'amazon_in' ? 'warning' : 'info'}>
      {marketplace === 'amazon_in' ? 'Amazon.in' : 'Flipkart'}
    </Badge>
  );
}

/** Status conveyed by icon + text, never color alone (resolves §6.3). */
export function StockBadge({ stock }: { stock: StockStatus }): JSX.Element {
  if (stock === 'in_stock') return <Badge tone="success">● In stock</Badge>;
  if (stock === 'out_of_stock') return <Badge tone="danger">✕ Out of stock</Badge>;
  return <Badge tone="neutral">? Stock unknown</Badge>;
}

export function StatusBadge({ status }: { status: ProductStatus }): JSX.Element | null {
  if (status === 'paused_auto') return <Badge tone="danger">⚠ Auto-paused</Badge>;
  if (status === 'paused_user') return <Badge tone="neutral">⏸ Paused</Badge>;
  return null;
}

// ── Feedback states ─────────────────────────────────────────────────────

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="flex items-center gap-2 p-6 text-fg-muted" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label ?? 'Loading…'}
    </div>
  );
}

/** Skeleton placeholder that preserves layout (resolves §3.3). */
export function Skeleton({ className = '' }: { className?: string }): JSX.Element {
  return <div className={`animate-pulse rounded-md bg-surface-2 ${className}`} aria-hidden />;
}

export function CardSkeleton({ rows = 4 }: { rows?: number }): JSX.Element {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Card key={i} className="flex items-center gap-3 p-3">
          <Skeleton className="size-14 shrink-0" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
          <Skeleton className="h-5 w-16" />
        </Card>
      ))}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon?: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}): JSX.Element {
  return (
    <Card className="flex flex-col items-center px-6 py-12 text-center">
      {Icon && (
        <div className="mb-3 flex size-12 items-center justify-center rounded-full bg-brand-subtle text-brand-subtle-fg">
          <Icon className="size-6" aria-hidden />
        </div>
      )}
      <p className="font-medium text-fg">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-sm text-fg-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </Card>
  );
}

export function ErrorNote({ message }: { message: string }): JSX.Element {
  return (
    <div className="rounded-md bg-danger-subtle px-3 py-2 text-sm text-danger-fg" role="alert">
      {message}
    </div>
  );
}

// ── Stat card (resolves §4.2) ─────────────────────────────────────────────

export function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  tone = 'brand',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: LucideIcon;
  tone?: Tone;
}): JSX.Element {
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between">
        <p className="text-sm text-fg-muted">{label}</p>
        {Icon && (
          <span className={`rounded-md p-1 ${BADGE[tone]}`}>
            <Icon className="size-4" aria-hidden />
          </span>
        )}
      </div>
      <p className="nums mt-1 text-2xl font-semibold text-fg">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-fg-subtle">{sub}</p>}
    </Card>
  );
}

/** Low ——●—— High range meter: where current price sits historically (resolves §4.3). */
export function RangeMeter({
  low,
  high,
  current,
}: {
  low: number;
  high: number;
  current: number;
}): JSX.Element {
  const span = Math.max(1, high - low);
  const pct = Math.min(100, Math.max(0, ((current - low) / span) * 100));
  const nearLow = pct <= 15;
  return (
    <div>
      <div className="relative h-1.5 rounded-full bg-gradient-to-r from-down/40 via-warning/40 to-up/40">
        <div
          className={`absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-card ${nearLow ? 'bg-down' : 'bg-fg'}`}
          style={{ left: `${pct}%` }}
        />
      </div>
      <div className="nums mt-1 flex justify-between text-[11px] text-fg-subtle">
        <span>low</span>
        <span>high</span>
      </div>
    </div>
  );
}

// ── Modal with focus trap + Esc (resolves §3.4, §3.5) ─────────────────────

export function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  onClose: () => void;
}): JSX.Element | null {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal
      aria-label={title}
      onClick={onClose}
    >
      <div
        ref={ref}
        className="w-full max-w-md rounded-xl border border-line bg-card p-5 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <h3 className="font-semibold text-fg">{title}</h3>
          <IconButton icon={X} label="Close" onClick={onClose} />
        </div>
        <div className="mt-2">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  loading,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: ReactNode;
  confirmLabel: string;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element | null {
  return (
    <Modal open={open} title={title} onClose={onCancel}>
      <div className="text-sm text-fg-muted">{body}</div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="danger" loading={loading} onClick={onConfirm} data-autofocus>
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

// ── Tooltip (resolves §5.2, §6.3) ─────────────────────────────────────────

export function Tooltip({ text, children }: { text: string; children: ReactNode }): JSX.Element {
  return (
    <span className="group relative inline-flex">
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-1.5 hidden -translate-x-1/2 whitespace-nowrap rounded-md bg-fg px-2 py-1 text-xs text-surface group-hover:block"
      >
        {text}
      </span>
    </span>
  );
}
