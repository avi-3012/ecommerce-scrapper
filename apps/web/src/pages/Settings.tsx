import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api, errorMessage } from '../api.js';
import type { SettingsView } from '../api.js';
import { useToast } from '../toast.js';
import { Button, Card, Field, Input, Select, Spinner } from '../ui.js';

export function SettingsPage(): JSX.Element {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api<SettingsView>('/settings'),
  });

  if (isLoading || !settings) return <Spinner label="Loading settings…" />;
  return (
    <SettingsForm
      settings={settings}
      onSaved={() => void queryClient.invalidateQueries({ queryKey: ['settings'] })}
    />
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <Card className="p-4">
      <h2 className="font-medium text-fg">{title}</h2>
      {hint && <p className="mb-3 mt-0.5 text-xs text-fg-muted">{hint}</p>}
      <div className={hint ? '' : 'mt-3'}>{children}</div>
    </Card>
  );
}

function SettingsForm({
  settings,
  onSaved,
}: {
  settings: SettingsView;
  onSaved: () => void;
}): JSX.Element {
  const toast = useToast();
  const [interval, setIntervalMin] = useState(String(settings.checkIntervalMinutes));
  const [threshold, setThreshold] = useState(String(settings.globalDropThresholdPct));
  const [failureLimit, setFailureLimit] = useState(String(settings.consecutiveFailureLimit));
  const [pincode, setPincode] = useState(settings.pincode ?? '');
  const [toggles, setToggles] = useState({
    alertTargetPrice: settings.alertTargetPrice,
    alertThresholdDrop: settings.alertThresholdDrop,
    alertAnyChange: settings.alertAnyChange,
    alertOfferChange: settings.alertOfferChange,
    alertBackInStock: settings.alertBackInStock,
    monitoringPaused: settings.monitoringPaused,
  });
  const [botToken, setBotToken] = useState('');
  const [chatId, setChatId] = useState(settings.telegramChatId ?? '');
  const [pw, setPw] = useState({ current: '', next: '' });
  const [cooldown, setCooldown] = useState(String(settings.cooldownMinutes));
  const [quietStart, setQuietStart] = useState(settings.quietHoursStart ?? '');
  const [quietEnd, setQuietEnd] = useState(settings.quietHoursEnd ?? '');
  const [digestFreq, setDigestFreq] = useState(settings.digestFrequency);
  const [digestTime, setDigestTime] = useState(settings.digestTime ?? '09:00');

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api('/settings', { method: 'PATCH', body: JSON.stringify(body) }),
    onSuccess: () => {
      toast.success('Saved — changes take effect immediately.');
      onSaved();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const test = useMutation({
    mutationFn: () => api('/settings/test-notification', { method: 'POST' }),
    onSuccess: () => toast.info('Test queued — check your Telegram chat within a few seconds.'),
    onError: (err) => toast.error(errorMessage(err)),
  });

  const changePassword = useMutation({
    mutationFn: () =>
      api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: pw.current, newPassword: pw.next }),
      }),
    onSuccess: () => {
      setPw({ current: '', next: '' });
      toast.success('Password changed.');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const toggleRow = (key: keyof typeof toggles, label: string, hint: string): JSX.Element => (
    <label className="flex items-start justify-between gap-4 py-2">
      <span>
        <span className="text-sm font-medium text-fg">{label}</span>
        <span className="block text-xs text-fg-muted">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={toggles[key]}
        onChange={(e) => {
          setToggles({ ...toggles, [key]: e.target.checked });
          save.mutate({ [key]: e.target.checked });
        }}
        className="mt-1 size-4 accent-[var(--brand)]"
      />
    </label>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold text-fg">Settings</h1>

      <Section
        title="Monitoring"
        hint="The 10-minute floor keeps monitoring polite to the marketplaces — checking faster risks being blocked."
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Check interval (minutes)">
            <Input
              type="number"
              min="10"
              value={interval}
              onChange={(e) => setIntervalMin(e.target.value)}
            />
          </Field>
          <Field label="Default drop threshold %">
            <Input
              type="number"
              step="0.5"
              min="0.1"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </Field>
          <Field label="Auto-pause after failures">
            <Input
              type="number"
              min="2"
              value={failureLimit}
              onChange={(e) => setFailureLimit(e.target.value)}
            />
          </Field>
          <Field
            label="Delivery pincode (optional)"
            hint="Localises Amazon prices/offers to this area. Leave blank for the default."
          >
            <Input
              inputMode="numeric"
              maxLength={6}
              placeholder="e.g. 560001"
              value={pincode}
              onChange={(e) => setPincode(e.target.value.replace(/\D/g, ''))}
            />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                checkIntervalMinutes: Number(interval),
                globalDropThresholdPct: Number(threshold),
                consecutiveFailureLimit: Number(failureLimit),
                pincode: pincode.trim() === '' ? null : pincode.trim(),
              })
            }
          >
            Save monitoring settings
          </Button>
        </div>
        <div className="mt-2 border-t border-line pt-1">
          {toggleRow(
            'monitoringPaused',
            'Emergency pause — stop ALL monitoring',
            'Nothing is checked while this is on. Use only if something looks wrong.',
          )}
        </div>
      </Section>

      <Section title="Alert rules">
        <div className="divide-y divide-line">
          {toggleRow(
            'alertTargetPrice',
            'Target price alerts',
            'When a product drops to or below its target.',
          )}
          {toggleRow(
            'alertThresholdDrop',
            'Threshold drop alerts',
            'When a price drops by at least the threshold %.',
          )}
          {toggleRow(
            'alertAnyChange',
            'Every price movement',
            'Any rise or drop, however small. Off by default — can be noisy.',
          )}
          {toggleRow(
            'alertOfferChange',
            'Offer changes',
            'When bank offers or coupons appear or disappear, even if the price is unchanged.',
          )}
          {toggleRow(
            'alertBackInStock',
            'Back in stock',
            'When an out-of-stock product becomes available.',
          )}
        </div>
        <p className="mt-2 text-xs text-fg-subtle">
          Monitoring-health alerts (auto-pause and system problems) are always delivered — the
          system never fails silently.
        </p>
      </Section>

      <Section
        title="Alert hygiene"
        hint="Reduce noise without losing information — suppressed and held alerts are still recorded in the log."
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Cooldown (minutes)"
            hint="Suppress repeat alerts of the same type per product. 0 disables."
          >
            <Input
              type="number"
              min="0"
              value={cooldown}
              onChange={(e) => setCooldown(e.target.value)}
            />
          </Field>
          <Field label="Digest" hint="A periodic catalogue-wide summary.">
            <div className="flex gap-2">
              <Select
                value={digestFreq}
                onChange={(e) => setDigestFreq(e.target.value as typeof digestFreq)}
              >
                <option value="off">Off</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </Select>
              {digestFreq !== 'off' && (
                <Input
                  type="time"
                  value={digestTime}
                  onChange={(e) => setDigestTime(e.target.value)}
                  className="w-32"
                />
              )}
            </div>
          </Field>
          <Field
            label="Quiet hours start"
            hint="Alerts are held and delivered as a summary afterwards."
          >
            <Input type="time" value={quietStart} onChange={(e) => setQuietStart(e.target.value)} />
          </Field>
          <Field label="Quiet hours end">
            <Input type="time" value={quietEnd} onChange={(e) => setQuietEnd(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                cooldownMinutes: Number(cooldown),
                quietHoursStart: quietStart || null,
                quietHoursEnd: quietEnd || null,
                digestFrequency: digestFreq,
                digestTime: digestFreq === 'off' ? null : digestTime,
              })
            }
          >
            Save hygiene settings
          </Button>
        </div>
      </Section>

      <Section
        title="Telegram"
        hint={`Create a bot with @BotFather, paste its token, then send /start to your bot — it binds this chat automatically. Token is stored encrypted${settings.telegramBotTokenSet ? ' · a token is currently set' : ''}.`}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="Bot token"
            hint={
              settings.telegramBotTokenSet ? 'Leave blank to keep the current token.' : undefined
            }
          >
            <Input
              type="password"
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              placeholder="123456:ABC-…"
            />
          </Field>
          <Field label="Chat ID" hint="Set automatically by /start.">
            <Input value={chatId} onChange={(e) => setChatId(e.target.value)} />
          </Field>
        </div>
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" loading={test.isPending} onClick={() => test.mutate()}>
            Send test notification
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate({
                ...(botToken ? { telegramBotToken: botToken } : {}),
                telegramChatId: chatId || null,
              })
            }
          >
            Save Telegram settings
          </Button>
        </div>
      </Section>

      <Section
        title="Export data"
        hint="Download your catalogue and history as CSV. The products file re-imports cleanly."
      >
        <div className="flex flex-wrap gap-2">
          <a href="/api/export/products.csv" download>
            <Button variant="secondary" icon={Download}>
              Products
            </Button>
          </a>
          <a href="/api/export/history.csv" download>
            <Button variant="secondary" icon={Download}>
              Full price history
            </Button>
          </a>
          <a href="/api/export/alerts.csv" download>
            <Button variant="secondary" icon={Download}>
              Alert log
            </Button>
          </a>
        </div>
      </Section>

      <Section title="Account">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Current password">
            <Input
              type="password"
              value={pw.current}
              onChange={(e) => setPw({ ...pw, current: e.target.value })}
              autoComplete="current-password"
            />
          </Field>
          <Field label="New password" hint="12+ characters.">
            <Input
              type="password"
              value={pw.next}
              onChange={(e) => setPw({ ...pw, next: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <Button
            variant="primary"
            disabled={!pw.current || !pw.next}
            loading={changePassword.isPending}
            onClick={() => changePassword.mutate()}
          >
            Change password
          </Button>
        </div>
      </Section>
    </div>
  );
}
