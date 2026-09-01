import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Full-response capture for failed scrapes.
 *
 * When a check fails, the single most useful thing is the bytes the marketplace
 * actually sent — the block page, the stripped product page, the variant we
 * didn't expect. Without it every diagnosis is a guess, and reproducing the
 * failure means hitting the same IP again to provoke the same refusal, which is
 * the last thing you want to do when it is already unhappy.
 *
 * Bodies are gzipped to disk rather than stored in Postgres. An Amazon product
 * page is ~2 MB of HTML; at hundreds of checks an hour that is not a database
 * column, and `scrape_audit.debug` is serialized into a JSON field that would
 * become unqueryable. What lands in the database is the PATH, so an audit row
 * and its captured body can always be joined back up.
 */

/** Compressed captures are ~10% of the raw page, so this holds a lot of them. */
export const DEFAULT_CAPTURE_BUDGET_MB = 512;
export const DEFAULT_CAPTURE_RETENTION_DAYS = 7;

export interface CaptureInput {
  /** Root of the identity store; captures live under `<dir>/failures`. */
  dir: string;
  marketplace: string;
  productId?: string | null;
  url: string;
  identityId: string;
  /** Failure category, e.g. 'fetch_blocked' | 'parse_failed'. */
  reason: string;
  detail: string;
  status: number | null;
  body: string;
  headers?: Record<string, unknown>;
  now?: Date;
}

export interface CaptureResult {
  /** Path relative to the store dir — what gets recorded on the audit row. */
  path: string;
  bytesRaw: number;
  bytesStored: number;
  bodySha256: string;
}

function stamp(at: Date): string {
  return at.toISOString().replace(/[:.]/g, '-');
}

/**
 * Write one failed response to disk. Best-effort: a capture that cannot be
 * written must never turn a failed check into a crashed one, so every error
 * here is swallowed with a log and `null` is returned.
 */
export function captureFailure(input: CaptureInput): CaptureResult | null {
  const at = input.now ?? new Date();
  try {
    const day = at.toISOString().slice(0, 10);
    const dayDir = join(input.dir, 'failures', day);
    mkdirSync(dayDir, { recursive: true });

    const sha = createHash('sha256').update(input.body).digest('hex');
    const safeReason = input.reason.replace(/[^a-z0-9_]/gi, '-');
    const base = `${stamp(at)}-${safeReason}-${sha.slice(0, 8)}`;
    const bodyFile = `${base}.html.gz`;
    const gz = gzipSync(Buffer.from(input.body, 'utf8'));
    writeFileSync(join(dayDir, bodyFile), gz);

    const meta = {
      at: at.toISOString(),
      marketplace: input.marketplace,
      productId: input.productId ?? null,
      url: input.url,
      identityId: input.identityId,
      reason: input.reason,
      detail: input.detail,
      status: input.status,
      bytesRaw: Buffer.byteLength(input.body, 'utf8'),
      bytesStored: gz.length,
      bodySha256: sha,
      body: bodyFile,
      headers: input.headers ?? {},
    };
    writeFileSync(join(dayDir, `${base}.json`), JSON.stringify(meta, null, 2), 'utf8');

    // One append-only line per capture, so "what failed recently" is a tail
    // rather than a directory walk.
    appendFileSync(
      join(input.dir, 'failures', 'index.jsonl'),
      JSON.stringify({ ...meta, path: `failures/${day}/${bodyFile}` }) + '\n',
      'utf8',
    );

    return {
      path: `failures/${day}/${bodyFile}`,
      bytesRaw: meta.bytesRaw,
      bytesStored: gz.length,
      bodySha256: sha,
    };
  } catch (err) {
    console.error(
      'Failure capture could not be written (non-fatal):',
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Keep the capture directory bounded, by age first and then by total size.
 *
 * Unbounded debug output is a disk-full incident waiting for the week you are
 * not watching — and a disk-full worker fails every check, which is a far worse
 * outcome than having lost last month's block pages.
 */
export function pruneCaptures(
  dir: string,
  opts: { retentionDays?: number; budgetMb?: number; now?: Date } = {},
): { removedDirs: number; removedBytes: number } {
  const retentionDays = opts.retentionDays ?? DEFAULT_CAPTURE_RETENTION_DAYS;
  const budgetBytes = (opts.budgetMb ?? DEFAULT_CAPTURE_BUDGET_MB) * 1024 * 1024;
  const now = opts.now ?? new Date();
  const root = join(dir, 'failures');

  let removedDirs = 0;
  let removedBytes = 0;
  let days: string[];
  try {
    days = readdirSync(root)
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch {
    return { removedDirs: 0, removedBytes: 0 };
  }

  const sizeOf = (day: string): number => {
    try {
      return readdirSync(join(root, day)).reduce((sum, f) => {
        try {
          return sum + statSync(join(root, day, f)).size;
        } catch {
          return sum;
        }
      }, 0);
    } catch {
      return 0;
    }
  };

  const drop = (day: string): void => {
    const bytes = sizeOf(day);
    try {
      rmSync(join(root, day), { recursive: true, force: true });
      removedDirs += 1;
      removedBytes += bytes;
    } catch {
      // already gone
    }
  };

  // 1. Anything past the retention window.
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 3600_000).toISOString().slice(0, 10);
  const kept: string[] = [];
  for (const day of days) {
    if (day < cutoff) drop(day);
    else kept.push(day);
  }

  // 2. Then oldest-first until the whole directory is back inside its budget.
  let total = kept.reduce((sum, day) => sum + sizeOf(day), 0);
  for (const day of kept) {
    if (total <= budgetBytes) break;
    const bytes = sizeOf(day);
    drop(day);
    total -= bytes;
  }

  return { removedDirs, removedBytes };
}
