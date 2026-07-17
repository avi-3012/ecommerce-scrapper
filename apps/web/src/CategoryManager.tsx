import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react';
import { api, errorMessage } from './api.js';
import type { Category } from './api.js';
import { useToast } from './toast.js';
import { Button, IconButton, Input, Modal } from './ui.js';

const PALETTE = [
  '#3b82f6',
  '#22c55e',
  '#f59e0b',
  '#ef4444',
  '#a855f7',
  '#ec4899',
  '#14b8a6',
  '#64748b',
] as const;

function Swatches({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (c: string) => void;
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-1.5">
      {PALETTE.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`Colour ${c}`}
          onClick={() => onChange(c)}
          className={`size-5 rounded-full ring-offset-1 ring-offset-card transition ${
            value === c ? 'ring-2 ring-fg' : 'ring-1 ring-line'
          }`}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

/** CRUD for user-defined categories. Deleting a category leaves its products
 * intact — they simply become uncategorised. */
export function CategoryManager({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: categories } = useQuery({
    queryKey: ['categories'],
    queryFn: () => api<Category[]>('/categories'),
    enabled: open,
  });

  const [name, setName] = useState('');
  const [color, setColor] = useState<string>(PALETTE[0]);
  const [editing, setEditing] = useState<Category | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const invalidate = (): void => {
    void qc.invalidateQueries({ queryKey: ['categories'] });
    void qc.invalidateQueries({ queryKey: ['products'] });
  };

  const create = useMutation({
    mutationFn: () =>
      api('/categories', { method: 'POST', body: JSON.stringify({ name: name.trim(), color }) }),
    onSuccess: () => {
      setName('');
      setColor(PALETTE[0]);
      toast.success('Category added.');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const update = useMutation({
    mutationFn: (c: Category) =>
      api(`/categories/${c.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: c.name.trim(), color: c.color }),
      }),
    onSuccess: () => {
      setEditing(null);
      toast.success('Category updated.');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setConfirmDelete(null);
      toast.success('Category deleted.');
      invalidate();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!open) return null;

  return (
    <Modal open={open} title="Manage categories" onClose={onClose}>
      <div className="space-y-4">
        <ul className="space-y-2">
          {categories?.length === 0 && (
            <li className="text-sm text-fg-subtle">No categories yet — add one below.</li>
          )}
          {categories?.map((c) =>
            editing?.id === c.id ? (
              <li key={c.id} className="space-y-2 rounded-lg border border-line-strong p-2.5">
                <Input
                  value={editing.name}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                  autoFocus
                />
                <div className="flex items-center justify-between">
                  <Swatches
                    value={editing.color}
                    onChange={(col) => setEditing({ ...editing, color: col })}
                  />
                  <div className="flex gap-1">
                    <IconButton
                      icon={Check}
                      label="Save"
                      variant="primary"
                      loading={update.isPending}
                      onClick={() => editing.name.trim() && update.mutate(editing)}
                    />
                    <IconButton icon={X} label="Cancel" onClick={() => setEditing(null)} />
                  </div>
                </div>
              </li>
            ) : (
              <li
                key={c.id}
                className="flex items-center gap-2 rounded-lg border border-line px-2.5 py-2"
              >
                <span
                  className="size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: c.color ?? '#9ca3af' }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-fg">
                  {c.name}
                </span>
                <span className="shrink-0 text-xs text-fg-subtle">
                  {c.productCount} product{c.productCount === 1 ? '' : 's'}
                </span>
                {confirmDelete === c.id ? (
                  <span className="flex shrink-0 items-center gap-1">
                    <span className="text-xs text-fg-muted">Delete?</span>
                    <Button
                      size="sm"
                      variant="danger"
                      loading={remove.isPending}
                      onClick={() => remove.mutate(c.id)}
                    >
                      Yes
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)}>
                      No
                    </Button>
                  </span>
                ) : (
                  <span className="flex shrink-0 gap-1">
                    <IconButton icon={Pencil} label="Edit" onClick={() => setEditing(c)} />
                    <IconButton
                      icon={Trash2}
                      label="Delete"
                      onClick={() => setConfirmDelete(c.id)}
                    />
                  </span>
                )}
              </li>
            ),
          )}
        </ul>

        <form
          className="space-y-2 border-t border-line pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <label className="text-sm font-medium text-fg">New category</label>
          <div className="flex gap-2">
            <Input
              placeholder="e.g. Electronics"
              value={name}
              maxLength={50}
              onChange={(e) => setName(e.target.value)}
            />
            <Button type="submit" variant="primary" icon={Plus} loading={create.isPending}>
              Add
            </Button>
          </div>
          <Swatches value={color} onChange={setColor} />
        </form>
      </div>
    </Modal>
  );
}
