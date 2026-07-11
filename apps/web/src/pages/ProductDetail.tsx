import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { FAILURE_REASON_LABELS } from '@pricepulse/shared';
import { api, errorMessage, inr, isNearLow, relTime } from '../api.js';
import type { ApiError, ChartData, CompareData, HistoryRow, Paged, Product } from '../api.js';
import { useToast } from '../toast.js';
import {
  Button,
  Card,
  CardSkeleton,
  ErrorNote,
  Field,
  IconButton,
  Input,
  MarketplaceBadge,
  Modal,
  RangeMeter,
  Skeleton,
  StatusBadge,
  StockBadge,
} from '../ui.js';
import { ComparisonChart, PriceHistoryChart } from '../PriceChart.js';

const WINDOWS = [7, 30, 90, 3650] as const;

export function ProductDetailPage(): JSX.Element {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const [windowDays, setWindowDays] = useState<number>(30);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [failedOnly, setFailedOnly] = useState(false);
  const [impact, setImpact] = useState<{ historyCount: number; alertCount: number } | null>(null);

  const { data: product, isLoading } = useQuery({
    queryKey: ['product', id],
    queryFn: () => api<Product>(`/products/${id}`),
    refetchInterval: 60_000,
  });
  const { data: chart } = useQuery({
    queryKey: ['chart', id, windowDays],
    queryFn: () => api<ChartData>(`/products/${id}/chart?days=${windowDays}`),
  });
  const { data: history } = useQuery({
    queryKey: ['history', id, failedOnly],
    queryFn: () =>
      api<Paged<HistoryRow>>(
        `/products/${id}/history?pageSize=50${failedOnly ? '&failedOnly=true' : ''}`,
      ),
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['product', id] });
    void queryClient.invalidateQueries({ queryKey: ['history', id] });
    void queryClient.invalidateQueries({ queryKey: ['products'] });
  };

  const action = useMutation({
    mutationFn: (verb: 'pause' | 'resume' | 'check') =>
      api(`/products/${id}/${verb}`, { method: 'POST' }),
    onSuccess: (_r, verb) =>
      toast.success(
        verb === 'check' ? 'Check queued — results arrive shortly.' : `Product ${verb}d.`,
      ),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: invalidate,
  });
  const edit = useMutation({
    mutationFn: (changes: Record<string, unknown>) =>
      api(`/products/${id}`, { method: 'PATCH', body: JSON.stringify(changes) }),
    onSuccess: () => {
      toast.success('Saved.');
      invalidate();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: () => api(`/products/${id}?confirm=true`, { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Product deleted.');
      navigate('/products');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  // Fetch the real deletion impact (resolves §3.4) — the unconfirmed DELETE returns counts.
  async function openDeleteDialog(): Promise<void> {
    try {
      await api(`/products/${id}`, { method: 'DELETE' });
    } catch (err) {
      setImpact((err as ApiError).impact ?? { historyCount: 0, alertCount: 0 });
    }
    setConfirmingDelete(true);
  }

  if (isLoading || !product) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-72 w-full" />
        <CardSkeleton rows={3} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-4">
          {product.imageUrl ? (
            <img src={product.imageUrl} alt="" className="size-20 rounded-lg object-contain" />
          ) : (
            <div className="flex size-20 items-center justify-center rounded-lg bg-surface-2 text-2xl">
              📦
            </div>
          )}
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-fg">{product.displayName}</h1>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <MarketplaceBadge marketplace={product.marketplace} />
              <StockBadge stock={product.currentStockStatus} />
              <StatusBadge status={product.status} />
              <a
                href={product.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-brand-subtle-fg hover:underline"
              >
                Open live listing <ExternalLink className="size-3.5" />
              </a>
            </div>
            <p className="nums mt-2 text-2xl font-semibold text-fg">
              {inr(product.currentPrice)}{' '}
              {product.currentMrp &&
                Number(product.currentMrp) > Number(product.currentPrice ?? 0) && (
                  <span className="text-sm font-normal text-fg-subtle">
                    <s>{inr(product.currentMrp)}</s> · {product.currentDiscountPct}% off
                  </span>
                )}
            </p>
            <p className="mt-0.5 text-xs text-fg-subtle">
              Last checked {relTime(product.lastCheckedAt)} · last change{' '}
              {relTime(product.lastChangedAt)}
            </p>
          </div>
        </div>
        <div className="flex gap-1.5">
          <Button
            variant="secondary"
            icon={RefreshCw}
            loading={action.isPending}
            onClick={() => action.mutate('check')}
          >
            Check now
          </Button>
          {product.status === 'active' ? (
            <IconButton
              icon={Pause}
              label="Pause"
              variant="secondary"
              onClick={() => action.mutate('pause')}
            />
          ) : (
            <IconButton
              icon={Play}
              label="Resume"
              variant="secondary"
              onClick={() => action.mutate('resume')}
            />
          )}
          <IconButton
            icon={Trash2}
            label="Delete"
            variant="secondary"
            onClick={() => void openDeleteDialog()}
          />
        </div>
      </div>

      {/* Price chart */}
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium text-fg">Price history</h2>
          <div className="flex gap-1 rounded-lg bg-surface-2 p-0.5">
            {WINDOWS.map((d) => (
              <button
                key={d}
                onClick={() => setWindowDays(d)}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  windowDays === d ? 'bg-card text-fg shadow-sm' : 'text-fg-muted hover:text-fg'
                }`}
              >
                {d === 3650 ? 'All' : `${d}d`}
              </button>
            ))}
          </div>
        </div>
        {!chart || chart.points.length === 0 ? (
          <p className="py-12 text-center text-sm text-fg-subtle">
            No successful checks in this window yet.
          </p>
        ) : (
          <PriceHistoryChart
            chart={chart}
            targetPrice={product.targetPrice ? Number(product.targetPrice) : null}
          />
        )}
        {chart && chart.failures.length > 0 && (
          <p className="mt-2 text-xs text-warning-fg">
            {chart.failures.length} failed check{chart.failures.length === 1 ? '' : 's'} in this
            window (marked in red) — gaps in the line are explained in the check history below.
          </p>
        )}
        {chart?.stats && chart.stats.allTimeLow !== null && (
          <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-[1fr_auto] sm:items-center">
            <div className="nums flex flex-wrap gap-x-4 gap-y-1 text-sm text-fg-muted">
              <span>
                Recorded low <b className="text-down">{inr(chart.stats.allTimeLow)}</b>
              </span>
              <span>
                Average <b className="text-fg">{inr(chart.stats.average)}</b>
              </span>
              <span>
                High <b className="text-fg">{inr(chart.stats.allTimeHigh)}</b>
              </span>
            </div>
            {chart.stats.allTimeHigh !== null &&
              chart.stats.allTimeHigh > chart.stats.allTimeLow &&
              product.currentPrice !== null && (
                <div className="w-full sm:w-48">
                  <RangeMeter
                    low={chart.stats.allTimeLow}
                    high={chart.stats.allTimeHigh}
                    current={Number(product.currentPrice)}
                  />
                </div>
              )}
          </div>
        )}
        {isNearLow(product) && (
          <div className="mt-3 rounded-md bg-success-subtle px-3 py-2 text-sm text-success-fg">
            🔥 The current price is at or near the lowest PricePulse has ever recorded for this
            product.
          </div>
        )}
      </Card>

      <CompareSection product={product} onChange={invalidate} />

      <EditPanel
        product={product}
        onSave={(c) => edit.mutate(c)}
        saving={edit.isPending}
        error={null}
      />

      {product.currentOffers.length > 0 && (
        <Card className="p-4">
          <h2 className="mb-2 font-medium text-fg">Current offers</h2>
          <ul className="space-y-1 text-sm text-fg-muted">
            {product.currentOffers.map((o) => (
              <li key={o.description} className="flex gap-2">
                <span aria-hidden>🏷️</span>
                {o.description}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Check history */}
      <Card className="p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium text-fg">Check history</h2>
          <label className="flex items-center gap-1.5 text-sm text-fg-muted">
            <input
              type="checkbox"
              checked={failedOnly}
              onChange={(e) => setFailedOnly(e.target.checked)}
            />
            Failures only
          </label>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-fg-subtle">
                <th className="py-2 pr-4 font-medium">When</th>
                <th className="py-2 pr-4 font-medium">Outcome</th>
                <th className="py-2 pr-4 font-medium">Price</th>
                <th className="py-2 pr-4 font-medium">Stock</th>
                <th className="py-2 font-medium">Detail</th>
              </tr>
            </thead>
            <tbody>
              {(history?.items ?? []).map((row) => (
                <tr key={row.id} className="border-b border-line/60">
                  <td className="nums whitespace-nowrap py-2 pr-4 text-fg-muted">
                    {new Date(row.checkedAt).toLocaleString('en-IN')}
                  </td>
                  <td className="py-2 pr-4">
                    {row.success ? (
                      <span className="text-success-fg">✓ ok</span>
                    ) : (
                      <span className="text-danger-fg">✕ failed</span>
                    )}
                  </td>
                  <td className="nums py-2 pr-4 text-fg">
                    {row.price !== null ? inr(row.price) : '—'}
                  </td>
                  <td className="py-2 pr-4 text-fg-muted">
                    {row.stockStatus === 'in_stock'
                      ? 'in stock'
                      : row.stockStatus === 'out_of_stock'
                        ? 'out of stock'
                        : '—'}
                  </td>
                  <td className="py-2 text-fg-subtle">
                    {row.success
                      ? row.offers.length > 0
                        ? `${row.offers.length} offer${row.offers.length === 1 ? '' : 's'}`
                        : ''
                      : ((row.failureReason
                          ? FAILURE_REASON_LABELS[row.failureReason]
                          : row.failureDetail) ?? '')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {history && history.items.length === 0 && (
            <p className="py-4 text-center text-sm text-fg-subtle">
              {failedOnly ? 'No failed checks — good.' : 'No checks yet.'}
            </p>
          )}
        </div>
      </Card>

      <Modal
        open={confirmingDelete}
        title={`Delete “${product.displayName}”?`}
        onClose={() => setConfirmingDelete(false)}
      >
        <p className="text-sm text-fg-muted">
          This permanently removes the product
          {impact
            ? `, its ${impact.historyCount} price record${impact.historyCount === 1 ? '' : 's'}, and its ${impact.alertCount} alert${impact.alertCount === 1 ? '' : 's'}`
            : ' and all its history and alerts'}
          . This cannot be undone.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmingDelete(false)}>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.isPending} onClick={() => remove.mutate()}>
            Delete permanently
          </Button>
        </div>
      </Modal>
    </div>
  );
}

function CompareSection({
  product,
  onChange,
}: {
  product: Product;
  onChange: () => void;
}): JSX.Element {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [linking, setLinking] = useState(false);
  const [otherId, setOtherId] = useState('');

  const { data: compare } = useQuery({
    queryKey: ['compare', product.id, product.linkedProductId],
    queryFn: () => api<CompareData>(`/products/${product.id}/compare?days=90`),
    enabled: product.linkedProductId !== null,
  });
  const otherMarketplace = product.marketplace === 'amazon_in' ? 'flipkart' : 'amazon_in';
  const { data: candidates } = useQuery({
    queryKey: ['products', 'link-candidates', otherMarketplace],
    queryFn: () => api<Paged<Product>>(`/products?marketplace=${otherMarketplace}&pageSize=100`),
    enabled: linking,
  });

  const link = useMutation({
    mutationFn: () =>
      api(`/products/${product.id}/link`, { method: 'POST', body: JSON.stringify({ otherId }) }),
    onSuccess: () => {
      toast.success('Products linked.');
      setLinking(false);
      onChange();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const unlink = useMutation({
    mutationFn: () => api(`/products/${product.id}/unlink`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Unlinked.');
      void queryClient.invalidateQueries({ queryKey: ['compare'] });
      onChange();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  if (product.linkedProductId && compare) {
    const a = compare.a.product;
    const b = compare.b.product;
    const priceA = a.currentPrice !== null ? Number(a.currentPrice) : null;
    const priceB = b.currentPrice !== null ? Number(b.currentPrice) : null;
    const cheaper =
      priceA !== null && priceB !== null
        ? priceA < priceB
          ? 'a'
          : priceB < priceA
            ? 'b'
            : null
        : null;
    return (
      <Card className="p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium text-fg">Cross-platform comparison</h2>
          <Button variant="ghost" size="sm" onClick={() => unlink.mutate()}>
            Unlink
          </Button>
        </div>
        <div className="mb-4 grid grid-cols-2 gap-3">
          {[compare.a, compare.b].map((side, i) => {
            const isCheaper = cheaper === (i === 0 ? 'a' : 'b');
            return (
              <div
                key={side.product.id}
                className={`rounded-lg border p-3 ${isCheaper ? 'border-success bg-success-subtle' : 'border-line'}`}
              >
                <MarketplaceBadge marketplace={side.product.marketplace} />
                <p className="nums mt-1 text-lg font-semibold text-fg">
                  {inr(side.product.currentPrice)}
                </p>
                {isCheaper && (
                  <span className="text-xs font-medium text-success-fg">cheaper now</span>
                )}
              </div>
            );
          })}
        </div>
        <ComparisonChart
          seriesA={compare.a.points}
          seriesB={compare.b.points}
          labelA={a.marketplace === 'amazon_in' ? 'Amazon.in' : 'Flipkart'}
          labelB={b.marketplace === 'amazon_in' ? 'Amazon.in' : 'Flipkart'}
        />
      </Card>
    );
  }

  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="font-medium text-fg">Cross-platform comparison</h2>
          <p className="text-sm text-fg-muted">
            Link this product to its {otherMarketplace === 'amazon_in' ? 'Amazon.in' : 'Flipkart'}{' '}
            listing to compare prices side by side.
          </p>
        </div>
        {!linking && (
          <Button variant="secondary" onClick={() => setLinking(true)}>
            Link listing
          </Button>
        )}
      </div>
      {linking && (
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <div className="min-w-60 flex-1">
            <Field
              label={`Choose a tracked ${otherMarketplace === 'amazon_in' ? 'Amazon.in' : 'Flipkart'} product`}
            >
              <select
                value={otherId}
                onChange={(e) => setOtherId(e.target.value)}
                className="h-9 w-full rounded-md border border-line-strong bg-card px-2.5 text-sm text-fg focus:border-brand focus:outline-none"
              >
                <option value="">Select a product…</option>
                {candidates?.items
                  .filter((c) => c.linkedProductId === null)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.displayName}
                    </option>
                  ))}
              </select>
            </Field>
          </div>
          <Button
            variant="primary"
            disabled={!otherId}
            loading={link.isPending}
            onClick={() => link.mutate()}
          >
            Link
          </Button>
          <Button variant="ghost" onClick={() => setLinking(false)}>
            Cancel
          </Button>
        </div>
      )}
    </Card>
  );
}

function EditPanel({
  product,
  onSave,
  error,
  saving,
}: {
  product: Product;
  onSave: (changes: Record<string, unknown>) => void;
  error: string | null;
  saving: boolean;
}): JSX.Element {
  const [displayName, setDisplayName] = useState(product.displayName);
  const [targetPrice, setTargetPrice] = useState(product.targetPrice ?? '');
  const [threshold, setThreshold] = useState(product.dropThresholdPct ?? '');
  const [tags, setTags] = useState(product.tags.join(', '));
  const [notes, setNotes] = useState(product.notes);

  return (
    <Card className="p-4">
      <h2 className="mb-3 font-medium text-fg">Settings for this product</h2>
      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Display name">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field
          label="Target price (₹)"
          hint="Raising the target above the current price re-arms the alert for the next drop."
        >
          <Input
            type="number"
            value={targetPrice}
            onChange={(e) => setTargetPrice(e.target.value)}
          />
        </Field>
        <Field label="Drop threshold %" hint="Uses the global default when blank.">
          <Input
            type="number"
            step="0.5"
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </Field>
        <Field label="Tags">
          <Input value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <div className="sm:col-span-2">
          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="w-full rounded-md border border-line-strong bg-card px-3 py-1.5 text-sm text-fg focus:border-brand focus:outline-none"
            />
          </Field>
        </div>
      </div>
      <div className="mt-3 flex justify-end">
        <Button
          variant="primary"
          loading={saving}
          onClick={() =>
            onSave({
              displayName: displayName.trim() || undefined,
              targetPrice: targetPrice === '' ? null : Number(targetPrice),
              dropThresholdPct: threshold === '' ? null : Number(threshold),
              tags: tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean),
              notes,
            })
          }
        >
          Save changes
        </Button>
      </div>
    </Card>
  );
}
