import { Controller, Get, Inject, Query } from '@nestjs/common';
import { PrismaService } from './prisma.service.js';
import { aggregateProxyUsage } from './proxy-usage.js';
import type { ProxyUsageReport } from './proxy-usage.js';

/**
 * Read-only analytics over the scrape-audit trail. Powers the Bandwidth
 * dashboard; the same aggregation backs /export/proxy-usage.csv.
 */
@Controller('analytics')
export class AnalyticsController {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  @Get('proxy')
  async proxy(@Query('days') days?: string): Promise<ProxyUsageReport> {
    return aggregateProxyUsage(this.prisma, Number(days) || 14);
  }
}
