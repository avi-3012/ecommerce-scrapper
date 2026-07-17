import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { api, errorMessage } from '../api.js';
import type { NotificationTemplate } from '../api.js';
import { useToast } from '../toast.js';
import { Badge, Button, Card, CardSkeleton } from '../ui.js';

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Render Telegram's HTML subset for the preview; strip anything script-like. */
function telegramHtmlToSafe(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/ on\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}

export function NotificationTemplatesPage(): JSX.Element {
  const { data, isLoading } = useQuery({
    queryKey: ['templates'],
    queryFn: () => api<NotificationTemplate[]>('/notifications/templates'),
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold text-fg">Notification templates</h1>
        <p className="mt-1 text-sm text-fg-muted">
          Customize the exact Telegram message for each alert type. Insert{' '}
          <code className="rounded bg-surface-2 px-1">{'{{variables}}'}</code> from the palette;
          Telegram HTML (<code className="rounded bg-surface-2 px-1">&lt;b&gt;</code>,{' '}
          <code className="rounded bg-surface-2 px-1">&lt;i&gt;</code>) is supported. The preview
          uses sample data.
        </p>
      </div>

      {isLoading ? (
        <CardSkeleton rows={8} />
      ) : (
        data?.map((tpl) => <TemplateEditor key={tpl.type} tpl={tpl} />)
      )}
    </div>
  );
}

function TemplateEditor({ tpl }: { tpl: NotificationTemplate }): JSX.Element {
  const qc = useQueryClient();
  const toast = useToast();
  const initial = tpl.template || tpl.default;
  const [value, setValue] = useState(initial);
  const debounced = useDebounced(value, 400);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const isCustom = tpl.template.length > 0;
  const dirty = value !== initial;

  const preview = useQuery({
    queryKey: ['preview', tpl.type, debounced],
    queryFn: () =>
      api<{ message: string }>('/notifications/preview', {
        method: 'POST',
        body: JSON.stringify({ type: tpl.type, template: debounced }),
      }),
    staleTime: 60_000,
  });

  const save = useMutation({
    mutationFn: () =>
      api('/notifications/templates', {
        method: 'PUT',
        // Saving the untouched default keeps it "using default" rather than pinning a copy.
        body: JSON.stringify({ type: tpl.type, template: value === tpl.default ? '' : value }),
      }),
    onSuccess: () => {
      toast.success(`${tpl.label} template saved.`);
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const reset = useMutation({
    mutationFn: () =>
      api('/notifications/templates', {
        method: 'PUT',
        body: JSON.stringify({ type: tpl.type, template: '' }),
      }),
    onSuccess: () => {
      setValue(tpl.default);
      toast.success(`${tpl.label} reset to default.`);
      void qc.invalidateQueries({ queryKey: ['templates'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  function insertVar(name: string): void {
    const token = `{{${name}}}`;
    const ta = taRef.current;
    if (!ta) {
      setValue((v) => v + token);
      return;
    }
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    setValue((v) => v.slice(0, start) + token + v.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = start + token.length;
    });
  }

  return (
    <Card className="p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="font-medium text-fg">{tpl.label}</h2>
        <Badge tone={isCustom ? 'brand' : 'neutral'}>{isCustom ? 'Customized' : 'Default'}</Badge>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Editor */}
        <div className="space-y-2">
          <textarea
            ref={taRef}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            spellCheck={false}
            rows={Math.max(8, value.split('\n').length + 1)}
            className="w-full resize-y rounded-md border border-line-strong bg-card px-3 py-2 font-mono text-xs leading-relaxed text-fg focus:border-brand focus:outline-none"
          />
          <div className="flex flex-wrap gap-1">
            {tpl.variables.map((v) => (
              <button
                key={v.name}
                type="button"
                title={v.description}
                onClick={() => insertVar(v.name)}
                className="rounded-md border border-line px-1.5 py-0.5 font-mono text-xs text-fg-muted hover:border-brand hover:text-brand-subtle-fg"
              >
                {`{{${v.name}}}`}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2 pt-1">
            <Button
              variant="primary"
              loading={save.isPending}
              disabled={!dirty}
              onClick={() => save.mutate()}
            >
              Save
            </Button>
            <Button
              variant="ghost"
              icon={RotateCcw}
              loading={reset.isPending}
              disabled={!isCustom}
              onClick={() => reset.mutate()}
            >
              Reset to default
            </Button>
          </div>
        </div>

        {/* Live preview */}
        <div>
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-fg-subtle">
            Preview
          </p>
          <div className="rounded-xl bg-surface-2 p-3">
            <div
              className="whitespace-pre-wrap break-words text-sm leading-relaxed text-fg"
              // Sample-data preview of the user's own template (self-hosted, single user).
              dangerouslySetInnerHTML={{
                __html: telegramHtmlToSafe(preview.data?.message ?? 'Rendering…'),
              }}
            />
          </div>
        </div>
      </div>
    </Card>
  );
}
