import type { ProductSnapshot } from '@pricepulse/shared';

/**
 * Pending suspect readings, awaiting a second opinion.
 *
 * The rule: a suspect price is recorded only when a DIFFERENT identity, asked at
 * least ten minutes later, sees the same thing. That is the only way to
 * distinguish "the price really did fall 45%" from "this session has been
 * flagged and is being served a plausible lie at HTTP 200".
 *
 * Deliberately in memory. A restart loses at most one pending suspicion, and the
 * consequence of losing one is that the next reading starts the corroboration
 * over — which is the safe direction to fail in.
 */

/** A re-ask before this has elapsed proves nothing: give the site time to settle. */
export const RECHECK_DELAY_MS = 10 * 60_000;
/** How long a pending suspicion stays open before it is simply forgotten. */
export const SUSPECT_TTL_MS = 6 * 3600_000;
/** Two readings this close count as agreement (rupee rounding, not a real move). */
export const AGREEMENT_RATIO = 0.01;

interface PendingSuspect {
  identityId: string;
  price: number | null;
  stockStatus: string;
  at: number;
}

export type SuspectVerdict =
  { kind: 'pending'; recheckAfter: number; excludeIdentityId: string } | { kind: 'corroborated' };

export class SuspectLedger {
  private readonly pending = new Map<string, PendingSuspect>();

  /**
   * Record a suspect reading. Returns `corroborated` when it matches a pending
   * reading from a different identity — at which point the caller may trust it.
   */
  record(
    productId: string,
    identityId: string,
    snapshot: ProductSnapshot,
    now: number = Date.now(),
  ): SuspectVerdict {
    const prior = this.pending.get(productId);
    if (
      prior &&
      prior.identityId !== identityId &&
      now - prior.at < SUSPECT_TTL_MS &&
      agrees(prior, snapshot)
    ) {
      this.pending.delete(productId);
      return { kind: 'corroborated' };
    }
    this.pending.set(productId, {
      identityId,
      price: snapshot.price,
      stockStatus: snapshot.stockStatus,
      at: now,
    });
    return {
      kind: 'pending',
      recheckAfter: now + RECHECK_DELAY_MS,
      excludeIdentityId: identityId,
    };
  }

  /** Products whose re-ask is due, with the identity that must NOT do the asking. */
  due(now: number = Date.now()): Array<{ productId: string; excludeIdentityId: string }> {
    const out: Array<{ productId: string; excludeIdentityId: string }> = [];
    for (const [productId, suspect] of this.pending) {
      if (now - suspect.at > SUSPECT_TTL_MS) {
        this.pending.delete(productId);
        continue;
      }
      if (now - suspect.at >= RECHECK_DELAY_MS) {
        out.push({ productId, excludeIdentityId: suspect.identityId });
      }
    }
    return out;
  }

  /** The identity that must be avoided for this product, if one is pending. */
  excludeFor(productId: string): string | undefined {
    return this.pending.get(productId)?.identityId;
  }

  has(productId: string): boolean {
    return this.pending.has(productId);
  }

  get size(): number {
    return this.pending.size;
  }

  clear(productId: string): void {
    this.pending.delete(productId);
  }
}

function agrees(prior: PendingSuspect, snapshot: ProductSnapshot): boolean {
  if (prior.stockStatus !== snapshot.stockStatus) return false;
  if (prior.price === null || snapshot.price === null) return prior.price === snapshot.price;
  if (prior.price === 0) return snapshot.price === 0;
  return Math.abs(prior.price - snapshot.price) / prior.price <= AGREEMENT_RATIO;
}
