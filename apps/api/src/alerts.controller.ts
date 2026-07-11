import {
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { z } from 'zod';
import { ALERT_TYPES, DELIVERY_STATUSES } from '@pricepulse/shared';
import type { Prisma } from '@pricepulse/db';
import { PrismaService } from './prisma.service.js';
import { parseBody } from './validation.js';

const querySchema = z.object({
  productId: z.string().uuid().optional(),
  type: z.enum(ALERT_TYPES).optional(),
  deliveryStatus: z.enum(DELIVERY_STATUSES).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

/** Alert log with delivery outcomes (FR-4.2, groundwork for FR-5.7). */
@Controller('alerts')
export class AlertsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() query: Record<string, string>) {
    const q = parseBody(querySchema, query);
    const where: Prisma.AlertWhereInput = {
      ...(q.productId ? { productId: q.productId } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.deliveryStatus ? { deliveryStatus: q.deliveryStatus } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.alert.findMany({
        where,
        orderBy: { firedAt: 'desc' },
        skip: (q.page - 1) * q.pageSize,
        take: q.pageSize,
        include: { product: { select: { displayName: true, marketplace: true, url: true } } },
      }),
      this.prisma.alert.count({ where }),
    ]);
    return { items, total, page: q.page, pageSize: q.pageSize };
  }

  /** Re-queue a failed delivery; the worker's dispatch loop picks it up (WP-2.7). */
  @Post(':id/retry')
  @HttpCode(200)
  async retry(@Param('id') id: string) {
    const alert = await this.prisma.alert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException();
    return this.prisma.alert.update({
      where: { id },
      data: { deliveryStatus: 'pending', deliveryError: null },
    });
  }
}
