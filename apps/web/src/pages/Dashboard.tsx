import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ArrowDownRight,
  Bell,
  CheckCircle2,
  Clock,
  Download,
  Package,
  Plus,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { api, inr, relTime } from '../api.js';
import type { AlertRow, Paged, ScraperHealth, SystemStatusReport } from '../api.js';
import { Button, Card, CardSkeleton, EmptyState, Skeleton, StatCard } from '../ui.js';

/** Dashboard home (WP-2.3): the UC-9 glance — health banner, stats, activity. */
export function DashboardPage(): JSX.Element {
  const { data: status, isLoading } = useQuery({
    queryKey: ['status'],
    queryFn: () => api<SystemStatusReport>('/status'),
    refetchInterval: 30_000,
  });
  const { data: alerts } = useQuery({
    queryKey: ['alerts', 'recent'],
    queryFn: () => api<Paged<AlertRow>>('/alerts?pageSize=8'),
    refetchInterval: 30_000,
  });

  if (isLoading || !status) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-semibold text-fg">Dashboard</h1>
        <Skeleton className="h-20 w-full" />
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <CardSkeleton rows={4} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-fg">Dashboard</h1>

      <HealthBanner status={status} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Products tracked"
          value={status.products.total}
          icon={Package}
          tone="brand"
          sub={
            // Capacity is the number that matters when it is set: "active" and
            // "being checked" stop being the same thing above the line.
            (status.products.capacity
              ? `${status.products.scraped} of ${status.products.capacity} being checked` +
                (status.products.waiting > 0
                  ? ` · ${status.products.waiting} waiting on priority`
                  : '')
              : `${status.products.active} active`) +
            ` · ${status.products.pausedUser + status.products.pausedAuto} paused` +
            (status.products.max
              ? ` · ${status.products.total}/${status.products.max} of limit`
              : '')
          }
        />
        <StatCard label="Alerts (24h)" value={status.alertsLast24h} icon={Bell} tone="info" />
        <StatCard
          label="Price drops (24h)"
          value={status.dropsLast24h}
          icon={ArrowDownRight}
          tone="success"
        />
        <StatCard
          label="Last monitoring run"
          value={status.lastCycle?.endedAt ? relTime(status.lastCycle.endedAt) : '—'}
          icon={Clock}
          tone="neutral"
          sub={status.successRate7d !== null ? `${status.successRate7d}% success (7d)` : undefined}
        />
      </div>

      {status.scraper ? <ScraperPanel health={status.scraper} /> : null}

      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium text-fg">Recent activity</h2>
          <Link to="/alerts" className="text-sm font-medium text-brand-subtle-fg hover:underline">
            Full alert log →
          </Link>
        </div>
        {!alerts || alerts.items.length === 0 ? (
          <EmptyState
            icon={status.products.total === 0 ? Package : Bell}
            title={status.products.total === 0 ? 'Track your first product' : 'No alerts yet'}
            hint={
              status.products.total === 0
                ? 'Paste a listing URL from Amazon India or Flipkart to start monitoring prices and offers.'
                : 'Alerts will appear here as prices move, offers change, or products need attention.'
            }
            action={
              status.products.total === 0 ? (
                <Link to="/products/add">
                  <Button variant="primary" icon={Plus}>
                    Add a product
                  </Button>
                </Link>
              ) : undefined
            }
          />
        ) : (
          <Card>
            <ul className="divide-y divide-line">
              {alerts.items.map((a) => (
                <li
                  key={a.id}
                  className="flex items-center justify-between gap-3 px-4 py-2.5 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-fg">
                      {a.product?.displayName ?? 'System'}
                    </span>{' '}
                    <span className="text-fg-muted">{alertSummary(a)}</span>
                  </div>
                  <span className="shrink-0 text-xs text-fg-subtle">{relTime(a.firedAt)}</span>
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}

function HealthBanner({ status }: { status: SystemStatusReport }): JSX.Element {
  if (status.workerStale) {
    return (
      <Card className="flex items-start gap-3 border-danger/40 bg-danger-subtle p-4">
        <XCircle className="mt-0.5 size-5 shrink-0 text-danger-fg" aria-hidden />
        <div>
          <p className="font-medium text-danger-fg">Monitoring is not running</p>
          <p className="mt-1 text-sm text-danger-fg/90">
            The monitoring worker hasn't reported since{' '}
            {status.workerHeartbeatAt ? relTime(status.workerHeartbeatAt) : 'it was last started'}.
            Prices are not being checked. If this persists for more than a few minutes, the
            maintainer may be needed.
          </p>
        </div>
      </Card>
    );
  }
  const attention = status.products.pausedAuto + status.products.failing;
  if (attention > 0) {
    return (
      <Card className="flex items-start gap-3 border-warning/40 bg-warning-subtle p-4">
        <TriangleAlert className="mt-0.5 size-5 shrink-0 text-warning-fg" aria-hidden />
        <div>
          <p className="font-medium text-warning-fg">
            Monitoring is running — some products need attention
          </p>
          <p className="mt-1 text-sm text-warning-fg/90">
            {status.products.pausedAuto > 0 && (
              <>
                <Link to="/products?health=auto_paused" className="underline">
                  {status.products.pausedAuto} auto-paused
                </Link>{' '}
                after repeated failures.{' '}
              </>
            )}
            {status.products.failing > 0 && (
              <>
                <Link to="/products?health=failing" className="underline">
                  {status.products.failing} failing recent checks
                </Link>
                .
              </>
            )}{' '}
            Everything else is monitored normally.
          </p>
        </div>
      </Card>
    );
  }
  return (
    <Card className="flex items-start gap-3 border-success/40 bg-success-subtle p-4">
      <CheckCircle2 className="mt-0.5 size-5 shrink-0 text-success-fg" aria-hidden />
      <div>
        <p className="font-medium text-success-fg">Monitoring is running normally</p>
        <p className="mt-1 text-sm text-success-fg/90">
          {status.lastCycle?.endedAt
            ? `Last run ${relTime(status.lastCycle.endedAt)}: ${status.lastCycle.succeeded} checked successfully${status.lastCycle.failed ? `, ${status.lastCycle.failed} failed` : ''}.`
            : 'Waiting for the first monitoring run.'}
        </p>
      </div>
    </Card>
  );
}

export function alertSummary(a: AlertRow): string {
  const nv = a.newValue ?? {};
  switch (a.type) {
    case 'target_price':
      return `hit its target — now ${inr(nv.price as number)}`;
    case 'threshold_drop':
      return `dropped ${a.changePct}% to ${inr(nv.price as number)}`;
    case 'price_change':
      return `changed ${a.changePct}% to ${inr(nv.price as number)}`;
    case 'offer_change':
      return 'offers changed';
    case 'offer_added': {
      const added = (nv.added as unknown[] | undefined)?.length ?? 0;
      return `${added} new offer${added === 1 ? '' : 's'}`;
    }
    case 'offer_removed': {
      const removed = (nv.removed as unknown[] | undefined)?.length ?? 0;
      return `${removed} offer${removed === 1 ? '' : 's'} removed`;
    }
    case 'back_in_stock':
      return 'is back in stock';
    case 'auto_paused':
      return 'was auto-paused after repeated failures';
    case 'system_health':
      return 'system health notice';
    default:
      return a.type;
  }
}

/**
 * The scraper's vitals.
 *
 * Everything here is a property of the CONNECTION rather than of any product,
 * and none of it was visible from the dashboard before — the only way to know
 * the marketplaces had started pushing back was to notice prices going stale
 * days later. The two ratios are the ones that matter: blocks mean they are
 * refusing us, congestion means they are struggling to serve us, and the
 * responses are different.
 */
function ScraperPanel({ health }: { health: ScraperHealth }): JSX.Element {
  const pausedUntil = health.pausedUntil;
  const paused = pausedUntil !== null && pausedUntil > Date.now();
  // Vitals are published on the worker's 30 s heartbeat. Much older than that
  // means the worker is wedged or gone — and rendering old numbers as if they
  // were live is worse than rendering nothing, because it reads as healthy.
  const ageMs = health.at ? Date.now() - new Date(health.at).getTime() : null;
  const stale = ageMs === null || ageMs > 150_000;
  const tone =
    stale || paused || health.blockRatio > 2
      ? 'danger'
      : health.congestionRatio > 15
        ? 'warning'
        : 'ok';
  const toneClass =
    tone === 'danger'
      ? 'border-danger bg-danger-subtle'
      : tone === 'warning'
        ? 'border-warning bg-warning-subtle'
        : 'border-border bg-surface';

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h2 className="font-medium text-fg">Scraper</h2>
        <DiagnosticsButton />
      </div>
      <div className={`rounded-lg border p-4 ${toneClass}`}>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <Metric
            label="Rate"
            value={`${health.ratePerMin}/min`}
            sub={
              health.mode === 'adaptive' ? `ceiling ${health.learnedPerMin}/min` : 'fixed budget'
            }
          />
          <Metric
            label="Used"
            value={`${health.usedLastMinute}/min`}
            sub={`${health.usedLastHour} in the last hour`}
          />
          <Metric
            label="Identities"
            value={health.identities}
            sub={health.cooling > 0 ? `${health.cooling} cooling` : 'all in service'}
          />
          <Metric
            label="Blocked"
            value={`${health.blockRatio}%`}
            sub="they refused us"
            danger={health.blockRatio > 2}
          />
          <Metric
            label="Congestion"
            value={`${health.congestionRatio}%`}
            sub="timeouts / errors"
            danger={health.congestionRatio > 15}
          />
          <Metric
            label="Unreadable"
            value={health.unreadable}
            sub="parsed nothing"
            danger={health.unreadable > 20}
          />
        </div>
        {stale ? (
          <p className="mt-3 text-sm font-medium text-danger-fg">
            These numbers are{' '}
            {ageMs === null ? 'of unknown age' : `${Math.round(ageMs / 60_000)} minutes old`} — the
            worker has stopped publishing them. Everything above is what it last reported, not what
            is happening now. Check the worker is running, then download the logs.
          </p>
        ) : health.killSwitch ? (
          <p className="mt-3 text-sm font-medium text-danger-fg">
            Fetching is stopped by the PAUSE kill switch. Remove the PAUSE file (or unset PAUSE=1)
            to resume.
          </p>
        ) : paused ? (
          <p className="mt-3 text-sm font-medium text-danger-fg">
            Fetching is paused until {new Date(pausedUntil!).toLocaleTimeString()} — backing off
            after repeated blocks (level {health.backoffLevel}). It resumes on its own.
          </p>
        ) : (
          <p className="mt-3 text-xs text-fg-muted">
            {health.isNight ? 'Night pacing' : 'Daytime pacing'} · running at{' '}
            {Math.round(health.diurnalFactor * 100)}% of the learned ceiling for this hour
            {health.suspectsPending > 0
              ? ` · ${health.suspectsPending} price${health.suspectsPending === 1 ? '' : 's'} awaiting a second opinion`
              : ''}
          </p>
        )}
      </div>
    </section>
  );
}

function Metric({
  label,
  value,
  sub,
  danger = false,
}: {
  label: string;
  value: string | number;
  sub?: string;
  danger?: boolean;
}): JSX.Element {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-fg-muted">{label}</div>
      <div className={`text-lg font-semibold ${danger ? 'text-danger-fg' : 'text-fg'}`}>
        {value}
      </div>
      {sub ? <div className="text-xs text-fg-muted">{sub}</div> : null}
    </div>
  );
}

/**
 * One button, one file, everything needed to diagnose a broken run.
 *
 * A plain link rather than a fetch: the endpoint sets Content-Disposition, so
 * the browser saves it directly and there is no blob to build, no memory spike
 * on a large bundle, and no way for a failed download to leave the page in a
 * half-broken state.
 */
function DiagnosticsButton(): JSX.Element {
  const [hours, setHours] = useState(6);
  return (
    <div className="flex items-center gap-2">
      <label className="text-xs text-fg-muted" htmlFor="diag-window">
        last
      </label>
      <select
        id="diag-window"
        className="rounded border border-border bg-surface px-2 py-1 text-xs text-fg"
        value={hours}
        onChange={(e) => setHours(Number(e.target.value))}
      >
        <option value={1}>1 hour</option>
        <option value={6}>6 hours</option>
        <option value={24}>24 hours</option>
        <option value={72}>3 days</option>
      </select>
      <a
        href={`/api/diagnostics?hours=${hours}`}
        download
        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-3 py-1.5 text-sm font-medium text-fg hover:bg-surface-2"
      >
        <Download className="size-4" aria-hidden />
        Download logs
      </a>
    </div>
  );
}
