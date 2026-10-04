/** Shared composite components extracted to kill drift (resolves UI-UX-GAPS §6.2). */
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { inrDelta } from './api.js';
import { IconButton, Select } from './ui.js';

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

/** Page sizes offered where a long list is paged. */
export const PAGE_SIZES = [25, 50, 100, 200] as const;

/**
 * A pager that stays on screen: which rows these are, how many there are in
 * all, and how many to show at once. It rides the bottom of the viewport while
 * the list scrolls — above the tab bar on a phone — and settles under the last
 * row at the end of the page.
 */
export function PagerBar({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
  leading,
  children,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (p: number) => void;
  onPageSize: (size: number) => void;
  /** Placed before the row count — e.g. a select-this-page checkbox. */
  leading?: ReactNode;
  /** A row above the pager in the same bar — e.g. what to do with a selection. */
  children?: ReactNode;
}): JSX.Element | null {
  if (total === 0) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), totalPages);
  const first = (current - 1) * pageSize + 1;
  const last = Math.min(current * pageSize, total);
  // One row on a phone: the words and the first/last jumps only from `sm` up.
  return (
    <div className="sticky bottom-[4.25rem] z-20 md:bottom-4">
      <div className="rounded-xl border border-line bg-card/90 text-sm text-fg-muted shadow-pop backdrop-blur">
        {children && <div className="border-b border-line px-3 py-2">{children}</div>}
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-3 py-1.5 sm:gap-x-4 sm:py-2">
          <div className="flex items-center gap-3">
            {leading}
            <p className="nums whitespace-nowrap">
              <span className="hidden sm:inline">Showing </span>
              <span className="font-medium text-fg">
                {first}–{last}
              </span>{' '}
              of <span className="font-medium text-fg">{total}</span>
            </p>
          </div>
          <div className="flex items-center gap-0.5 sm:gap-1">
            <span className="hidden sm:contents">
              <IconButton
                icon={ChevronsLeft}
                label="First page"
                disabled={current <= 1}
                onClick={() => onPage(1)}
              />
            </span>
            <IconButton
              icon={ChevronLeft}
              label="Previous page"
              disabled={current <= 1}
              onClick={() => onPage(current - 1)}
            />
            <span className="nums whitespace-nowrap px-1">
              <span className="hidden sm:inline">
                Page {current} of {totalPages}
              </span>
              <span className="sm:hidden">
                {current} / {totalPages}
              </span>
            </span>
            <IconButton
              icon={ChevronRight}
              label="Next page"
              disabled={current >= totalPages}
              onClick={() => onPage(current + 1)}
            />
            <span className="hidden sm:contents">
              <IconButton
                icon={ChevronsRight}
                label="Last page"
                disabled={current >= totalPages}
                onClick={() => onPage(totalPages)}
              />
            </span>
          </div>
          <label className="flex items-center gap-2">
            <span className="hidden sm:inline">Per page</span>
            <Select
              aria-label="Products per page"
              value={pageSize}
              onChange={(e) => onPageSize(Number(e.target.value))}
              className="h-8"
            >
              {PAGE_SIZES.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </Select>
          </label>
        </div>
      </div>
    </div>
  );
}

/**
 * A checkbox that can also say "some": checked when all of a set is selected,
 * mixed when part of it is. A native input, so it keeps the keyboard and
 * screen-reader behaviour of one.
 */
export function TriStateCheckbox({
  checked,
  mixed = false,
  label,
  onChange,
  className = '',
}: {
  checked: boolean;
  mixed?: boolean;
  label: string;
  onChange: () => void;
  className?: string;
}): JSX.Element {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = mixed && !checked;
  }, [mixed, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label={label}
      title={label}
      checked={checked}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
      className={`size-4 shrink-0 cursor-pointer accent-brand ${className}`}
    />
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
