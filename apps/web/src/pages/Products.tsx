import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Flame,
  LayoutGrid,
  Link2,
  List,
  Package,
  Pause,
  Play,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { api, errorMessage, inr, isNearLow, relTime } from '../api.js';
import type { Paged, Product } from '../api.js';
import { useToast } from '../toast.js';
import {
  Badge,
  Button,
  Card,
  CardSkeleton,
  ConfirmDialog,
  EmptyState,
  IconButton,
  MarketplaceBadge,
  RangeMeter,
  Select,
  StatusBadge,
  StockBadge,
} from '../ui.js';
import { Pagination, PriceChange } from '../components.js';

export function ProductsPage(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [view, setView] = useState<'list' | 'grid'>('list');
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const queryString = params.toString();
  const { data, isLoading } = useQuery({
    queryKey: ['products', queryString],
    queryFn: () => api<Paged<Product>>(`/products?${queryString}`),
    refetchInterval: 60_000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['products'] });
    void queryClient.invalidateQueries({ queryKey: ['status'] });
  };

  const action = useMutation({
    mutationFn: ({ id, verb }: { id: string; verb: 'pause' | 'resume' | 'check' }) =>
      api(`/products/${id}/${verb}`, { method: 'POST' }),
    onSuccess: (_r, { verb }) =>
      toast.success(
        verb === 'check' ? 'Check queued — results arrive shortly.' : `Product ${verb}d.`,
      ),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/products/${id}?confirm=true`, { method: 'DELETE' }),
    onSuccess: () => toast.success('Product deleted.'),
    onError: (err) => toast.error(errorMessage(err)),
    onSettled: () => {
      setDeleting(null);
      invalidate();
    },
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
  const pendingId = action.isPending ? action.variables?.id : undefined;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold text-fg">
          Products {data ? <span className="text-fg-subtle">({data.total})</span> : ''}
        </h1>
        <div className="flex gap-2">
          <Button
            variant="secondary"
            icon={RefreshCw}
            onClick={() => {
              void api('/products/check-all', { method: 'POST' });
              toast.info('Queued a check of all products — paced politely.');
            }}
          >
            Check all
          </Button>
          <Link to="/products/add">
            <Button variant="primary" icon={Plus}>
              Add product
            </Button>
          </Link>
        </div>
      </div>

      {/* Search + filters + sort (FR-5.3), URL-encoded so views are linkable */}
      <Card className="flex flex-wrap items-center gap-2 p-2.5">
        <input
          placeholder="Search name or URL…"
          defaultValue={params.get('search') ?? ''}
          onKeyDown={(e) =>
            e.key === 'Enter' && setFilter('search', (e.target as HTMLInputElement).value)
          }
          className="h-9 min-w-52 flex-1 rounded-md border border-line-strong bg-card px-3 text-sm text-fg placeholder:text-fg-subtle focus:border-brand focus:outline-none"
        />
        <Select
          value={params.get('marketplace') ?? ''}
          onChange={(e) => setFilter('marketplace', e.target.value)}
        >
          <option value="">All marketplaces</option>
          <option value="amazon_in">Amazon.in</option>
          <option value="flipkart">Flipkart</option>
        </Select>
        <Select
          value={params.get('stock') ?? ''}
          onChange={(e) => setFilter('stock', e.target.value)}
        >
          <option value="">Any stock</option>
          <option value="in_stock">In stock</option>
          <option value="out_of_stock">Out of stock</option>
        </Select>
        <Select
          value={params.get('health') ?? ''}
          onChange={(e) => setFilter('health', e.target.value)}
        >
          <option value="">Any health</option>
          <option value="healthy">Healthy</option>
          <option value="failing">Failing checks</option>
          <option value="auto_paused">Auto-paused</option>
        </Select>
        <Select
          value={params.get('sort') ?? 'recent'}
          onChange={(e) => setFilter('sort', e.target.value)}
        >
          <option value="recent">Newest</option>
          <option value="recently_changed">Recently changed</option>
          <option value="biggest_drop">Biggest discount</option>
          <option value="price_asc">Price: low → high</option>
          <option value="price_desc">Price: high → low</option>
          <option value="name">Name</option>
        </Select>
        <div className="ml-auto flex gap-1">
          <IconButton
            icon={List}
            label="List view"
            variant={view === 'list' ? 'primary' : 'ghost'}
            onClick={() => setView('list')}
          />
          <IconButton
            icon={LayoutGrid}
            label="Grid view"
            variant={view === 'grid' ? 'primary' : 'ghost'}
            onClick={() => setView('grid')}
          />
        </div>
      </Card>

      {isLoading ? (
        <CardSkeleton rows={6} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState
          icon={Package}
          title={queryString ? 'No products match these filters' : 'No products tracked yet'}
          hint={
            queryString
              ? 'Try clearing the filters to see your whole catalogue.'
              : 'Paste an Amazon India or Flipkart listing URL to start monitoring.'
          }
          action={
            queryString ? (
              <Button variant="secondary" onClick={() => setParams({}, { replace: true })}>
                Clear filters
              </Button>
            ) : (
              <Link to="/products/add">
                <Button variant="primary" icon={Plus}>
                  Add a product
                </Button>
              </Link>
            )
          }
        />
      ) : view === 'grid' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {data.items.map((p) => (
            <ProductGridCard
              key={p.id}
              product={p}
              busy={pendingId === p.id}
              onOpen={() => navigate(`/products/${p.id}`)}
              onAction={(verb) => action.mutate({ id: p.id, verb })}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {data.items.map((p) => (
            <ProductRow
              key={p.id}
              product={p}
              busy={pendingId === p.id}
              onOpen={() => navigate(`/products/${p.id}`)}
              onAction={(verb) => action.mutate({ id: p.id, verb })}
              onDelete={() => setDeleting(p)}
            />
          ))}
        </ul>
      )}

      <Pagination
        page={page}
        totalPages={totalPages}
        onPage={(p) => setFilter('page', String(p))}
      />

      <ConfirmDialog
        open={deleting !== null}
        title={`Delete “${deleting?.displayName}”?`}
        body="This permanently removes the product, its entire price history, and its alerts. This cannot be undone."
        confirmLabel="Delete permanently"
        loading={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}

function Thumb({ product, size }: { product: Product; size: string }): JSX.Element {
  return product.imageUrl ? (
    <img src={product.imageUrl} alt="" className={`${size} shrink-0 rounded-lg object-contain`} />
  ) : (
    <div className={`${size} flex shrink-0 items-center justify-center rounded-lg bg-surface-2`}>
      <Package className="size-6 text-fg-subtle" aria-hidden />
    </div>
  );
}

function MetaBadges({ product }: { product: Product }): JSX.Element {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-1.5">
      <MarketplaceBadge marketplace={product.marketplace} />
      <StockBadge stock={product.currentStockStatus} />
      <StatusBadge status={product.status} />
      {isNearLow(product) && (
        <Badge tone="success" icon={Flame}>
          near recorded low
        </Badge>
      )}
      {product.linkedProductId && (
        <Badge tone="info" icon={Link2}>
          linked
        </Badge>
      )}
      {product.consecutiveFailures > 0 && product.status === 'active' && (
        <span className="text-xs text-warning-fg">{product.consecutiveFailures} failed checks</span>
      )}
    </div>
  );
}

function RowActions({
  product,
  busy,
  onAction,
  onDelete,
}: {
  product: Product;
  busy: boolean;
  onAction: (verb: 'pause' | 'resume' | 'check') => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <div className="flex shrink-0 gap-1">
      <IconButton
        icon={RefreshCw}
        label="Check now"
        loading={busy}
        onClick={() => onAction('check')}
      />
      {product.status === 'active' ? (
        <IconButton icon={Pause} label="Pause" onClick={() => onAction('pause')} />
      ) : (
        <IconButton icon={Play} label="Resume" onClick={() => onAction('resume')} />
      )}
      <IconButton icon={Trash2} label="Delete" onClick={onDelete} />
    </div>
  );
}

function PriceBlock({ product }: { product: Product }): JSX.Element {
  if (product.currentPrice === null) {
    return <p className="text-sm text-fg-subtle">awaiting first check</p>;
  }
  return (
    <div>
      <p className="nums text-lg font-semibold text-fg">{inr(product.currentPrice)}</p>
      {product.currentMrp !== null && Number(product.currentMrp) > Number(product.currentPrice) && (
        <p className="nums text-xs text-fg-subtle">
          <s>{inr(product.currentMrp)}</s> · {product.currentDiscountPct}% off
        </p>
      )}
      {product.targetPrice && (
        <p className="nums text-xs text-brand-subtle-fg">target {inr(product.targetPrice)}</p>
      )}
    </div>
  );
}

function ProductRow({
  product,
  busy,
  onOpen,
  onAction,
  onDelete,
}: {
  product: Product;
  busy: boolean;
  onOpen: () => void;
  onAction: (verb: 'pause' | 'resume' | 'check') => void;
  onDelete: () => void;
}): JSX.Element {
  const low = product.allTimeLow;
  const high = product.allTimeHigh;
  const showMeter =
    low !== null && high !== null && product.currentPrice !== null && Number(high) > Number(low);
  return (
    <Card
      hover
      className={`flex flex-col gap-3 p-3 sm:flex-row sm:items-center ${product.status !== 'active' ? 'opacity-70' : ''}`}
    >
      {/* Product info — takes the full row width on mobile so badges never wrap per-word */}
      <div className="flex min-w-0 flex-1 gap-3">
        <Thumb product={product} size="size-14" />
        <button className="min-w-0 flex-1 text-left" onClick={onOpen}>
          <p className="line-clamp-2 font-medium text-fg hover:text-brand-subtle-fg sm:truncate">
            {product.displayName}
          </p>
          <MetaBadges product={product} />
          <p className="mt-1 text-xs text-fg-subtle">checked {relTime(product.lastCheckedAt)}</p>
        </button>
      </div>

      {showMeter && (
        <div className="hidden w-32 shrink-0 lg:block">
          <RangeMeter
            low={Number(low)}
            high={Number(high)}
            current={Number(product.currentPrice)}
          />
        </div>
      )}

      {/* Price + actions — own divided row on mobile, inline on desktop */}
      <div className="flex items-center justify-between gap-3 border-t border-line pt-3 sm:shrink-0 sm:border-0 sm:pt-0">
        <PriceBlock product={product} />
        <RowActions product={product} busy={busy} onAction={onAction} onDelete={onDelete} />
      </div>
    </Card>
  );
}

function ProductGridCard({
  product,
  busy,
  onOpen,
  onAction,
  onDelete,
}: {
  product: Product;
  busy: boolean;
  onOpen: () => void;
  onAction: (verb: 'pause' | 'resume' | 'check') => void;
  onDelete: () => void;
}): JSX.Element {
  return (
    <Card hover className={`flex flex-col p-4 ${product.status !== 'active' ? 'opacity-70' : ''}`}>
      <button className="flex items-start gap-3 text-left" onClick={onOpen}>
        <Thumb product={product} size="size-16" />
        <span className="min-w-0 flex-1">
          <span className="line-clamp-2 font-medium text-fg hover:text-brand-subtle-fg">
            {product.displayName}
          </span>
        </span>
      </button>
      <MetaBadges product={product} />
      <div className="mt-3 flex items-end justify-between">
        <PriceBlock product={product} />
        <PriceChange
          pct={product.currentDiscountPct ? -Number(product.currentDiscountPct) : null}
        />
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-line pt-3">
        <span className="text-xs text-fg-subtle">checked {relTime(product.lastCheckedAt)}</span>
        <RowActions product={product} busy={busy} onAction={onAction} onDelete={onDelete} />
      </div>
    </Card>
  );
}
