import { Inject, Injectable } from '@nestjs/common';
import type { OnModuleInit } from '@nestjs/common';
import { createBrowserFetch, createDefaultRegistry, proxyLabel } from '@pricepulse/adapters';
import type { AdapterRegistry, FetchFn } from '@pricepulse/adapters';
import { getUserWithSettings, performCheck, recordCheck } from '@pricepulse/core';
import type { RecordedCheck } from '@pricepulse/core';
import type { Product } from '@pricepulse/db';
import { PrismaService } from './prisma.service.js';

/**
 * Executes one product check end-to-end (WP-1.4/1.5): adapter lookup →
 * pipeline (tier-1 → tier-2 escalation) → recordCheck (history row, state
 * update, alert evaluation, auto-pause). Shared by the scheduler, on-demand
 * jobs, and bot commands so there is exactly one check path.
 */
@Injectable()
export class CheckRunnerService implements OnModuleInit {
  readonly registry: AdapterRegistry = createDefaultRegistry();
  browserFetch: FetchFn | undefined;

  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    this.browserFetch = await createBrowserFetch();
    console.log(
      this.browserFetch
        ? 'Browser tier (Playwright) available'
        : 'Browser tier not installed — tier-1 HTTP only (see HUMAN-TASKS H-13)',
    );
    const proxy = proxyLabel();
    console.log(proxy ? `Scraper proxy active: ${proxy}` : 'Scraper proxy: none (direct)');
  }

  async checkProduct(product: Product): Promise<RecordedCheck> {
    const { settings } = await getUserWithSettings(this.prisma);
    const adapter = this.registry.all().find((a) => a.marketplace === product.marketplace);
    if (!adapter) {
      throw new Error(`No adapter for marketplace ${product.marketplace}`);
    }
    const outcome = await performCheck(adapter, product.canonicalUrl, {
      browserFetch: this.browserFetch,
    });
    const result = await recordCheck(this.prisma, product, outcome, settings);
    // Live-update event (WP-3.6): fire-and-forget; the stream is never load-bearing.
    const payload = JSON.stringify({ type: 'check', productId: product.id });
    await this.prisma.$executeRaw`SELECT pg_notify('pricepulse_events', ${payload})`.catch(
      () => undefined,
    );
    return result;
  }

  async checkProductById(productId: string): Promise<RecordedCheck | null> {
    const product = await this.prisma.product.findUnique({ where: { id: productId } });
    if (!product) return null;
    return this.checkProduct(product);
  }
}
