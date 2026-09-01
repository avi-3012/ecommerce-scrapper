import { Inject, Injectable } from '@nestjs/common';
import { createDefaultRegistry, searchKeywords } from '@pricepulse/adapters';
import type { AdapterRegistry, IdentitySession } from '@pricepulse/adapters';
import {
  getUserWithSettings,
  performCheck,
  recordCheck,
  recordScrapeAudit,
} from '@pricepulse/core';
import type { CheckOutcome, RecordedCheck } from '@pricepulse/core';
import type { Product } from '@pricepulse/db';
import { PrismaService } from './prisma.service.js';
import { IdentityService } from './identity.service.js';
import { SuspectLedger } from './suspect-ledger.js';

/** What a check did, from the scheduler's point of view. */
export interface CheckReport {
  outcome: CheckOutcome;
  recorded: RecordedCheck | null;
  identityId: string;
  /** Set when the check was withheld because no identity was free. */
  skipped?: 'no_identity';
}

/**
 * Executes one product check end-to-end: acquire an identity → adapter lookup →
 * pipeline → record.
 *
 * The one change of substance versus the proxy era is what happens to a result
 * that is not clean. A `suspect` result is NOT recorded: it goes to the ledger
 * and a different identity is asked the same question later, and only when two
 * identities agree does a price reach the history table. A flagged session is
 * served plausible-looking wrong data at HTTP 200, and a single reading cannot
 * tell that apart from a real price move.
 */
@Injectable()
export class CheckRunnerService {
  readonly registry: AdapterRegistry = createDefaultRegistry();
  readonly suspects = new SuspectLedger();

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(IdentityService) readonly identities: IdentityService,
  ) {}

  /**
   * Run one check. `excludeIdentityId` forces a DIFFERENT identity, which is
   * how a suspect result gets a genuinely independent second opinion.
   */
  async checkProduct(
    product: Product,
    options: { excludeIdentityId?: string } = {},
  ): Promise<CheckReport> {
    const session = options.excludeIdentityId
      ? this.identities.acquireExcept(product.marketplace, options.excludeIdentityId, product.id)
      : this.identities.acquire(product.marketplace, product.id);
    if (!session) {
      return {
        skipped: 'no_identity',
        identityId: '',
        recorded: null,
        outcome: {
          ok: false,
          classification: 'error',
          error: new Error('no identity available') as never,
          tier: 'http',
          durationMs: 0,
          debug: {},
        },
      };
    }
    try {
      return await this.runWith(session, product);
    } finally {
      this.identities.release(session);
    }
  }

  private async runWith(session: IdentitySession, product: Product): Promise<CheckReport> {
    const { settings } = await getUserWithSettings(this.prisma);
    const adapter = this.registry.all().find((a) => a.marketplace === product.marketplace);
    if (!adapter) {
      throw new Error(`No adapter for marketplace ${product.marketplace}`);
    }

    // Some checks arrive the way a person would: via a search for the product's
    // own name, so the product page is a click from results rather than a bare
    // deep link. Costs one extra request, so only a fraction of checks do it.
    if (Math.random() < this.identities.config.funnelRatio) {
      const site = product.marketplace === 'amazon_in' ? 'amazon.in' : 'flipkart.com';
      await session.approachViaSearch(site, searchKeywords(product.displayName));
    }

    const outcome = await performCheck(adapter, product.canonicalUrl, {
      session,
      browserFetch: this.identities.browserFetchFor(session.identity),
      pincode: settings.pincode,
      lastAcceptedPrice: product.currentPrice === null ? null : Number(product.currentPrice),
    });

    // The audit row is written for EVERY outcome, suspects included — it is the
    // only record of what a rejected page actually claimed.
    await recordScrapeAudit(this.prisma, product, outcome);

    if (outcome.classification === 'suspect') {
      const verdict = this.suspects.record(product.id, session.id, outcome.snapshot);
      if (verdict.kind === 'corroborated') {
        // A second identity saw the same thing. It is a real price move, not a
        // poisoned response — record it as the ordinary check it turned out to be.
        console.log(`[identity] suspect on ${product.id} corroborated by ${session.id}; recording`);
        const confirmed: CheckOutcome = {
          ok: true,
          classification: 'ok',
          snapshot: outcome.snapshot,
          tier: outcome.tier,
          durationMs: outcome.durationMs,
          debug: outcome.debug,
        };
        const recorded = await this.persist(product, confirmed);
        return { outcome: confirmed, recorded, identityId: session.id };
      }
      console.warn(
        `[identity] suspect (${outcome.suspectReason}) on ${product.id} via ${session.id}: ` +
          `${outcome.error.message} — re-asking a different identity in ≥10 min`,
      );
      // Nothing recorded: no history row, no alert, no failure counted. The
      // product's last known price stands until two identities agree.
      return { outcome, recorded: null, identityId: session.id };
    }

    const recorded = await this.persist(product, outcome);
    return { outcome, recorded, identityId: session.id };
  }

  private async persist(product: Product, outcome: CheckOutcome): Promise<RecordedCheck> {
    const { settings } = await getUserWithSettings(this.prisma);
    // Polling tiers come from the scraping config: they are a property of the
    // connection's request budget, not of the user's preferences.
    const result = await recordCheck(
      this.prisma,
      product,
      outcome,
      settings,
      new Date(),
      this.identities.config.tiers,
    );
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
    return (await this.checkProduct(product)).recorded;
  }
}
