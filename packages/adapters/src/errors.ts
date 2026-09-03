import type { FailureReason } from '@pricepulse/shared';

/**
 * Every failure inside fetch/parse is thrown as a CheckError carrying a
 * category from the fixed failure taxonomy (Milestone 1 doc, WP-1.4).
 * The pipeline converts anything else to category 'other', so no check
 * can fail without a category.
 */
export class CheckError extends Error {
  /**
   * Whether re-fetching through the heavier browser tier could plausibly change
   * this outcome. Defaults to true, which is right for the ordinary
   * `parse_failed`: the page was client-rendered and a real browser can read
   * what a raw HTTP fetch could not.
   *
   * Set it false when the failure is a property of the PAGE rather than of how
   * the page was fetched. A browser handed the same URL gets the same wrong
   * page — so escalating spends the most expensive request in the system, plus
   * a slot against a hard IP budget, to reproduce a failure it cannot fix.
   */
  readonly escalate: boolean;

  /**
   * Whether a request was actually made. False means the check was abandoned
   * before anything left the machine — the global backoff was running, or the
   * kill switch was on.
   *
   * The distinction matters because a product's failure budget is meant to
   * measure THAT PRODUCT: a listing that has gone bad, a layout we can no
   * longer read. A check we declined to send says nothing about the product,
   * and counting it means one connection-level incident retires the whole
   * catalogue — which is exactly what happened on 3 Sep 2026, when a
   * 107-second Amazon block became an 89-minute mill that auto-paused all 22
   * active products on failures that were never sent.
   */
  readonly attempted: boolean;

  constructor(
    readonly reason: FailureReason,
    detail: string,
    options: { escalate?: boolean; attempted?: boolean } = {},
  ) {
    super(detail);
    this.name = 'CheckError';
    this.escalate = options.escalate ?? true;
    this.attempted = options.attempted ?? true;
  }
}

export function toCheckError(err: unknown): CheckError {
  if (err instanceof CheckError) return err;
  return new CheckError('other', err instanceof Error ? err.message : String(err));
}
