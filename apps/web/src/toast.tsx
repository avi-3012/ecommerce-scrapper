import { createContext, useCallback, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { CheckCircle2, Info, TriangleAlert, X } from 'lucide-react';

type ToastTone = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  tone: ToastTone;
  message: string;
}

interface ToastCtx {
  toast: (tone: ToastTone, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const Ctx = createContext<ToastCtx | null>(null);
let counter = 0;

/** Global toast notifications (resolves UI-UX-GAPS §3.1). Auto-dismiss + manual close. */
export function ToastProvider({ children }: { children: ReactNode }): JSX.Element {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const remove = useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (tone: ToastTone, message: string) => {
      const id = ++counter;
      setToasts((prev) => [...prev, { id, tone, message }]);
      setTimeout(() => remove(id), tone === 'error' ? 7000 : 4000);
    },
    [remove],
  );

  const value: ToastCtx = {
    toast,
    success: (m) => toast('success', m),
    error: (m) => toast('error', m),
    info: (m) => toast('info', m),
  };

  return (
    <Ctx.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-full max-w-sm flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {toasts.map((t) => (
          <ToastCard key={t.id} toast={t} onClose={() => remove(t.id)} />
        ))}
      </div>
    </Ctx.Provider>
  );
}

function ToastCard({ toast, onClose }: { toast: Toast; onClose: () => void }): JSX.Element {
  const config = {
    success: { Icon: CheckCircle2, cls: 'text-success', role: 'status' as const },
    error: { Icon: TriangleAlert, cls: 'text-danger', role: 'alert' as const },
    info: { Icon: Info, cls: 'text-info', role: 'status' as const },
  }[toast.tone];
  const { Icon } = config;
  return (
    <div
      role={config.role}
      className="pointer-events-auto flex items-start gap-3 rounded-lg border border-line bg-card p-3 shadow-pop animate-[slideIn_.18s_ease-out]"
    >
      <Icon className={`mt-0.5 size-5 shrink-0 ${config.cls}`} aria-hidden />
      <p className="flex-1 text-sm text-fg">{toast.message}</p>
      <button onClick={onClose} aria-label="Dismiss" className="text-fg-subtle hover:text-fg">
        <X className="size-4" />
      </button>
    </div>
  );
}

export function useToast(): ToastCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}
