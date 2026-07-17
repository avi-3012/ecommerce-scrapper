import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Bot } from 'grammy';
import {
  decryptSecret,
  getUserWithSettings,
  isCooldownExempt,
  isDigestDue,
  isHealthAlert,
  isWithinQuietHours,
  renderAlertMessage,
  renderTestMessage,
} from '@pricepulse/core';
import { MARKETPLACE_LABELS, formatInr } from '@pricepulse/shared';
import type { Alert, Product, Settings } from '@pricepulse/db';
import { PrismaService } from '../prisma.service.js';
import { WORKER_CONFIG } from '../config.js';
import type { WorkerConfig } from '../config.js';

const DISPATCH_PERIOD_MS = 5_000;
const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];

type AlertWithProduct = Alert & { product: Product | null };

/**
 * The Telegram notification channel (WP-1.8) with Milestone 3 hygiene
 * (WP-3.1): cooldown suppression, quiet-hours hold + consolidated flush,
 * and the daily/weekly digest. Hygiene alters DELIVERY only — every alert
 * stays recorded with its outcome (NFR-2).
 */
@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot | null = null;
  private tokenInUse: string | null = null;
  private timer: NodeJS.Timeout | null = null;
  private dispatching = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(WORKER_CONFIG) private readonly config: WorkerConfig,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.dispatchPending(), DISPATCH_PERIOD_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Current bot instance, rebuilt when the stored token changes (FR-6.2 live settings). */
  async getBot(): Promise<{ bot: Bot; chatId: string | null } | null> {
    const { user, settings } = await getUserWithSettings(this.prisma);
    if (!settings.telegramBotTokenEnc) return null;
    let token: string;
    try {
      token = decryptSecret(settings.telegramBotTokenEnc, this.config.SETTINGS_ENC_KEY);
    } catch {
      return null;
    }
    if (!this.bot || this.tokenInUse !== token) {
      this.bot = new Bot(token);
      this.tokenInUse = token;
    }
    return { bot: this.bot, chatId: user.telegramChatId };
  }

  async sendTest(): Promise<{ ok: boolean; error?: string }> {
    const ctx = await this.getBot();
    if (!ctx) return { ok: false, error: 'Telegram bot token is not configured' };
    if (!ctx.chatId)
      return { ok: false, error: 'No Telegram chat is bound — send /start to the bot' };
    try {
      await ctx.bot.api.sendMessage(ctx.chatId, renderTestMessage(), { parse_mode: 'HTML' });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async dispatchPending(): Promise<void> {
    if (this.dispatching) return;
    this.dispatching = true;
    try {
      const { settings } = await getUserWithSettings(this.prisma);
      const now = new Date();
      const inQuiet = isWithinQuietHours(
        settings.quietHoursStart,
        settings.quietHoursEnd,
        settings.timezone,
        now,
      );

      await this.processPending(settings, inQuiet, now);
      if (!inQuiet) await this.flushHeld();
      await this.maybeSendDigest(settings, now);
    } catch (err) {
      console.error('Alert dispatch failed:', err instanceof Error ? err.message : err);
    } finally {
      this.dispatching = false;
    }
  }

  private async processPending(settings: Settings, inQuiet: boolean, now: Date): Promise<void> {
    const pending: AlertWithProduct[] = await this.prisma.alert.findMany({
      where: { deliveryStatus: 'pending' },
      orderBy: { firedAt: 'asc' },
      take: 50,
      include: { product: true },
    });
    if (pending.length === 0) return;

    const ctx = await this.getBot();
    if (!ctx || !ctx.chatId) {
      await this.prisma.alert.updateMany({
        where: { id: { in: pending.map((a) => a.id) } },
        data: {
          deliveryStatus: 'failed',
          deliveryError: ctx
            ? 'No Telegram chat bound (send /start to the bot)'
            : 'Telegram bot token not configured',
        },
      });
      return;
    }

    const deliverable: AlertWithProduct[] = [];
    for (const alert of pending) {
      // Cooldown (FR-3.8): same product + same type within the window → suppressed, still recorded
      if (settings.cooldownMinutes > 0 && !isCooldownExempt(alert.type) && alert.productId) {
        const windowStart = new Date(now.getTime() - settings.cooldownMinutes * 60_000);
        const recentDelivered = await this.prisma.alert.findFirst({
          where: {
            productId: alert.productId,
            type: alert.type,
            deliveryStatus: 'delivered',
            deliveredAt: { gte: windowStart },
          },
          select: { id: true },
        });
        if (recentDelivered) {
          await this.prisma.alert.update({
            where: { id: alert.id },
            data: {
              deliveryStatus: 'suppressed',
              suppressedReason: `cooldown ${settings.cooldownMinutes}m`,
            },
          });
          continue;
        }
      }
      // Quiet hours (FR-3.9): held, not dropped; health alerts pass unless user opted to hold them
      if (inQuiet && (!isHealthAlert(alert.type) || settings.quietHoursHoldHealth)) {
        await this.prisma.alert.update({
          where: { id: alert.id },
          data: { deliveryStatus: 'held_quiet_hours' },
        });
        continue;
      }
      deliverable.push(alert);
    }

    // Group alerts from the same check of the same product into one message (WP-1.8 rule 4)
    const groups = new Map<string, AlertWithProduct[]>();
    for (const alert of deliverable) {
      const key = `${alert.productId ?? 'system'}:${alert.firedAt.getTime()}`;
      groups.set(key, [...(groups.get(key) ?? []), alert]);
    }
    for (const group of groups.values()) {
      const message = group.map((a) => this.render(a, settings)).join('\n\n');
      await this.sendAndRecord(ctx.bot, ctx.chatId, message, group);
    }
  }

  /** Quiet hours ended: deliver everything held as ONE consolidated summary (FR-3.9). */
  private async flushHeld(): Promise<void> {
    const held: AlertWithProduct[] = await this.prisma.alert.findMany({
      where: { deliveryStatus: 'held_quiet_hours' },
      orderBy: { firedAt: 'asc' },
      take: 100,
      include: { product: true },
    });
    if (held.length === 0) return;
    const ctx = await this.getBot();
    if (!ctx || !ctx.chatId) return; // stays held; retried next dispatch
    const { settings } = await getUserWithSettings(this.prisma);

    // Order by significance: target crossings, then biggest drops, then the rest
    const significance = (a: AlertWithProduct): number =>
      a.type === 'target_price'
        ? 0
        : a.type === 'threshold_drop'
          ? 1 - Math.min(0.99, Math.abs(Number(a.changePct ?? 0)) / 100)
          : 2;
    const ordered = [...held].sort((a, b) => significance(a) - significance(b));
    const lines = ordered.map(
      (a) => `• ${this.render(a, settings).split('\n').slice(1).join(' — ')}`,
    );
    const message = `🌙 <b>While you were away</b> — ${held.length} alert${held.length === 1 ? '' : 's'} held during quiet hours:\n\n${lines.join('\n')}`;
    await this.sendAndRecord(ctx.bot, ctx.chatId, message, held);
  }

  /** Daily/weekly digest (FR-3.10): a summary, never a replacement for real-time alerts. */
  private async maybeSendDigest(settings: Settings, now: Date): Promise<void> {
    const status = await this.prisma.systemStatus.findUnique({ where: { id: 1 } });
    if (
      !isDigestDue(
        settings.digestFrequency,
        settings.digestTime,
        settings.timezone,
        status?.lastDigestAt ?? null,
        now,
      )
    ) {
      return;
    }
    const ctx = await this.getBot();
    if (!ctx || !ctx.chatId) return;

    const periodMs = settings.digestFrequency === 'weekly' ? 7 * 24 * 3600_000 : 24 * 3600_000;
    const since = status?.lastDigestAt ?? new Date(now.getTime() - periodMs);

    const [alerts, nearLow, pausedAuto] = await Promise.all([
      this.prisma.alert.findMany({
        where: { firedAt: { gte: since }, deliveryStatus: { not: 'suppressed' } },
        include: { product: true },
      }),
      this.prisma.product.findMany({
        where: { status: 'active', currentPrice: { not: null }, allTimeLow: { not: null } },
        orderBy: { updatedAt: 'desc' },
        take: 200,
      }),
      this.prisma.product.count({ where: { status: 'paused_auto' } }),
    ]);

    const drops = alerts.filter((a) => a.type === 'threshold_drop' || a.type === 'target_price');
    const offerChanges = alerts.filter((a) => a.type === 'offer_change').length;
    const stockChanges = alerts.filter((a) => a.type === 'back_in_stock').length;
    const nearLowThreshold = 1 + Number(settings.nearLowThresholdPct) / 100;
    const atLow = nearLow.filter(
      (p) => Number(p.currentPrice) <= Number(p.allTimeLow) * nearLowThreshold,
    );

    const parts: string[] = [
      `📰 <b>PricePulse ${settings.digestFrequency} digest</b>`,
      `${drops.length} price drop${drops.length === 1 ? '' : 's'}, ${offerChanges} offer change${offerChanges === 1 ? '' : 's'}, ${stockChanges} back in stock.`,
    ];
    if (drops.length > 0) {
      const top = drops
        .slice(0, 5)
        .map(
          (a) =>
            `• ${escapeHtml(a.product?.displayName ?? '?')}: ${formatInr(Number((a.newValue as { price?: number })?.price ?? 0))} (${a.changePct ?? '—'}%)`,
        );
      parts.push(top.join('\n'));
    }
    if (atLow.length > 0) {
      parts.push(
        `🔥 At or near recorded lows:\n${atLow
          .slice(0, 5)
          .map(
            (p) =>
              `• ${escapeHtml(p.displayName)} — ${formatInr(Number(p.currentPrice))} on ${MARKETPLACE_LABELS[p.marketplace]}`,
          )
          .join('\n')}`,
      );
    }
    if (pausedAuto > 0) {
      parts.push(
        `⚠️ ${pausedAuto} product${pausedAuto === 1 ? '' : 's'} auto-paused and needing attention.`,
      );
    }
    if (drops.length + offerChanges + stockChanges === 0 && atLow.length === 0) {
      parts.push('No changes across your catalogue this period.');
    }

    const outcome = await this.sendWithRetry(ctx.bot, ctx.chatId, parts.join('\n\n'));
    if (outcome.ok) {
      await this.prisma.systemStatus.update({
        where: { id: 1 },
        data: { lastDigestAt: now },
      });
    }
  }

  private async sendAndRecord(
    bot: Bot,
    chatId: string,
    message: string,
    alerts: AlertWithProduct[],
  ): Promise<void> {
    const outcome = await this.sendWithRetry(bot, chatId, message);
    // Persist the exact message that was sent so the UI can show it (FR-4.2).
    await this.prisma.alert.updateMany({
      where: { id: { in: alerts.map((a) => a.id) } },
      data: outcome.ok
        ? { deliveryStatus: 'delivered', deliveredAt: new Date(), deliveryError: null, message }
        : { deliveryStatus: 'failed', deliveryError: outcome.error, message },
    });
  }

  private render(alert: AlertWithProduct, settings: Settings): string {
    const templates = (settings.notificationTemplates ?? {}) as Record<string, string>;
    return renderAlertMessage(
      {
        type: alert.type,
        productName: alert.product?.displayName ?? 'PricePulse',
        marketplace: alert.product?.marketplace ?? 'amazon_in',
        listingUrl: alert.product?.url ?? '',
        oldValue: alert.oldValue,
        newValue: alert.newValue,
        changePct: alert.changePct === null ? null : Number(alert.changePct),
        firedAt: alert.firedAt,
      },
      { template: templates[alert.type], timezone: settings.timezone },
    );
  }

  private async sendWithRetry(
    bot: Bot,
    chatId: string,
    html: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    let lastError = '';
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      try {
        await bot.api.sendMessage(chatId, html, {
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
        });
        return { ok: true };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (/401|chat not found|bot was blocked/i.test(lastError)) break;
        const retryAfter = (err as { parameters?: { retry_after?: number } }).parameters
          ?.retry_after;
        const delay = retryAfter ? retryAfter * 1000 : RETRY_DELAYS_MS[attempt];
        if (delay === undefined) break;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
    return { ok: false, error: lastError };
  }
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
