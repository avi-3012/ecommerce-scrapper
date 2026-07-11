import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowDownRight,
  Bell,
  CheckCircle2,
  Clock,
  Package,
  Plus,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { api, inr, relTime } from '../api.js';
import type { AlertRow, Paged, SystemStatusReport } from '../api.js';
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
          sub={`${status.products.active} active · ${status.products.pausedUser + status.products.pausedAuto} paused`}
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
