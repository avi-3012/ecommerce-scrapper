import { describe, expect, it, vi } from 'vitest';
import { ProductLimitError, previewUrl, registerProduct } from './registration.js';
import type { RegistrationDeps } from './registration.js';

/**
 * The product cap is the difference between a catalogue you chose and one that
 * grew. Requests per minute is `products ÷ interval`, so an unbounded catalogue
 * is an unbounded request rate — arrived at one harmless-looking product at a
 * time, long after anyone last thought about the budget.
 */
function deps(count: number, maxProducts?: number): RegistrationDeps {
  const acquireIdentity = vi.fn();
  return {
    prisma: {
      product: { count: vi.fn().mockResolvedValue(count), findUnique: vi.fn() },
      user: { findFirst: vi.fn() },
      settings: { findFirst: vi.fn() },
    } as never,
    registry: {
      recognize: () => ({
        kind: 'listing' as const,
        marketplace: 'amazon_in' as const,
        canonicalUrl: 'https://www.amazon.in/dp/B0TEST00001',
        productId: 'B0TEST00001',
      }),
      all: () => [],
    } as never,
    maxProducts,
    acquireIdentity,
    releaseIdentity: vi.fn(),
  };
}

describe('product hard cap', () => {
  it('refuses once the catalogue is full', async () => {
    const d = deps(50, 50);
    const result = await previewUrl(d, 'https://www.amazon.in/dp/B0TEST00001');
    expect(result.kind).toBe('at_capacity');
    if (result.kind !== 'at_capacity') throw new Error('unreachable');
    expect(result.current).toBe(50);
    expect(result.maxProducts).toBe(50);
    expect(result.message).toMatch(/products ÷ interval/);
  });

  it('costs no marketplace request when it refuses', async () => {
    // Refusing at the cap must not spend a fetch from an IP that is, by
    // definition, already at its limit.
    const d = deps(50, 50);
    await previewUrl(d, 'https://www.amazon.in/dp/B0TEST00001');
    expect(d.acquireIdentity).not.toHaveBeenCalled();
  });

  // Below the cap, registration proceeds past the check and into the user
  // lookup, which this stub deliberately does not model. Reaching that error
  // IS the assertion: the cap did not fire.
  const wentPastTheCap = async (d: RegistrationDeps): Promise<void> => {
    await expect(previewUrl(d, 'https://www.amazon.in/dp/B0TEST00001')).rejects.toThrow(
      /No user account exists/,
    );
  };

  it('lets the catalogue fill right up to the cap', async () => {
    await wentPastTheCap(deps(49, 50));
  });

  it('is disabled by 0 or absent', async () => {
    await wentPastTheCap(deps(10_000, 0));
    await wentPastTheCap(deps(10_000, undefined));
  });

  it('guards the WRITE, not just the preview', async () => {
    // registerProduct is reachable by posting straight to the endpoint, so the
    // cap has to hold where the row is actually created — not only where the
    // dashboard happens to look.
    const d = deps(50, 50);
    await expect(
      registerProduct(d, {
        url: 'https://www.amazon.in/dp/B0TEST00001',
        canonicalUrl: 'https://www.amazon.in/dp/B0TEST00001',
        marketplace: 'amazon_in',
        marketplaceProductId: 'B0TEST00001',
        snapshot: {} as never,
      }),
    ).rejects.toBeInstanceOf(ProductLimitError);
  });

  it('carries the numbers on the error, so the API can explain itself', async () => {
    const err = new ProductLimitError(50, 50);
    expect(err.maxProducts).toBe(50);
    expect(err.current).toBe(50);
    expect(err.message).toMatch(/products ÷ interval/);
  });
});
