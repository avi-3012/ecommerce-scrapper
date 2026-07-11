import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { api, errorMessage, relTime } from '../api.js';
import type { AlertRow, Paged } from '../api.js';
import { useToast } from '../toast.js';
import { Badge, Button, Card, CardSkeleton, EmptyState, MarketplaceBadge, Select } from '../ui.js';
import { Pagination } from '../components.js';
import { alertSummary } from './Dashboard.js';

const TYPE_LABELS: Record<string, string> = {
  target_price: '🎯 Target price',
  threshold_drop: '📉 Price drop',
  price_change: '↕️ Price change',
  offer_change: '🏷️ Offer change',
  back_in_stock: '📦 Back in stock',
  auto_paused: '⚠️ Auto-paused',
  system_health: '🩺 System health',
};

export function AlertsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const queryClient = useQueryClient();
  const toast = useToast();
  const queryString = params.toString();

  const { data, isLoading } = useQuery({
    queryKey: ['alerts', queryString],
    queryFn: () => api<Paged<AlertRow>>(`/alerts?${queryString}`),
    refetchInterval: 30_000,
  });

  const retry = useMutation({
    mutationFn: (id: string) => api(`/alerts/${id}/retry`, { method: 'POST' }),
    onSuccess: () => toast.success('Re-queued for delivery.'),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: ['alerts'] }),
  });

  function setFilter(key: string, value: string): void {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    if (key !== 'page') next.delete('page');
    setParams(next, { replace: true });
  }

  const page = Number(params.get('page') ?? '1');
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold text-fg">
        Alert log {data ? <span className="text-fg-subtle">({data.total})</span> : ''}
      </h1>

      <Card className="flex flex-wrap gap-2 p-2.5">
        <Select
          value={params.get('type') ?? ''}
          onChange={(e) => setFilter('type', e.target.value)}
        >
          <option value="">All types</option>
          {Object.entries(TYPE_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </Select>
        <Select
          value={params.get('deliveryStatus') ?? ''}
          onChange={(e) => setFilter('deliveryStatus', e.target.value)}
        >
          <option value="">Any delivery status</option>
          <option value="delivered">Delivered</option>
          <option value="failed">Failed</option>
          <option value="pending">Pending</option>
          <option value="suppressed">Suppressed</option>
          <option value="held_quiet_hours">Held</option>
        </Select>
      </Card>

      {isLoading ? (
        <CardSkeleton rows={6} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No alerts here"
          hint="Alerts appear when prices move, offers change, or products need attention."
        />
      ) : (
        <ul className="space-y-2">
          {data.items.map((a) => (
            <Card key={a.id} className="p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <span className="text-sm">{TYPE_LABELS[a.type] ?? a.type}</span>{' '}
                  <span className="font-medium text-fg">{a.product?.displayName ?? 'System'}</span>
                  <p className="text-sm text-fg-muted">{alertSummary(a)}</p>
                </div>
                <div className="flex items-center gap-2">
                  {a.product && <MarketplaceBadge marketplace={a.product.marketplace} />}
                  <DeliveryBadge alert={a} />
                  <span className="text-xs text-fg-subtle">{relTime(a.firedAt)}</span>
                  {a.deliveryStatus === 'failed' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={retry.isPending && retry.variables === a.id}
                      onClick={() => retry.mutate(a.id)}
                    >
                      Retry
                    </Button>
                  )}
                </div>
              </div>
              {a.deliveryStatus === 'failed' && a.deliveryError && (
                <p className="mt-1 text-xs text-danger-fg">Delivery failed: {a.deliveryError}</p>
              )}
            </Card>
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        onPage={(p) => setFilter('page', String(p))}
      />
    </div>
  );
}

function DeliveryBadge({ alert }: { alert: AlertRow }): JSX.Element {
  switch (alert.deliveryStatus) {
    case 'delivered':
      return <Badge tone="success">✓ delivered</Badge>;
    case 'failed':
      return <Badge tone="danger">✕ delivery failed</Badge>;
    case 'held_quiet_hours':
      return <Badge tone="neutral">held (quiet hours)</Badge>;
    case 'suppressed':
      return <Badge tone="neutral">suppressed (cooldown)</Badge>;
    default:
      return <Badge tone="warning">pending</Badge>;
  }
}
