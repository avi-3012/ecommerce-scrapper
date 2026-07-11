/** Shared composite components extracted to kill drift (resolves UI-UX-GAPS §6.2). */
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { inrDelta } from './api.js';
import { IconButton } from './ui.js';

/** The PricePulse logo mark — a pulse/price wave in a rounded tile (resolves §1.1). */
export function Logo({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <span
      className="inline-flex items-center justify-center rounded-lg bg-brand text-brand-fg"
      style={{ width: size, height: size }}
      aria-hidden
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 24 24" fill="none">
        <path
          d="M2 14h4l2.5-8 4 16 3-11 2 3h4.5"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </span>
  );
}

export function Wordmark(): JSX.Element {
  return (
    <span className="flex items-center gap-2">
      <Logo />
      <span className="text-lg font-semibold tracking-tight text-fg">PricePulse</span>
    </span>
  );
}

export function Pagination({
  page,
  totalPages,
  onPage,
}: {
  page: number;
  totalPages: number;
  onPage: (p: number) => void;
}): JSX.Element | null {
  if (totalPages <= 1) return null;
  return (
    <div className="flex items-center justify-center gap-3 text-sm text-fg-muted">
      <IconButton
        icon={ChevronLeft}
        label="Previous page"
        disabled={page <= 1}
        onClick={() => onPage(page - 1)}
      />
      <span className="nums">
        Page {page} of {totalPages}
      </span>
      <IconButton
        icon={ChevronRight}
        label="Next page"
        disabled={page >= totalPages}
        onClick={() => onPage(page + 1)}
      />
    </div>
  );
}

/** Colored price-change indicator: down = good (green), up = bad (red). */
export function PriceChange({
  pct,
}: {
  pct: number | string | null | undefined;
}): JSX.Element | null {
  if (pct === null || pct === undefined) return null;
  const n = typeof pct === 'string' ? Number(pct) : pct;
  if (!Number.isFinite(n) || n === 0) return null;
  const down = n < 0;
  return (
    <span className={`nums text-xs font-medium ${down ? 'text-down' : 'text-up'}`}>
      {inrDelta(n)}
    </span>
  );
}
