import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useMutation } from '@tanstack/react-query';
import { Search } from 'lucide-react';
import { api, errorMessage, inr } from '../api.js';
import type { PreviewResult, Product } from '../api.js';
import { Button, Card, ErrorNote, Field, Input, MarketplaceBadge, StockBadge } from '../ui.js';

/** Registration flow (WP-2.5): paste URL → live preview (FR-1.3) → configure → save. */
export function AddProductPage(): JSX.Element {
  const navigate = useNavigate();
  const [url, setUrl] = useState('');
  const [preview, setPreview] = useState<Extract<PreviewResult, { kind: 'preview' }> | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [targetPrice, setTargetPrice] = useState('');
  const [threshold, setThreshold] = useState('');
  const [tags, setTags] = useState('');
  const [notes, setNotes] = useState('');

  const previewMutation = useMutation({
    mutationFn: (input: string) => {
      const match = input.match(/https?:\/\/\S+/);
      return api<PreviewResult>('/products/preview', {
        method: 'POST',
        body: JSON.stringify({ url: match?.[0] ?? input.trim() }),
      });
    },
    onSuccess: (result) => {
      setPreview(null);
      setNote(null);
      switch (result.kind) {
        case 'preview':
          setPreview(result);
          setDisplayName(result.snapshot.name);
          break;
        case 'unsupported':
          setNote(
            `That site${result.detectedSite ? ` (${result.detectedSite})` : ''} isn't supported. PricePulse tracks Amazon India and Flipkart listings.`,
          );
          break;
        case 'not_a_listing':
          setNote(
            'That looks like a supported marketplace, but not a product page. Paste the URL of a specific listing.',
          );
          break;
        case 'duplicate':
          setNote(`Already tracking this product as “${result.displayName}”.`);
          break;
        case 'fetch_failed':
          setNote(
            `Couldn't read the listing right now (${result.message}). Try again in a minute.`,
          );
          break;
      }
    },
    onError: (err) => setNote(errorMessage(err)),
  });

  const register = useMutation({
    mutationFn: () =>
      api<Product>('/products', {
        method: 'POST',
        body: JSON.stringify({
          url: preview!.url,
          canonicalUrl: preview!.canonicalUrl,
          marketplace: preview!.marketplace,
          marketplaceProductId: preview!.productId,
          snapshot: preview!.snapshot,
          displayName: displayName.trim() || undefined,
          targetPrice: targetPrice ? Number(targetPrice) : undefined,
          dropThresholdPct: threshold ? Number(threshold) : undefined,
          notes: notes || undefined,
          tags: tags
            ? tags
                .split(',')
                .map((t) => t.trim())
                .filter(Boolean)
            : undefined,
        }),
      }),
    onSuccess: (product) => navigate(`/products/${product.id}`),
    onError: (err) => setNote(errorMessage(err)),
  });

  const s = preview?.snapshot;
  const targetAboveCurrent = s && targetPrice && Number(targetPrice) >= s.price;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <h1 className="text-2xl font-semibold text-fg">Add a product</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          previewMutation.mutate(url);
        }}
        className="flex gap-2"
      >
        <Input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="Paste an Amazon India or Flipkart listing URL"
          required
        />
        <Button type="submit" variant="primary" icon={Search} loading={previewMutation.isPending}>
          Preview
        </Button>
      </form>
      {previewMutation.isPending && (
        <p className="text-sm text-fg-muted">Checking the listing — usually under 15 seconds…</p>
      )}
      {note && <ErrorNote message={note} />}

      {preview && s && (
        <Card className="p-5">
          <p className="text-sm font-medium text-fg-muted">Is this the right product?</p>
          <div className="mt-3 flex gap-4">
            {s.imageUrl && (
              <img src={s.imageUrl} alt="" className="size-24 rounded-lg object-contain" />
            )}
            <div>
              <p className="font-medium text-fg">{s.name}</p>
              <div className="mt-1 flex items-center gap-1.5">
                <MarketplaceBadge marketplace={s.marketplace} />
                <StockBadge stock={s.stockStatus} />
              </div>
              <p className="nums mt-2 text-lg font-semibold text-fg">
                {inr(s.price)}{' '}
                {s.mrp > s.price && (
                  <span className="text-sm font-normal text-fg-subtle">
                    <s>{inr(s.mrp)}</s> · {s.discountPct}% off
                  </span>
                )}
              </p>
              {s.offers.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-fg-muted">
                  {s.offers.map((o) => (
                    <li key={o.description}>🏷️ {o.description}</li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          <div className="mt-5 grid gap-3 border-t border-line pt-4 sm:grid-cols-2">
            <Field label="Display name">
              <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
            </Field>
            <Field
              label="Target price (₹, optional)"
              hint={
                targetAboveCurrent
                  ? "Target is at or above the current price — you'll be alerted after the price rises above it and then drops back."
                  : undefined
              }
            >
              <Input
                type="number"
                min="1"
                value={targetPrice}
                onChange={(e) => setTargetPrice(e.target.value)}
              />
            </Field>
            <Field label="Drop threshold % (optional)" hint="Uses the global default when blank.">
              <Input
                type="number"
                min="0"
                max="99"
                step="0.5"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </Field>
            <Field label="Tags (comma-separated)">
              <Input
                value={tags}
                onChange={(e) => setTags(e.target.value)}
                placeholder="phone, gift ideas"
              />
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

          <div className="mt-5 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={register.isPending}
              onClick={() => register.mutate()}
            >
              Track this product
            </Button>
          </div>
        </Card>
      )}

      <p className="text-sm text-fg-subtle">
        Have a whole catalogue?{' '}
        <Link to="/import" className="text-brand-subtle-fg hover:underline">
          Bulk import from a spreadsheet
        </Link>
        .
      </p>
    </div>
  );
}
