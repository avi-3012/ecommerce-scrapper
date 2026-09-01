import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Gauge, Layers, RefreshCw, Repeat } from 'lucide-react';
import { api } from '../api.js';
import type { ProxyUsageProduct, ProxyUsageReport } from '../api.js';
import { useTheme } from '../theme.js';
import {
  Button,
  Card,
  CardSkeleton,
  EmptyState,
  MarketplaceBadge,
  Select,
  Skeleton,
  StatCard,
} from '../ui.js';

/**
 * Where the scraping bandwidth goes, per product. Wire (compressed) bytes —
 * what actually crossed the connection — broken down by request kind, so a
 * single expensive product (or the browser tier) is obvious at a glance.
 *
 * These were proxy-billed bytes before the identity migration; they are now
 * ordinary ISP bytes. Per-product attribution is still the number that answers
 * "which products are expensive to watch", so the report stayed.
 */

/** Fixed categorical order (validated CVD-safe, light+dark) — never reordered. */
const KINDS = [
  { key: 'httpPage', label: 'Page (HTTP)', light: '#2a78d6', dark: '#3987e5' },
  { key: 'browserPage', label: 'Page (browser)', light: '#eb6834', dark: '#d95926' },
  { key: 'pincodeApi', label: 'Pincode API', light: '#1baf7a', dark: '#199e70' },
  { key: 'cookieMint', label: 'Cookie mint', light: '#eda100', dark: '#c98500' },
  { key: 'sideSheet', label: 'Side-sheet', light: '#e87ba4', dark: '#d55181' },
] as const;

type KindKey = (typeof KINDS)[number]['key'];

function fmtBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(2)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(0)} KB`;
  return `${bytes} B`;
}

export function BandwidthPage(): JSX.Element {
  const [days, setDays] = useState(14);
  const { theme } = useTheme();
  const color = (k: (typeof KINDS)[number]): string => (theme === 'dark' ? k.dark : k.light);

  const { data, isLoading } = useQuery({
    queryKey: ['proxy-usage', days],
    queryFn: () => api<ProxyUsageReport>(`/analytics/proxy?days=${days}`),
    refetchInterval: 60_000,
  });

  const header = (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h1 className="text-2xl font-semibold text-fg">Bandwidth</h1>
      <div className="flex items-center gap-2">
        <Select
          value={days}
          onChange={(e) => setDays(Number(e.target.value))}
          aria-label="Time window"
          className="w-auto"
        >
          <option value={1}>Last 24 hours</option>
          <option value={7}>Last 7 days</option>
          <option value={14}>Last 14 days</option>
          <option value={30}>Last 30 days</option>
        </Select>
        <a href={`/api/export/proxy-usage.csv?days=${days}`}>
          <Button variant="secondary" icon={Download}>
            CSV
          </Button>
        </a>
      </div>
    </div>
  );

  if (isLoading || !data) {
    return (
      <div className="space-y-6">
        {header}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <CardSkeleton rows={6} />
      </div>
    );
  }

  const t = data.totals;
  const perDay = t.wireBytes / data.windowDays;
  const tier2Pct = t.scrapes ? Math.round((t.tier2 / t.scrapes) * 100) : 0;
  const okPct = t.scrapes ? Math.round((t.ok / t.scrapes) * 100) : 0;

  return (
    <div className="space-y-6">
      {header}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Wire transferred"
          value={fmtBytes(t.wireBytes)}
          icon={Gauge}
          tone="brand"
          sub={`≈ ${fmtBytes(perDay)}/day · ${data.windowDays}-day window`}
        />
        <StatCard
          label="Checks"
          value={t.scrapes.toLocaleString()}
          icon={RefreshCw}
          tone="info"
          sub={`${okPct}% succeeded · ${t.failed.toLocaleString()} failed`}
        />
        <StatCard
          label="Browser tier"
          value={`${tier2Pct}%`}
          icon={Layers}
          tone="warning"
          sub={`${t.tier2.toLocaleString()} of ${t.scrapes.toLocaleString()} checks`}
        />
        <StatCard
          label="Retries"
          value={t.retries.toLocaleString()}
          icon={Repeat}
          tone="neutral"
          sub="extra proxied attempts"
        />
      </div>

      {/* Where it goes — fleet composition by request kind */}
      <Card className="p-4">
        <h2 className="text-sm font-medium text-fg">Where the bandwidth goes</h2>
        <StackedBar total={t.wireBytes} value={(k) => t[k]} color={color} className="mt-3" />
        <ul className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 sm:grid-cols-3">
          {KINDS.map((k) => {
            const bytes = t[k.key];
            const pct = t.wireBytes ? Math.round((bytes / t.wireBytes) * 100) : 0;
            return (
              <li key={k.key} className="flex items-center gap-2 text-sm">
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: color(k) }}
                  aria-hidden
                />
                <span className="text-fg-muted">{k.label}</span>
                <span className="nums ml-auto text-fg-subtle">
                  {fmtBytes(bytes)} · {pct}%
                </span>
              </li>
            );
          })}
        </ul>
      </Card>

      {/* Per-product table */}
      {data.products.length === 0 ? (
        <EmptyState
          icon={Gauge}
          title="No bandwidth recorded yet"
          hint="Usage appears after the next round of checks writes to the scrape-audit trail."
        />
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-fg-subtle">
                  <th className="px-4 py-2 font-medium">Product</th>
                  <th className="px-3 py-2 text-right font-medium">Checks</th>
                  <th className="px-3 py-2 text-right font-medium">Retries</th>
                  <th className="px-3 py-2 text-right font-medium">Tier-2</th>
                  <th className="px-3 py-2 text-right font-medium">KB/check</th>
                  <th className="px-3 py-2 text-right font-medium">Wire</th>
                  <th className="w-40 px-4 py-2 font-medium">Breakdown</th>
                </tr>
              </thead>
              <tbody>
                {data.products.map((p) => (
                  <ProductRow key={p.productId} p={p} color={color} />
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function ProductRow({
  p,
  color,
}: {
  p: ProxyUsageProduct;
  color: (k: (typeof KINDS)[number]) => string;
}): JSX.Element {
  const kbPerCheck = p.scrapes ? Math.round(p.wireBytes / p.scrapes / 1024) : 0;
  return (
    <tr className="border-b border-line last:border-0 hover:bg-surface-2">
      <td className="max-w-[280px] px-4 py-2.5">
        <div className="flex items-center gap-2">
          {p.marketplace && <MarketplaceBadge marketplace={p.marketplace} />}
          <span className="truncate text-fg" title={p.displayName}>
            {p.displayName}
          </span>
        </div>
      </td>
      <td className="nums px-3 py-2.5 text-right text-fg-muted">
        {p.scrapes}
        {p.failed > 0 && <span className="text-danger-fg"> · {p.failed}✕</span>}
      </td>
      <td className="nums px-3 py-2.5 text-right text-fg-muted">{p.retries || '—'}</td>
      <td className="nums px-3 py-2.5 text-right text-fg-muted">{p.tier2 || '—'}</td>
      <td className="nums px-3 py-2.5 text-right text-fg-muted">{kbPerCheck}</td>
      <td className="nums px-3 py-2.5 text-right font-medium text-fg">{fmtBytes(p.wireBytes)}</td>
      <td className="px-4 py-2.5">
        <StackedBar total={p.wireBytes} value={(k) => p[k]} color={color} thin />
      </td>
    </tr>
  );
}

/** Horizontal stacked composition bar with a 2px surface gap between segments. */
function StackedBar({
  total,
  value,
  color,
  className = '',
  thin = false,
}: {
  total: number;
  value: (k: KindKey) => number;
  color: (k: (typeof KINDS)[number]) => string;
  className?: string;
  thin?: boolean;
}): JSX.Element {
  if (total <= 0) {
    return <div className={`${thin ? 'h-2' : 'h-3'} rounded-full bg-surface-2 ${className}`} />;
  }
  return (
    <div
      className={`flex ${thin ? 'h-2' : 'h-3'} gap-[2px] overflow-hidden rounded-full ${className}`}
    >
      {KINDS.map((k) => {
        const pct = (value(k.key) / total) * 100;
        if (pct <= 0) return null;
        return (
          <div
            key={k.key}
            style={{ width: `${pct}%`, backgroundColor: color(k) }}
            title={`${k.label}: ${fmtBytes(value(k.key))}`}
          />
        );
      })}
    </div>
  );
}
