import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Download, Upload } from 'lucide-react';
import { api, errorMessage, relTime } from '../api.js';
import type { ImportReview } from '../api.js';
import { useToast } from '../toast.js';
import { Button, Card, ErrorNote, Spinner } from '../ui.js';

interface Batch {
  id: string;
  filename: string;
  totalRows: number;
  imported: number;
  duplicates: number;
  invalid: number;
  rowErrors: Array<{ rowNumber: number; url: string; reason: string }>;
  createdAt: string;
}

export function ImportPage(): JSX.Element {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [review, setReview] = useState<ImportReview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ imported: number } | null>(null);
  const [dragging, setDragging] = useState(false);

  const { data: batches } = useQuery({
    queryKey: ['import-batches'],
    queryFn: () => api<Batch[]>('/import'),
  });

  const validate = useMutation({
    mutationFn: (file: File) => {
      const form = new FormData();
      form.append('file', file);
      return api<ImportReview>('/import/validate', { method: 'POST', body: form });
    },
    onSuccess: (r) => {
      setReview(r);
      setResult(null);
      setError(null);
    },
    onError: (err) => setError(errorMessage(err)),
  });

  const execute = useMutation({
    mutationFn: (r: ImportReview) =>
      api<{ imported: number }>('/import/execute', { method: 'POST', body: JSON.stringify(r) }),
    onSuccess: (r) => {
      setResult(r);
      setReview(null);
      toast.success(`Imported ${r.imported} products.`);
      void queryClient.invalidateQueries({ queryKey: ['import-batches'] });
      void queryClient.invalidateQueries({ queryKey: ['products'] });
    },
    onError: (err) => setError(errorMessage(err)),
  });

  function downloadErrors(
    rows: Array<{ rowNumber: number; url: string; reason: string }>,
    filename: string,
  ): void {
    const csv = [
      'row,url,reason',
      ...rows.map((r) => `${r.rowNumber},"${r.url}","${r.reason.replace(/"/g, '""')}"`),
    ].join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${filename}-errors.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold text-fg">Bulk import</h1>
      <p className="text-sm text-fg-muted">
        Upload a .csv or .xlsx with a <b className="text-fg">url</b> column (required) and optional{' '}
        <b className="text-fg">target price</b>, <b className="text-fg">threshold</b>,{' '}
        <b className="text-fg">notes</b>, and <b className="text-fg">tags</b> columns. Product names
        are fetched from the marketplace automatically. Nothing is saved until you confirm the
        review below.
      </p>

      <label
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const file = e.dataTransfer.files?.[0];
          if (file) validate.mutate(file);
        }}
        className={`flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed p-10 text-center transition-colors ${
          dragging ? 'border-brand bg-brand-subtle' : 'border-line-strong hover:border-brand'
        }`}
      >
        <input
          type="file"
          accept=".csv,.xlsx"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) validate.mutate(file);
            e.target.value = '';
          }}
        />
        <Upload className="size-7 text-fg-subtle" aria-hidden />
        <span className="text-sm text-fg-muted">
          {validate.isPending
            ? 'Validating…'
            : 'Drag a .csv or .xlsx here, or click to choose (max 1000 rows)'}
        </span>
      </label>

      {error && <ErrorNote message={error} />}

      {result && (
        <Card className="flex items-start gap-3 border-success/40 bg-success-subtle p-4 text-sm text-success-fg">
          <CheckCircle2 className="mt-0.5 size-5 shrink-0" aria-hidden />
          <p>
            Imported {result.imported} products. First checks run at a polite pace — new products
            show <i>awaiting first check</i> until their turn.{' '}
            <Link to="/products" className="underline">
              View products
            </Link>
            .
          </p>
        </Card>
      )}

      {review && (
        <Card className="p-4">
          <h2 className="font-medium text-fg">Review before importing — {review.filename}</h2>
          <div className="mt-3 grid grid-cols-3 gap-3 text-center">
            <div className="rounded-lg bg-success-subtle p-3">
              <p className="nums text-2xl font-semibold text-success-fg">{review.valid.length}</p>
              <p className="text-xs text-success-fg">will import</p>
            </div>
            <div className="rounded-lg bg-warning-subtle p-3">
              <p className="nums text-2xl font-semibold text-warning-fg">
                {review.duplicates.length}
              </p>
              <p className="text-xs text-warning-fg">duplicates (skipped)</p>
            </div>
            <div className="rounded-lg bg-danger-subtle p-3">
              <p className="nums text-2xl font-semibold text-danger-fg">{review.invalid.length}</p>
              <p className="text-xs text-danger-fg">invalid (skipped)</p>
            </div>
          </div>

          {[...review.invalid, ...review.duplicates].length > 0 && (
            <details className="mt-3 text-sm">
              <summary className="cursor-pointer text-fg-muted">Per-row reasons</summary>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs text-fg-muted">
                {[...review.invalid, ...review.duplicates]
                  .sort((a, b) => a.rowNumber - b.rowNumber)
                  .map((r) => (
                    <li key={`${r.rowNumber}-${r.url}`}>
                      Row {r.rowNumber}: {r.reason}{' '}
                      <span className="text-fg-subtle">({r.url || 'no url'})</span>
                    </li>
                  ))}
              </ul>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                onClick={() =>
                  downloadErrors([...review.invalid, ...review.duplicates], review.filename)
                }
              >
                Download errors as CSV
              </Button>
            </details>
          )}

          <div className="mt-4 flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setReview(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={review.valid.length === 0}
              loading={execute.isPending}
              onClick={() => execute.mutate(review)}
            >
              Import {review.valid.length} products
            </Button>
          </div>
        </Card>
      )}

      <section>
        <h2 className="mb-2 font-medium text-fg">Previous imports</h2>
        {!batches ? (
          <Spinner />
        ) : batches.length === 0 ? (
          <p className="text-sm text-fg-subtle">No imports yet.</p>
        ) : (
          <Card>
            <ul className="divide-y divide-line text-sm">
              {batches.map((b) => (
                <li
                  key={b.id}
                  className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
                >
                  <span className="font-medium text-fg">{b.filename}</span>
                  <span className="text-fg-muted">
                    {b.imported} imported · {b.duplicates} duplicates · {b.invalid} invalid
                  </span>
                  <span className="text-xs text-fg-subtle">{relTime(b.createdAt)}</span>
                  {b.rowErrors.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={Download}
                      onClick={() => downloadErrors(b.rowErrors, b.filename)}
                    >
                      Errors
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        )}
      </section>
    </div>
  );
}
