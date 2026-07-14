import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Bot, Context } from 'grammy';
import { InlineKeyboard } from 'grammy';
import { randomUUID } from 'node:crypto';
import { getUserWithSettings, previewUrl, registerProduct } from '@pricepulse/core';
import type { PreviewResult } from '@pricepulse/core';
import {
  FAILURE_REASON_LABELS,
  MARKETPLACE_LABELS,
  formatInr,
  formatRelativeTime,
} from '@pricepulse/shared';
import type { FailureReason } from '@pricepulse/shared';
import { PrismaService } from '../prisma.service.js';
import { TelegramService } from './telegram.service.js';
import { CheckRunnerService } from '../check-runner.service.js';

const PAGE_SIZE = 8;

/**
 * Two-way bot interface, Milestone 1 command set (WP-1.9): start, add (with
 * preview + confirm/cancel), list (paginated), check, checkall, status,
 * test, help. Responds ONLY to the bound chat (allowlist); registration
 * goes through the identical core service path as the API (parity rule).
 */
@Injectable()
export class BotService implements OnModuleInit, OnModuleDestroy {
  private bot: Bot | null = null;
  private watchTimer: NodeJS.Timeout | null = null;
  /** Pending add-previews awaiting Confirm/Cancel, keyed by short id. */
  private readonly pendingAdds = new Map<string, Extract<PreviewResult, { kind: 'preview' }>>();
  /** Last /list result per chat: index → productId (for `/check 3`). */
  private lastListing: string[] = [];

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(TelegramService) private readonly telegram: TelegramService,
    @Inject(CheckRunnerService) private readonly runner: CheckRunnerService,
  ) {}

  onModuleInit(): void {
    // Watch for token configuration/changes each minute and (re)start polling.
    this.watchTimer = setInterval(() => void this.ensureStarted(), 60_000);
    void this.ensureStarted();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.watchTimer) clearInterval(this.watchTimer);
    await this.bot?.stop().catch(() => undefined);
  }

  private async ensureStarted(): Promise<void> {
    const ctx = await this.telegram.getBot();
    if (!ctx || this.bot === ctx.bot) return;
    await this.bot?.stop().catch(() => undefined);
    this.bot = ctx.bot;
    this.wire(this.bot);
    this.bot.start({ drop_pending_updates: true }).catch((err) => {
      console.error('Bot polling stopped:', err instanceof Error ? err.message : err);
      this.bot = null; // force re-create on next watch tick
    });
    console.log('Telegram bot polling started');
  }

  private wire(bot: Bot): void {
    // ── Allowlist (NFR-7): only the bound chat gets through; /start may bind once ──
    bot.use(async (ctx, next) => {
      const chatId = ctx.chat?.id?.toString();
      if (!chatId) return;
      const { user } = await getUserWithSettings(this.prisma);
      if (!user.telegramChatId) {
        if (ctx.message?.text?.startsWith('/start')) {
          await this.prisma.user.update({
            where: { id: user.id },
            data: { telegramChatId: chatId },
          });
          await ctx.reply(
            'PricePulse bound to this chat. Alerts will arrive here.\n\n' + helpText(),
          );
        }
        return;
      }
      if (user.telegramChatId !== chatId) {
        console.warn(`Ignored message from unbound chat ${chatId}`);
        return;
      }
      await next();
    });

    bot.command('start', (ctx) => ctx.reply('Already bound to this chat. ' + helpText()));
    bot.command('help', (ctx) => ctx.reply(helpText()));

    bot.command('add', async (ctx) => {
      const url = ctx.match?.trim();
      if (!url) return void (await ctx.reply('Usage: /add <listing URL>'));
      await ctx.reply('Checking the listing — usually under 15 seconds…');
      const result = await previewUrl(
        {
          prisma: this.prisma,
          registry: this.runner.registry,
          browserFetch: this.runner.browserFetch,
        },
        url,
      );
      await this.replyToPreview(ctx, result);
    });

    bot.callbackQuery(/^add:(confirm|cancel):(.+)$/, async (ctx) => {
      const [, action, id] = ctx.match!;
      const pending = this.pendingAdds.get(id!);
      await ctx.answerCallbackQuery();
      if (!pending) return void (await ctx.reply('That preview expired — send /add again.'));
      this.pendingAdds.delete(id!);
      if (action === 'cancel') return void (await ctx.reply('Cancelled — nothing was saved.'));
      const product = await registerProduct(
        { prisma: this.prisma, registry: this.runner.registry },
        {
          url: pending.url,
          canonicalUrl: pending.canonicalUrl,
          marketplace: pending.marketplace,
          marketplaceProductId: pending.productId,
          snapshot: pending.snapshot,
        },
      );
      await ctx.reply(
        `✅ Tracking <b>${escapeHtml(product.displayName)}</b> at ${formatInr(Number(product.currentPrice))}.\nIt will be checked automatically from now on.`,
        { parse_mode: 'HTML' },
      );
    });

    bot.command('list', async (ctx) => this.sendListing(ctx, 0));
    bot.callbackQuery(/^list:(\d+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      await this.sendListing(ctx, Number(ctx.match![1]));
    });

    bot.command('check', async (ctx) => {
      const n = Number(ctx.match?.trim());
      const productId = this.lastListing[n - 1];
      if (!productId) {
        return void (await ctx.reply('Usage: /check <number from /list> — run /list first.'));
      }
      await ctx.reply('Checking now…');
      const result = await this.runner.checkProductById(productId);
      const product = await this.prisma.product.findUnique({ where: { id: productId } });
      if (!result || !product) return void (await ctx.reply('Product not found.'));
      if (result.success) {
        await ctx.reply(
          `✅ ${escapeHtml(product.displayName)}: ${formatInr(Number(product.currentPrice))} · ${product.currentStockStatus === 'in_stock' ? 'in stock' : 'out of stock'}${result.events.length ? `\n${result.events.length} alert(s) fired.` : ''}`,
          { parse_mode: 'HTML' },
        );
      } else {
        const reason = await this.lastFailureReason(productId);
        await ctx.reply(
          `❌ Check failed: ${reason}${result.autoPaused ? '\nProduct auto-paused.' : ''}`,
        );
      }
    });

    bot.command('checkall', async (ctx) => {
      const { count } = await this.prisma.product.updateMany({
        where: { status: 'active' },
        data: { nextCheckAt: new Date() },
      });
      await ctx.reply(
        `Queued ${count} products for checking. They will be paced politely — watch /status.`,
      );
    });

    // ── Milestone 3 (WP-3.2): full management commands, parity with the dashboard ──

    bot.command('pause', async (ctx) => {
      const product = await this.refToProduct(ctx.match);
      if (!product) return void (await ctx.reply('Usage: /pause <number from /list>'));
      await this.prisma.product.update({
        where: { id: product.id },
        data: { status: 'paused_user' },
      });
      await ctx.reply(`⏸ Paused “${product.displayName}”. Resume with /resume.`);
    });

    bot.command('resume', async (ctx) => {
      const product = await this.refToProduct(ctx.match);
      if (!product) return void (await ctx.reply('Usage: /resume <number from /list>'));
      await this.prisma.product.update({
        where: { id: product.id },
        data: { status: 'active', consecutiveFailures: 0, nextCheckAt: new Date() },
      });
      await ctx.reply(`▶ Resumed “${product.displayName}” — checking it shortly.`);
    });

    bot.command('target', async (ctx) => {
      const parts = (ctx.match ?? '').trim().split(/\s+/);
      const product = await this.refToProduct(parts[0]);
      if (!product)
        return void (await ctx.reply('Usage: /target <number from /list> <price> (or "clear")'));
      if (parts[1] === 'clear') {
        await this.prisma.product.update({
          where: { id: product.id },
          data: { targetPrice: null, targetCrossed: false },
        });
        return void (await ctx.reply(`Target cleared for “${product.displayName}”.`));
      }
      const price = Number(parts[1]?.replace(/[₹,]/g, ''));
      if (!(price > 0))
        return void (await ctx.reply('Give a positive price, e.g. /target 3 45000'));
      await this.prisma.product.update({
        where: { id: product.id },
        data: { targetPrice: price, targetCrossed: false },
      });
      const note =
        product.currentPrice !== null && price >= Number(product.currentPrice)
          ? ' Target is at/above the current price — you will be alerted after a rise and drop back.'
          : '';
      await ctx.reply(`🎯 Target for “${product.displayName}” set to ${formatInr(price)}.${note}`);
    });

    bot.command('remove', async (ctx) => {
      const product = await this.refToProduct(ctx.match);
      if (!product) return void (await ctx.reply('Usage: /remove <number from /list>'));
      const [historyCount, alertCount] = await Promise.all([
        this.prisma.priceHistory.count({ where: { productId: product.id } }),
        this.prisma.alert.count({ where: { productId: product.id } }),
      ]);
      const keyboard = new InlineKeyboard()
        .text('🗑 Yes, delete permanently', `remove:confirm:${product.id}`)
        .text('Cancel', 'remove:cancel');
      await ctx.reply(
        `Delete “${product.displayName}”?\nThis permanently removes ${historyCount} history records and ${alertCount} alerts.`,
        { reply_markup: keyboard },
      );
    });

    bot.callbackQuery('remove:cancel', async (ctx) => {
      await ctx.answerCallbackQuery();
      await ctx.reply('Cancelled — nothing was deleted.');
    });

    bot.callbackQuery(/^remove:confirm:(.+)$/, async (ctx) => {
      await ctx.answerCallbackQuery();
      const id = ctx.match![1]!;
      const product = await this.prisma.product.findUnique({ where: { id } });
      if (!product) return void (await ctx.reply('Already gone.'));
      await this.prisma.product.delete({ where: { id } });
      await ctx.reply(`Deleted “${product.displayName}” and all its history.`);
    });

    bot.command('search', async (ctx) => {
      const term = ctx.match?.trim();
      if (!term) return void (await ctx.reply('Usage: /search <text>'));
      const products = await this.prisma.product.findMany({
        where: {
          OR: [
            { displayName: { contains: term, mode: 'insensitive' } },
            { url: { contains: term, mode: 'insensitive' } },
          ],
        },
        take: 8,
        orderBy: { createdAt: 'asc' },
      });
      if (products.length === 0) return void (await ctx.reply(`Nothing matches “${term}”.`));
      this.lastListing = products.map((p) => p.id);
      const lines = products.map((p, i) => {
        const price =
          p.currentPrice !== null ? formatInr(Number(p.currentPrice)) : 'awaiting first check';
        return `${i + 1}. <b>${escapeHtml(p.displayName)}</b> — ${price}`;
      });
      await ctx.reply(
        `Matches for “${escapeHtml(term)}” (numbers work with /check, /pause, /target…):\n\n${lines.join('\n')}`,
        { parse_mode: 'HTML' },
      );
    });

    bot.command('status', async (ctx) => {
      const [status, total, active, pausedAuto, pausedUser] = await Promise.all([
        this.prisma.systemStatus.findUnique({ where: { id: 1 } }),
        this.prisma.product.count(),
        this.prisma.product.count({ where: { status: 'active' } }),
        this.prisma.product.count({ where: { status: 'paused_auto' } }),
        this.prisma.product.count({ where: { status: 'paused_user' } }),
      ]);
      const heartbeat = status?.workerHeartbeatAt
        ? formatRelativeTime(status.workerHeartbeatAt)
        : 'never';
      const lastCycle = status?.lastCycleEndedAt
        ? `${formatRelativeTime(status.lastCycleEndedAt)} (${status.lastCycleSucceeded} ok / ${status.lastCycleFailed} failed of ${status.lastCycleDue} due)`
        : 'no cycle completed yet';
      await ctx.reply(
        [
          '🩺 PricePulse status',
          `Products: ${total} (${active} active, ${pausedUser} paused, ${pausedAuto} auto-paused)`,
          `Last cycle: ${lastCycle}`,
          `7-day check success: ${status?.successRate7d ?? '—'}%`,
          `Worker heartbeat: ${heartbeat}`,
        ].join('\n'),
      );
    });

    bot.command('test', async (ctx) => {
      const result = await this.telegram.sendTest();
      if (!result.ok) await ctx.reply(`Test failed: ${result.error}`);
    });

    bot.on('message:text', async (ctx) => {
      const text = ctx.message.text.trim();
      // Bare URLs are treated as /add (FR-4.4)
      if (/^https?:\/\//i.test(text)) {
        await ctx.reply('Checking the listing — usually under 15 seconds…');
        const result = await previewUrl(
          {
            prisma: this.prisma,
            registry: this.runner.registry,
            browserFetch: this.runner.browserFetch,
          },
          text,
        );
        await this.replyToPreview(ctx, result);
        return;
      }
      await ctx.reply(`I didn't understand that. ${helpText()}`);
    });
  }

  private async replyToPreview(ctx: Context, result: PreviewResult): Promise<void> {
    switch (result.kind) {
      case 'unsupported':
        await ctx.reply(
          `That site${result.detectedSite ? ` (${result.detectedSite})` : ''} isn't supported. PricePulse tracks Amazon India (amazon.in) and Flipkart (flipkart.com) listings.`,
        );
        return;
      case 'not_a_listing':
        await ctx.reply(
          `That looks like ${MARKETPLACE_LABELS[result.marketplace]}, but not a product page. Paste the URL of a specific product listing.`,
        );
        return;
      case 'duplicate':
        await ctx.reply(
          `Already tracking this product as “${result.displayName}”${result.status !== 'active' ? ' (currently paused)' : ''}.`,
        );
        return;
      case 'fetch_failed':
        await ctx.reply(
          `Couldn't read the listing: ${FAILURE_REASON_LABELS[result.reason as FailureReason] ?? result.message}. Try again in a minute.`,
        );
        return;
      case 'preview': {
        const id = randomUUID().slice(0, 8);
        this.pendingAdds.set(id, result);
        const s = result.snapshot;
        const offers = s.offers.length
          ? `\nOffers:\n${s.offers.map((o) => `• ${escapeHtml(o.description)}`).join('\n')}`
          : '';
        const keyboard = new InlineKeyboard()
          .text('✅ Track it', `add:confirm:${id}`)
          .text('❌ Cancel', `add:cancel:${id}`);
        const priceLine =
          s.price === null
            ? 'Price: <b>unavailable (out of stock)</b>'
            : `Price: <b>${formatInr(s.price)}</b>${s.mrp !== null && s.mrp > s.price ? ` (MRP ${formatInr(s.mrp)}, ${s.discountPct}% off)` : ''}`;
        await ctx.reply(
          `<b>${escapeHtml(s.name)}</b>\n${MARKETPLACE_LABELS[s.marketplace]} · ${s.stockStatus === 'in_stock' ? 'In stock' : 'Out of stock'}\n${priceLine}${offers}\n\nIs this the right product?`,
          { parse_mode: 'HTML', reply_markup: keyboard },
        );
      }
    }
  }

  private async sendListing(ctx: Context, page: number): Promise<void> {
    const [products, total] = await Promise.all([
      this.prisma.product.findMany({
        orderBy: { createdAt: 'asc' },
        skip: page * PAGE_SIZE,
        take: PAGE_SIZE,
      }),
      this.prisma.product.count(),
    ]);
    if (total === 0) {
      await ctx.reply('No products tracked yet. Send /add <url> or just paste a listing URL.');
      return;
    }
    this.lastListing = products.map((p) => p.id);
    const lines = products.map((p, i) => {
      const price =
        p.currentPrice !== null ? formatInr(Number(p.currentPrice)) : 'awaiting first check';
      const statusFlag =
        p.status === 'paused_auto'
          ? ' ⚠️ auto-paused'
          : p.status === 'paused_user'
            ? ' ⏸ paused'
            : '';
      const checked = p.lastCheckedAt ? formatRelativeTime(p.lastCheckedAt) : 'never';
      return `${page * PAGE_SIZE + i + 1}. <b>${escapeHtml(p.displayName)}</b>${statusFlag}\n    ${MARKETPLACE_LABELS[p.marketplace]} · ${price} · checked ${checked}`;
    });
    const totalPages = Math.ceil(total / PAGE_SIZE);
    const keyboard = new InlineKeyboard();
    if (page > 0) keyboard.text('◀ Prev', `list:${page - 1}`);
    if (page < totalPages - 1) keyboard.text('Next ▶', `list:${page + 1}`);
    await ctx.reply(
      `Tracked products (page ${page + 1}/${totalPages}):\n\n${lines.join('\n')}\n\nUse /check <number> for an immediate check.`,
      {
        parse_mode: 'HTML',
        ...(keyboard.inline_keyboard.length ? { reply_markup: keyboard } : {}),
      },
    );
  }

  /** Resolve a "/command <n>" reference against the last /list or /search shown. */
  private async refToProduct(ref: string | undefined) {
    const n = Number(ref?.trim().split(/\s+/)[0]);
    const id = this.lastListing[n - 1];
    if (!id) return null;
    return this.prisma.product.findUnique({ where: { id } });
  }

  private async lastFailureReason(productId: string): Promise<string> {
    const last = await this.prisma.priceHistory.findFirst({
      where: { productId, success: false },
      orderBy: { checkedAt: 'desc' },
    });
    return last?.failureReason ? FAILURE_REASON_LABELS[last.failureReason] : 'Unknown failure';
  }
}

function helpText(): string {
  return [
    'Commands:',
    '/add <url> — track a product (or just paste a URL)',
    '/list — tracked products',
    '/search <text> — find products',
    '/check <n> — check a product now',
    '/checkall — check everything now (paced)',
    '/pause <n> · /resume <n> — control monitoring',
    '/target <n> <price> — set a target (or "clear")',
    '/remove <n> — delete a product (asks first)',
    '/status — system health',
    '/test — test notification',
  ].join('\n');
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
