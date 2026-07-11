import type { FailureReason } from '@pricepulse/shared';

/**
 * Every failure inside fetch/parse is thrown as a CheckError carrying a
 * category from the fixed failure taxonomy (Milestone 1 doc, WP-1.4).
 * The pipeline converts anything else to category 'other', so no check
 * can fail without a category.
 */
export class CheckError extends Error {
  constructor(
    readonly reason: FailureReason,
    detail: string,
  ) {
    super(detail);
    this.name = 'CheckError';
  }
}

export function toCheckError(err: unknown): CheckError {
  if (err instanceof CheckError) return err;
  return new CheckError('other', err instanceof Error ? err.message : String(err));
}
