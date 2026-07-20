import type { PrismaClient, Product } from '@pricepulse/db';
import { offersHash } from '@pricepulse/adapters';
import type { Offer, PriceCandidate } from '@pricepulse/shared';
import type { CheckOutcome } from './pipeline.js';

/**
 * Persist one per-check audit row: the full price-resolution trail for a check,
 * success or failure, so a recorded price can be explained WITHOUT re-scraping.
 * Best-effort — a failed audit write must never break a check (NFR-1), so all
 * errors are swallowed with a log.
 *
 * This is the primary tool for diagnosing location-aware price flapping. From
 * one row you can see the exit IP the check used, whether a pincode was
 * requested and whether the marketplace applied it, every price signal seen
 * (JSON-LD / embedded JSON / localized API, with the raw API bytes), which
 * source the recorded price came from, and whether the page even described the
 * product we expected.
 */
export async function recordScrapeAudit(
  prisma: PrismaClient,
  product: Product,
  outcome: CheckOutcome,
  now: Date = new Date(),
): Promise<void> {
  try {
    const debug = { ...(outcome.debug ?? {}) };
    const snapshot = outcome.ok ? outcome.snapshot : null;
    const provenance = snapshot?.provenance ?? {};
    const offers = (snapshot?.offers ?? []) as Offer[];
    const pincode = debug.pincode ?? {};
    const htmlPrice = provenance.priceHtml ? Number(provenance.priceHtml) : null;

    // Fold snapshot-derived facts into the debug blob so the stored JSON is a
    // complete, self-contained record (no field lives only in a column).
    debug.provenance = provenance;
    debug.name = snapshot?.name ?? null;
    debug.offers = {
      count: offers.length,
      hash: offers.length ? offersHash(offers) : null,
      // The actual offers, so offer_change flapping is explainable from this row
      // alone (which offer appeared/vanished) without joining price_history.
      items: offers.map((o) => `${o.type}:${o.description}`),
    };
    debug.priceCandidates = collectPriceCandidates(provenance, pincode.apiPrice ?? null);

    await prisma.scrapeAudit.create({
      data: {
        productId: product.id,
        marketplace: product.marketplace,
        createdAt: now,
        success: outcome.ok,
        tier: outcome.tier,
        failureReason: outcome.ok ? null : outcome.error.reason,
        failureDetail: outcome.ok ? null : outcome.error.message.slice(0, 500),
        durationMs: outcome.durationMs,
        name: snapshot?.name ?? null,
        price: snapshot?.price ?? null,
        mrp: snapshot?.mrp ?? null,
        stockStatus: snapshot?.stockStatus ?? null,
        priceSource: provenance.price ?? null,
        offersCount: offers.length,
        offersHash: offers.length ? offersHash(offers) : null,
        pincodeRequested: debug.pincodeRequested ?? null,
        pincodeApplied: pincode.applied ?? null,
        pincodeVerified: pincode.verified ?? null,
        pincodeApiStatus: pincode.apiStatus ?? null,
        apiPrice: pincode.apiPrice ?? null,
        htmlPrice: htmlPrice !== null && Number.isFinite(htmlPrice) ? htmlPrice : null,
        exitIp: debug.exitIp ?? null,
        proxySession: debug.proxySession ?? null,
        debug: JSON.parse(JSON.stringify(debug)) as object,
      },
    });
  } catch (err) {
    console.error(
      'Scrape audit write failed (non-fatal):',
      err instanceof Error ? err.message : err,
    );
  }
}

/** Every price signal seen this check, from provenance keys + the API price. */
function collectPriceCandidates(
  provenance: Record<string, string>,
  apiPrice: number | null,
): PriceCandidate[] {
  const candidates: PriceCandidate[] = [];
  const add = (source: string, raw: string | undefined | null): void => {
    if (raw === undefined || raw === null || raw === '') return;
    const value = Number(raw);
    candidates.push({ source, value: Number.isFinite(value) ? value : null });
  };
  add('jsonld', provenance.priceJsonLd);
  add('embedded-json', provenance.priceEmbedded);
  add('html-winner', provenance.priceHtml);
  if (apiPrice !== null) candidates.push({ source: 'pincode-api', value: apiPrice });
  return candidates;
}

/** Delete audit rows older than the retention window. Returns rows removed. */
export async function pruneScrapeAudits(
  prisma: PrismaClient,
  retentionDays: number,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600 * 1000);
  const { count } = await prisma.scrapeAudit.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}
