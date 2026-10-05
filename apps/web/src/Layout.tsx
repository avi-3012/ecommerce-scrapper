import { useEffect } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  Download,
  Gauge,
  LayoutDashboard,
  MessageSquare,
  Package,
  Settings2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from './api.js';
import type { SystemStatusReport } from './api.js';
import { SignOutButton, ThemeSwitch, Wordmark } from './components.js';

const NAV: Array<{ to: string; label: string; icon: LucideIcon }> = [
  { to: '/', label: 'Dashboard', icon: LayoutDashboard },
  { to: '/products', label: 'Products', icon: Package },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/notifications', label: 'Templates', icon: MessageSquare },
  { to: '/import', label: 'Import', icon: Download },
  { to: '/bandwidth', label: 'Bandwidth', icon: Gauge },
  { to: '/settings', label: 'Settings', icon: Settings2 },
];

type Health = 'green' | 'amber' | 'red';

export function Layout(): JSX.Element {
  const queryClient = useQueryClient();

  // Live updates (FR-5.8): SSE invalidates caches; polling remains the fallback.
  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data as string) as { type: string; productId?: string };
        if (payload.type === 'check') {
          void queryClient.invalidateQueries({ queryKey: ['products'] });
          void queryClient.invalidateQueries({ queryKey: ['alerts'] });
          if (payload.productId) {
            void queryClient.invalidateQueries({ queryKey: ['product', payload.productId] });
            void queryClient.invalidateQueries({ queryKey: ['history', payload.productId] });
            void queryClient.invalidateQueries({ queryKey: ['chart', payload.productId] });
          }
        }
        void queryClient.invalidateQueries({ queryKey: ['status'] });
      } catch {
        /* malformed event — polling covers us */
      }
    };
    source.onopen = () => void queryClient.invalidateQueries();
    return () => source.close();
  }, [queryClient]);

  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: () => api<SystemStatusReport>('/status'),
    refetchInterval: 30_000,
  });

  const health: Health = !status
    ? 'amber'
    : status.workerStale
      ? 'red'
      : status.products.pausedAuto > 0 || status.products.failing > 0
        ? 'amber'
        : 'green';

  return (
    <div className="min-h-screen bg-surface">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-md focus:bg-card focus:px-3 focus:py-2 focus:shadow-pop"
      >
        Skip to content
      </a>

      {/* Desktop sidebar. Dark mode and sign-out sit at its foot rather than in
          a bar across the top, which cost every page 56px of height. */}
      <aside className="fixed inset-y-0 left-0 hidden w-56 overflow-y-auto border-r border-line bg-card p-4 md:flex md:flex-col">
        <div className="mb-6 px-1">
          <Wordmark />
        </div>
        <nav className="flex-1 space-y-1">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                `flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                  isActive
                    ? 'bg-brand-subtle font-medium text-brand-subtle-fg'
                    : 'text-fg-muted hover:bg-surface-2 hover:text-fg'
                }`
              }
            >
              <Icon className="size-5" aria-hidden />
              {label}
            </NavLink>
          ))}
        </nav>
        <HealthPill health={health} status={status} />
        <div className="mt-3 space-y-1 border-t border-line pt-3">
          <ThemeSwitch />
          <SignOutButton />
        </div>
      </aside>

      {/* Mobile bottom nav */}
      <nav className="fixed inset-x-0 bottom-0 z-40 flex justify-around border-t border-line bg-card py-1 md:hidden">
        {NAV.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            className={({ isActive }) =>
              `flex min-w-14 flex-col items-center gap-0.5 rounded-md px-2 py-1.5 text-[11px] ${
                isActive ? 'text-brand-subtle-fg' : 'text-fg-subtle'
              }`
            }
          >
            <Icon className="size-5" aria-hidden />
            {label}
          </NavLink>
        ))}
      </nav>

      <main id="main" className="px-4 pb-24 pt-6 md:ml-56 md:pb-10 lg:px-8 lg:pt-8">
        <div className="mx-auto max-w-6xl">
          <Outlet />
        </div>
      </main>
    </div>
  );
}

function HealthPill({
  health,
  status,
}: {
  health: Health;
  status?: SystemStatusReport;
}): JSX.Element {
  const dot = { green: 'bg-success', amber: 'bg-warning', red: 'bg-danger' }[health];
  const label = !status
    ? 'Connecting…'
    : health === 'red'
      ? 'Monitoring stalled'
      : health === 'amber'
        ? 'Needs attention'
        : 'All systems normal';
  return (
    <div className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-xs text-fg-muted">
      <span className={`size-2 rounded-full ${dot} ${health !== 'green' ? 'animate-pulse' : ''}`} />
      {label}
    </div>
  );
}
