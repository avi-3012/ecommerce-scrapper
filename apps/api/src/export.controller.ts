import { Controller, Get, Inject, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { PriceHistory, ScrapeAudit } from '@pricepulse/db';
import { PrismaService } from './prisma.service.js';

/**
 * Data export (FR-6.3, WP-3.5): the user's data as CSV, streamed so a
 * multi-year history export never exhausts memory. Timestamps are ISO-8601
 * UTC (stated in the header row); prices are plain numbers.
 * The products export round-trips with the bulk-import template.
 */
@Controller('export')
export class ExportController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('products.csv')
  async products(@Res() res: Response): Promise<void> {
    startCsv(res, 'pricepulse-products.csv');
    res.write(
      row([
        'url',
        'name',
        'target price',
        'threshold',
        'notes',
        'tags',
        'marketplace',
        'status',
        'current price',
        'mrp',
        'stock',
        'all-time low',
        'all-time high',
        'last checked (UTC)',
      ]),
    );
    const products = await this.prisma.product.findMany({ orderBy: { createdAt: 'asc' } });
    for (const p of products) {
      res.write(
        row([
          p.url,
          p.displayName,
          p.targetPrice,
          p.dropThresholdPct,
          p.notes,
          p.tags.join(', '),
          p.marketplace,
          p.status,
          p.currentPrice,
          p.currentMrp,
          p.currentStockStatus,
          p.allTimeLow,
          p.allTimeHigh,
          p.lastCheckedAt?.toISOString() ?? '',
        ]),
      );
    }
    res.end();
  }

  @Get('history.csv')
  async history(@Res() res: Response, @Query('productId') productId?: string): Promise<void> {
    startCsv(res, 'pricepulse-history.csv');
    res.write(
      row([
        'product',
        'marketplace',
        'checked at (UTC)',
        'success',
        'price',
        'mrp',
        'discount %',
        'stock',
        'offers',
        'failure reason',
      ]),
    );
    const names = new Map(
      (
        await this.prisma.product.findMany({
          select: { id: true, displayName: true, marketplace: true },
        })
      ).map((p) => [p.id, p]),
    );
    // Stream in keyset-paginated batches — million-row-safe (NFR-4/5)
    let cursor: { id: bigint; checkedAt: Date } | null = null;
    for (;;) {
      const batch: PriceHistory[] = await this.prisma.priceHistory.findMany({
        where: {
          ...(productId ? { productId } : {}),
          ...(cursor
            ? {
                OR: [
                  { checkedAt: { gt: cursor.checkedAt } },
                  { checkedAt: cursor.checkedAt, id: { gt: cursor.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ checkedAt: 'asc' }, { id: 'asc' }],
        take: 5000,
      });
      if (batch.length === 0) break;
      for (const h of batch) {
        const p = names.get(h.productId);
        res.write(
          row([
            p?.displayName ?? h.productId,
            p?.marketplace ?? '',
            h.checkedAt.toISOString(),
            h.success ? 'yes' : 'no',
            h.price,
            h.mrp,
            h.discountPct,
            h.stockStatus,
            JSON.stringify(h.offers),
            h.failureReason ?? '',
          ]),
        );
      }
      const last = batch[batch.length - 1]!;
      cursor = { id: last.id, checkedAt: last.checkedAt };
    }
    res.end();
  }

  /**
   * Per-check scrape-audit trail (debugging). The key columns for diagnosing
   * price flapping: `pincode requested` (is a pincode even set?), `pincode
   * applied` + `verified` (did the marketplace honour it?), `price source`
   * (did the localized price win, or the IP-default HTML?), and `api price` vs
   * `html price` (how far they diverge). `?productId=` filters to one product.
   */
  @Get('scrape-audit.csv')
  async scrapeAudit(@Res() res: Response, @Query('productId') productId?: string): Promise<void> {
    startCsv(res, 'pricepulse-scrape-audit.csv');
    res.write(
      row([
        'product',
        'marketplace',
        'checked at (UTC)',
        'success',
        'tier',
        'scraped name',
        'price',
        'mrp',
        'stock',
        'price source',
        'offers count',
        'offers hash',
        'pincode requested',
        'pincode applied',
        'verified',
        'api status',
        'api price',
        'html price',
        'exit ip',
        'proxy session',
        'duration ms',
        'failure reason',
        'failure detail',
        'debug (json)',
      ]),
    );
    const names = new Map(
      (
        await this.prisma.product.findMany({
          select: { id: true, displayName: true, marketplace: true },
        })
      ).map((p) => [p.id, p]),
    );
    let cursor: bigint | null = null;
    for (;;) {
      const batch: ScrapeAudit[] = await this.prisma.scrapeAudit.findMany({
        where: {
          ...(productId ? { productId } : {}),
          ...(cursor ? { id: { gt: cursor } } : {}),
        },
        orderBy: { id: 'asc' },
        take: 5000,
      });
      if (batch.length === 0) break;
      for (const a of batch) {
        const p = names.get(a.productId);
        res.write(
          row([
            p?.displayName ?? a.productId,
            a.marketplace,
            a.createdAt.toISOString(),
            a.success ? 'yes' : 'no',
            a.tier ?? '',
            a.name ?? '',
            a.price,
            a.mrp,
            a.stockStatus ?? '',
            a.priceSource ?? '',
            a.offersCount ?? '',
            a.offersHash ?? '',
            a.pincodeRequested ?? '',
            a.pincodeApplied ?? '',
            a.pincodeVerified === null ? '' : a.pincodeVerified ? 'yes' : 'no',
            a.pincodeApiStatus ?? '',
            a.apiPrice,
            a.htmlPrice,
            a.exitIp ?? '',
            a.proxySession ?? '',
            a.durationMs ?? '',
            a.failureReason ?? '',
            a.failureDetail ?? '',
            JSON.stringify(a.debug),
          ]),
        );
      }
      cursor = batch[batch.length - 1]!.id;
    }
    res.end();
  }

  /**
   * Per-product proxy bandwidth report (cost attribution). Aggregates the
   * scrape-audit trail over the retention window: how many checks ran, how many
   * succeeded/failed, how many needed retries or the (expensive) browser tier,
   * and the WIRE bytes each product cost — with a per-kind breakdown
   * (page vs pincode API vs cookie mint vs offer side-sheet vs browser).
   * `?days=` narrows the window (default = full 14-day retention).
   */
  @Get('proxy-usage.csv')
  async proxyUsage(@Res() res: Response, @Query('days') days?: string): Promise<void> {
    startCsv(res, 'pricepulse-proxy-usage.csv');
    res.write(
      row([
        'product',
        'marketplace',
        'scrapes',
        'succeeded',
        'failed',
        'retries',
        'tier-2 (browser)',
        'wire MB',
        'KB / scrape',
        'page MB (http)',
        'page MB (browser)',
        'pincode API MB',
        'cookie mint MB',
        'side-sheet MB',
      ]),
    );
    const windowDays = Math.min(Math.max(Number(days) || 14, 1), 60);
    const since = new Date(Date.now() - windowDays * 24 * 3600 * 1000);
    const names = new Map(
      (
        await this.prisma.product.findMany({
          select: { id: true, displayName: true, marketplace: true },
        })
      ).map((p) => [p.id, p]),
    );

    interface Agg {
      scrapes: number;
      ok: number;
      failed: number;
      retries: number;
      tier2: number;
      wire: number;
      httpPage: number;
      browserPage: number;
      pincodeApi: number;
      cookieMint: number;
      sideSheet: number;
    }
    const blank = (): Agg => ({
      scrapes: 0,
      ok: 0,
      failed: 0,
      retries: 0,
      tier2: 0,
      wire: 0,
      httpPage: 0,
      browserPage: 0,
      pincodeApi: 0,
      cookieMint: 0,
      sideSheet: 0,
    });
    const byProduct = new Map<string, Agg>();
    const kindBytes = (a: ScrapeAudit, kind: string): number => {
      const proxy = (a.debug as { proxy?: { byKind?: Record<string, { wireBytes?: number }> } })
        ?.proxy;
      return proxy?.byKind?.[kind]?.wireBytes ?? 0;
    };

    let cursor: bigint | null = null;
    for (;;) {
      const batch: ScrapeAudit[] = await this.prisma.scrapeAudit.findMany({
        where: { createdAt: { gte: since }, ...(cursor ? { id: { gt: cursor } } : {}) },
        orderBy: { id: 'asc' },
        take: 5000,
      });
      if (batch.length === 0) break;
      for (const a of batch) {
        const agg = byProduct.get(a.productId) ?? blank();
        agg.scrapes += 1;
        if (a.success) agg.ok += 1;
        else agg.failed += 1;
        agg.retries += a.proxyRetries ?? 0;
        agg.wire += a.bytesWire ?? 0;
        const mainPage = kindBytes(a, 'main_page');
        if (a.tier === 'browser') {
          agg.tier2 += 1;
          agg.browserPage += mainPage;
        } else {
          agg.httpPage += mainPage;
        }
        agg.pincodeApi += kindBytes(a, 'pincode_api');
        agg.cookieMint += kindBytes(a, 'cookie_mint');
        agg.sideSheet += kindBytes(a, 'side_sheet');
        byProduct.set(a.productId, agg);
      }
      cursor = batch[batch.length - 1]!.id;
    }

    const mb = (bytes: number): string => (bytes / 1e6).toFixed(1);
    const rows = [...byProduct.entries()].sort((x, y) => y[1].wire - x[1].wire);
    for (const [productId, a] of rows) {
      const p = names.get(productId);
      res.write(
        row([
          p?.displayName ?? productId,
          p?.marketplace ?? '',
          a.scrapes,
          a.ok,
          a.failed,
          a.retries,
          a.tier2,
          mb(a.wire),
          a.scrapes ? (a.wire / a.scrapes / 1024).toFixed(0) : '0',
          mb(a.httpPage),
          mb(a.browserPage),
          mb(a.pincodeApi),
          mb(a.cookieMint),
          mb(a.sideSheet),
        ]),
      );
    }
    res.end();
  }

  @Get('alerts.csv')
  async alerts(@Res() res: Response): Promise<void> {
    startCsv(res, 'pricepulse-alerts.csv');
    res.write(
      row([
        'product',
        'type',
        'fired at (UTC)',
        'change %',
        'old',
        'new',
        'delivery',
        'delivery error',
      ]),
    );
    const alerts = await this.prisma.alert.findMany({
      orderBy: { firedAt: 'asc' },
      include: { product: { select: { displayName: true } } },
    });
    for (const a of alerts) {
      res.write(
        row([
          a.product?.displayName ?? 'system',
          a.type,
          a.firedAt.toISOString(),
          a.changePct,
          JSON.stringify(a.oldValue),
          JSON.stringify(a.newValue),
          a.deliveryStatus,
          a.deliveryError ?? '',
        ]),
      );
    }
    res.end();
  }
}

function startCsv(res: Response, filename: string): void {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
}

function row(values: unknown[]): string {
  return (
    values
      .map((v) => {
        const s = v === null || v === undefined ? '' : String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(',') + '\n'
  );
}
