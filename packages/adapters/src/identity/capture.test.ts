import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureFailure, pruneCaptures } from './capture.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'pricepulse-capture-'));

const input = (over: Partial<Parameters<typeof captureFailure>[0]> = {}) => ({
  dir: over.dir ?? dir(),
  marketplace: 'amazon_in',
  productId: 'p-1',
  url: 'https://www.amazon.in/dp/B0DZ7C519W',
  identityId: '01M0JRW03QQFZ9MXPM0H4GEHT1',
  reason: 'parse_failed',
  detail: 'Could not extract price (all strategies)',
  status: 200,
  body: '<html><body>' + 'x'.repeat(50_000) + '</body></html>',
  ...over,
});

describe('failure capture', () => {
  it('stores the FULL body, not a truncated head', () => {
    const d = dir();
    const body = '<html>' + 'y'.repeat(200_000) + '</html>';
    const result = captureFailure(input({ dir: d, body }))!;
    expect(result).not.toBeNull();

    const raw = gunzipSync(readFileSync(join(d, result.path))).toString('utf8');
    // The whole point: a 2 KB head cannot tell you why a page failed to parse.
    expect(raw).toBe(body);
    expect(result.bytesRaw).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('compresses hard — HTML is why this is affordable at all', () => {
    const d = dir();
    const result = captureFailure(input({ dir: d, body: '<div>abc</div>'.repeat(20_000) }))!;
    expect(result.bytesStored).toBeLessThan(result.bytesRaw / 10);
  });

  it('writes a sidecar carrying everything needed to diagnose it later', () => {
    const d = dir();
    const result = captureFailure(input({ dir: d }))!;
    const meta = JSON.parse(
      readFileSync(join(d, result.path.replace('.html.gz', '.json')), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta.url).toBe('https://www.amazon.in/dp/B0DZ7C519W');
    expect(meta.identityId).toBe('01M0JRW03QQFZ9MXPM0H4GEHT1');
    expect(meta.reason).toBe('parse_failed');
    expect(meta.productId).toBe('p-1');
    expect(meta.status).toBe(200);
    expect(meta.bodySha256).toBe(result.bodySha256);
  });

  it('appends one index line per capture, so recent failures are a tail', () => {
    const d = dir();
    captureFailure(input({ dir: d, reason: 'parse_failed' }));
    captureFailure(input({ dir: d, reason: 'fetch_blocked' }));
    const lines = readFileSync(join(d, 'failures', 'index.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(lines.map((l) => (JSON.parse(l) as { reason: string }).reason)).toEqual([
      'parse_failed',
      'fetch_blocked',
    ]);
  });

  it('never throws when the directory cannot be written', () => {
    // A capture that fails must not turn a failed check into a crashed one.
    // Use a regular FILE as the store root: mkdir beneath it fails with ENOTDIR
    // on every platform, which is a portable way to force the error path.
    const blocked = join(dir(), 'not-a-directory');
    writeFileSync(blocked, 'x');
    expect(() => captureFailure(input({ dir: blocked }))).not.toThrow();
    expect(captureFailure(input({ dir: blocked }))).toBeNull();
  });
});

describe('capture pruning', () => {
  function seed(root: string, day: string, bytes: number): void {
    const p = join(root, 'failures', day);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'body.html.gz'), Buffer.alloc(bytes));
  }

  it('drops days past the retention window', () => {
    const d = dir();
    seed(d, '2026-08-01', 1000);
    seed(d, '2026-08-26', 1000);
    const now = new Date('2026-08-27T00:00:00Z');
    const { removedDirs } = pruneCaptures(d, { retentionDays: 7, now });
    expect(removedDirs).toBe(1);
    expect(existsSync(join(d, 'failures', '2026-08-01'))).toBe(false);
    expect(existsSync(join(d, 'failures', '2026-08-26'))).toBe(true);
  });

  it('drops oldest-first once the whole directory exceeds its budget', () => {
    const d = dir();
    for (const day of ['2026-08-25', '2026-08-26', '2026-08-27']) seed(d, day, 2 * 1024 * 1024);
    const now = new Date('2026-08-27T00:00:00Z');
    pruneCaptures(d, { retentionDays: 30, budgetMb: 5, now });
    const left = readdirSync(join(d, 'failures')).filter((f) => f.startsWith('2026'));
    expect(left).toEqual(['2026-08-26', '2026-08-27']);
  });

  it('is a no-op when nothing has been captured yet', () => {
    expect(pruneCaptures(dir())).toEqual({ removedDirs: 0, removedBytes: 0 });
  });
});
