import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { createDefaultRegistry } from '@pricepulse/adapters';
import {
  deleteProduct,
  deletionImpact,
  pauseProduct,
  previewUrl,
  registerProduct,
  resumeProduct,
} from '@pricepulse/core';
import type { PreviewResult } from '@pricepulse/core';
import { MARKETPLACES, STOCK_STATUSES, PRODUCT_STATUSES } from '@pricepulse/shared';
import type { Prisma } from '@pricepulse/db';
import { PrismaService } from '../prisma.service.js';
import { JobsService } from '../jobs.service.js';
import { BrowserService } from '../browser.service.js';
import { parseBody } from '../validation.js';

const offerSchema = z.object({ type: z.string(), description: z.string() });

const snapshotSchema = z.object({
  marketplace: z.enum(MARKETPLACES),
  marketplaceProductId: z.string(),
  name: z.string().min(1),
  price: z.number().nonnegative().nullable(),
  mrp: z.number().nonnegative().nullable(),
  discountPct: z.number(),
  offers: z.array(offerSchema),
  stockStatus: z.enum(STOCK_STATUSES),
  imageUrl: z.string().nullable(),
  provenance: z.record(z.string()),
});

const configurableFields = {
  displayName: z.string().min(1).max(300).optional(),
  targetPrice: z.number().positive().nullable().optional(),
  dropThresholdPct: z.number().min(0).max(99).nullable().optional(),
  notes: z.string().max(5000).optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
};

const registerSchema = z.object({
  url: z.string().url(),
  canonicalUrl: z.string().url(),
  marketplace: z.enum(MARKETPLACES),
  marketplaceProductId: z.string(),
  snapshot: snapshotSchema,
  ...configurableFields,
});

const editSchema = z.object(configurableFields);

const listQuerySchema = z.object({
  search: z.string().optional(),
  marketplace: z.enum(MARKETPLACES).optional(),
  tag: z.string().optional(),
  stock: z.enum(STOCK_STATUSES).optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  health: z.enum(['healthy', 'failing', 'auto_paused']).optional(),
  sort: z
    .enum(['recent', 'name', 'price_asc', 'price_desc', 'biggest_drop', 'recently_changed'])
    .default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const SORT_ORDER: Record<string, Prisma.ProductOrderByWithRelationInput> = {
  recent: { createdAt: 'desc' },
  name: { displayName: 'asc' },
  price_asc: { currentPrice: 'asc' },
  price_desc: { currentPrice: 'desc' },
  biggest_drop: { currentDiscountPct: 'desc' },
  recently_changed: { lastChangedAt: 'desc' },
};

@Controller('products')
export class ProductsController {
  private readonly registry = createDefaultRegistry();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(JobsService) private readonly jobs: JobsService,
    @Inject(BrowserService) private readonly browser: BrowserService,
  ) {}

  /**
   * FR-1.2/1.3/1.5: recognise → duplicate-check → live fetch → preview.
   * Passes the browser tier so a tier-1 block (e.g. Flipkart anti-bot) can
   * escalate to a real browser instead of hard-failing the preview (R-2).
   */
  @Post('preview')
  @HttpCode(200)
  async preview(@Body() body: unknown): Promise<PreviewResult> {
    const { url } = parseBody(z.object({ url: z.string().min(1) }), body);
    return previewUrl(
      { prisma: this.prisma, registry: this.registry, browserFetch: await this.browser.get() },
      url,
    );
  }

  /** FR-1.1/1.4: persist a confirmed preview and begin tracking. */
  @Post()
  async register(@Body() body: unknown) {
    const params = parseBody(registerSchema, body);
    return registerProduct(
      { prisma: this.prisma, registry: this.registry },
      {
        ...params,
        snapshot: {
          ...params.snapshot,
          offers: params.snapshot.offers.map((o) => ({
            type: o.type as never,
            description: o.description,
          })),
        },
      },
    );
  }

  /** Catalogue listing with the FR-5.3 filter dimensions. */
  @Get()
  async list(@Query() query: Record<string, string>) {
    const q = parseBody(listQuerySchema, query);
    const where: Prisma.ProductWhereInput = {
      ...(q.search
        ? {
            OR: [
              { displayName: { contains: q.search, mode: 'insensitive' } },
              { url: { contains: q.search, mode: 'insensitive' } },
            ],
          }
        : {}),
      ...(q.marketplace ? { marketplace: q.marketplace } : {}),
      ...(q.tag ? { tags: { has: q.tag } } : {}),
      ...(q.stock ? { currentStockStatus: q.stock } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.health === 'auto_paused' ? { status: 'paused_auto' as const } : {}),
      ...(q.health === 'failing' ? { consecutiveFailures: { gt: 0 } } : {}),
      ...(q.health === 'healthy' ? { consecutiveFailures: 0, status: 'active' as const } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.product.findMany({
        where,
        orderBy: SORT_ORDER[q.sort] ?? SORT_ORDER.recent,
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.product.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  @Get(':id')
  async get(@Param('id') id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException();
    return product;
  }

  /** FR-2.3 made visible: every check, success or failure with reason. */
  @Get(':id/history')
  async history(@Param('id') id: string, @Query() query: Record<string, string>) {
    const q = parseBody(
      z.object({
        page: z.coerce.number().int().min(1).default(1),
        pageSize: z.coerce.number().int().min(1).max(200).default(50),
        failedOnly: z.coerce.boolean().default(false),
      }),
      query,
    );
    const where = { productId: id, ...(q.failedOnly ? { success: false } : {}) };
    const [items, total] = await Promise.all([
      this.prisma.priceHistory.findMany({
        where,
        orderBy: { checkedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
      }),
      this.prisma.priceHistory.count({ where }),
    ]);
    return { items: items.map((row) => ({ ...row, id: String(row.id) })), total, page: q.page };
  }

  /** FR-5.4 chart data: successful checks (points) + failed checks (markers) in the window. */
  @Get(':id/chart')
  async chart(@Param('id') id: string, @Query() query: Record<string, string>) {
    const q = parseBody(
      z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }),
      query,
    );
    const since = new Date(Date.now() - q.days * 24 * 3600 * 1000);
    const rows = await this.prisma.priceHistory.findMany({
      where: { productId: id, checkedAt: { gte: since } },
      orderBy: { checkedAt: 'asc' },
      take: 2000,
      select: {
        checkedAt: true,
        success: true,
        price: true,
        mrp: true,
        stockStatus: true,
        failureReason: true,
      },
    });
    // Deal-quality stats (FR-5.5): low/high maintained incrementally, average computed here
    const [product, avg] = await Promise.all([
      this.prisma.product.findUnique({
        where: { id },
        select: { allTimeLow: true, allTimeHigh: true },
      }),
      this.prisma.priceHistory.aggregate({
        where: { productId: id, success: true, price: { not: null } },
        _avg: { price: true },
      }),
    ]);
    return {
      points: rows
        .filter((r) => r.success)
        .map((r) => ({
          t: r.checkedAt,
          price: r.price === null ? null : Number(r.price),
          mrp: r.mrp === null ? null : Number(r.mrp),
          outOfStock: r.stockStatus === 'out_of_stock',
        })),
      failures: rows
        .filter((r) => !r.success)
        .map((r) => ({ t: r.checkedAt, reason: r.failureReason })),
      stats: {
        allTimeLow: product?.allTimeLow === null ? null : Number(product?.allTimeLow),
        allTimeHigh: product?.allTimeHigh === null ? null : Number(product?.allTimeHigh),
        average: avg._avg.price === null ? null : Math.round(Number(avg._avg.price)),
      },
    };
  }

  /** FR-1.8: link two listings (one per marketplace) as the same product. */
  @Post(':id/link')
  @HttpCode(200)
  async link(@Param('id') id: string, @Body() body: unknown) {
    const { otherId } = parseBody(z.object({ otherId: z.string().uuid() }), body);
    const [a, b] = await Promise.all([
      this.prisma.product.findUnique({ where: { id } }),
      this.prisma.product.findUnique({ where: { id: otherId } }),
    ]);
    if (!a || !b) throw new NotFoundException();
    if (a.id === b.id)
      throw new BadRequestException({ message: 'Cannot link a product to itself' });
    if (a.marketplace === b.marketplace) {
      throw new BadRequestException({
        message: 'Link one Amazon listing with one Flipkart listing',
      });
    }
    if (a.linkedProductId || b.linkedProductId) {
      throw new BadRequestException({ message: 'One of these products is already linked' });
    }
    await this.prisma.$transaction([
      this.prisma.product.update({ where: { id: a.id }, data: { linkedProductId: b.id } }),
      this.prisma.product.update({ where: { id: b.id }, data: { linkedProductId: a.id } }),
    ]);
    return { linked: true };
  }

  @Post(':id/unlink')
  @HttpCode(200)
  async unlink(@Param('id') id: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException();
    const ids = [product.id, product.linkedProductId].filter(Boolean) as string[];
    await this.prisma.product.updateMany({
      where: { id: { in: ids } },
      data: { linkedProductId: null },
    });
    return { linked: false };
  }

  /** FR-5.6: both sides of a linked pair with both price histories. */
  @Get(':id/compare')
  async compare(@Param('id') id: string, @Query() query: Record<string, string>) {
    const q = parseBody(
      z.object({ days: z.coerce.number().int().min(1).max(3650).default(30) }),
      query,
    );
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException();
    if (!product.linkedProductId)
      throw new BadRequestException({ message: 'Product is not linked' });
    const other = await this.prisma.product.findUnique({ where: { id: product.linkedProductId } });
    if (!other) throw new NotFoundException();

    const since = new Date(Date.now() - q.days * 24 * 3600 * 1000);
    const series = await Promise.all(
      [product, other].map(async (p) => ({
        product: p,
        points: (
          await this.prisma.priceHistory.findMany({
            where: { productId: p.id, checkedAt: { gte: since }, success: true },
            orderBy: { checkedAt: 'asc' },
            take: 2000,
            select: { checkedAt: true, price: true },
          })
        ).map((r) => ({ t: r.checkedAt, price: r.price === null ? null : Number(r.price) })),
      })),
    );
    return { a: series[0], b: series[1] };
  }

  @Patch(':id')
  async edit(@Param('id') id: string, @Body() body: unknown) {
    const changes = parseBody(editSchema, body);
    await this.ensureExists(id);
    return this.prisma.product.update({ where: { id }, data: changes });
  }

  @Post(':id/pause')
  @HttpCode(200)
  async pause(@Param('id') id: string) {
    await this.ensureExists(id);
    return pauseProduct(this.prisma, id);
  }

  @Post(':id/resume')
  @HttpCode(200)
  async resume(@Param('id') id: string) {
    await this.ensureExists(id);
    return resumeProduct(this.prisma, id);
  }

  /** FR-2.4: on-demand check via the worker queue. */
  @Post(':id/check')
  @HttpCode(202)
  async checkNow(@Param('id') id: string) {
    await this.ensureExists(id);
    await this.jobs.enqueueCheckProduct(id);
    return { queued: true };
  }

  @Post('check-all')
  @HttpCode(202)
  async checkAll() {
    await this.jobs.enqueueCheckAll();
    return { queued: true };
  }

  /**
   * FR-1.6 two-step deletion: without ?confirm=true this returns the impact
   * (history/alert counts) and deletes nothing.
   */
  @Delete(':id')
  async remove(@Param('id') id: string, @Query('confirm') confirm?: string) {
    await this.ensureExists(id);
    const impact = await deletionImpact(this.prisma, id);
    if (confirm !== 'true') {
      throw new BadRequestException({
        message: 'Confirmation required: deleting removes all history and alerts',
        impact,
        confirmWith: 'DELETE ?confirm=true',
      });
    }
    await deleteProduct(this.prisma, id);
    return { deleted: true, ...impact };
  }

  private async ensureExists(id: string): Promise<void> {
    const exists = await this.prisma.product.findUnique({ where: { id }, select: { id: true } });
    if (!exists) throw new NotFoundException();
  }
}
