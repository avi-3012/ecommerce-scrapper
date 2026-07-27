import type { PrismaClient, ScrapeAudit } from '@pricepulse/db';

/**
 * Per-product proxy bandwidth, aggregated from the scrape-audit trail. Shared by
 * the JSON analytics endpoint (dashboard) and the CSV export so both report
 * identical numbers. Bytes are WIRE (compressed) — what the proxy bills.
 */
export interface ProxyUsageProduct {
  productId: string;
  displayName: string;
  marketplace: string;
  scrapes: number;
  ok: number;
  failed: number;
  retries: number;
  tier2: number;
  wireBytes: number;
  httpPage: number;
  browserPage: number;
  pincodeApi: number;
  cookieMint: number;
  sideSheet: number;
}

export interface ProxyUsageReport {
  windowDays: number;
  totals: Omit<ProxyUsageProduct, 'productId' | 'displayName' | 'marketplace'>;
  products: ProxyUsageProduct[];
}

function blank(): Omit<ProxyUsageProduct, 'productId' | 'displayName' | 'marketplace'> {
  return {
    scrapes: 0,
    ok: 0,
    failed: 0,
    retries: 0,
    tier2: 0,
    wireBytes: 0,
    httpPage: 0,
    browserPage: 0,
    pincodeApi: 0,
    cookieMint: 0,
    sideSheet: 0,
  };
}

function kindBytes(a: ScrapeAudit, kind: string): number {
  const proxy = (a.debug as { proxy?: { byKind?: Record<string, { wireBytes?: number }> } })?.proxy;
  return proxy?.byKind?.[kind]?.wireBytes ?? 0;
}

export async function aggregateProxyUsage(
  prisma: Pick<PrismaClient, 'product' | 'scrapeAudit'>,
  windowDays: number,
): Promise<ProxyUsageReport> {
  const days = Math.min(Math.max(Math.round(windowDays) || 14, 1), 60);
  const since = new Date(Date.now() - days * 24 * 3600 * 1000);
  const names = new Map(
    (
      await prisma.product.findMany({
        select: { id: true, displayName: true, marketplace: true },
      })
    ).map((p) => [p.id, p]),
  );

  const byProduct = new Map<string, ReturnType<typeof blank>>();
  const totals = blank();

  let cursor: bigint | null = null;
  for (;;) {
    const batch: ScrapeAudit[] = await prisma.scrapeAudit.findMany({
      where: { createdAt: { gte: since }, ...(cursor ? { id: { gt: cursor } } : {}) },
      orderBy: { id: 'asc' },
      take: 5000,
    });
    if (batch.length === 0) break;
    for (const a of batch) {
      const agg = byProduct.get(a.productId) ?? blank();
      const mainPage = kindBytes(a, 'main_page');
      const add = (t: ReturnType<typeof blank>): void => {
        t.scrapes += 1;
        if (a.success) t.ok += 1;
        else t.failed += 1;
        t.retries += a.proxyRetries ?? 0;
        t.wireBytes += a.bytesWire ?? 0;
        if (a.tier === 'browser') {
          t.tier2 += 1;
          t.browserPage += mainPage;
        } else {
          t.httpPage += mainPage;
        }
        t.pincodeApi += kindBytes(a, 'pincode_api');
        t.cookieMint += kindBytes(a, 'cookie_mint');
        t.sideSheet += kindBytes(a, 'side_sheet');
      };
      add(agg);
      add(totals);
      byProduct.set(a.productId, agg);
    }
    cursor = batch[batch.length - 1]!.id;
  }

  const products: ProxyUsageProduct[] = [...byProduct.entries()]
    .map(([productId, agg]) => ({
      productId,
      displayName: names.get(productId)?.displayName ?? productId,
      marketplace: names.get(productId)?.marketplace ?? '',
      ...agg,
    }))
    .sort((a, b) => b.wireBytes - a.wireBytes);

  return { windowDays: days, totals, products };
}
