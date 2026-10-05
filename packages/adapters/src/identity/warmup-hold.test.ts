import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SCRAPING_CONFIG } from './config.js';
import { IdentitySession } from './session.js';
import type { SessionResponse } from './session.js';
import { createTestRig, createTestSession } from './testing.js';

/**
 * After a site hard-blocks, no identity may warm up into it for ten minutes.
 * Selection has to know: least-recently-used puts a never-used identity first
 * in line, so on 5 Oct 2026 the replacement for a retired identity was handed
 * 20 Flipkart checks in a row, each declined at its warm-up and each pushing
 * its product back a whole interval.
 *
 * In its own file because the hold is process-wide state: a block recorded
 * here would put the warm-ups of every other test in the file on hold.
 */
describe('warm-ups on hold after a block', () => {
  const daytime = Date.UTC(2026, 9, 5, 9, 0, 0); // 14:30 IST

  it('holds warm-ups into the blocked site only, for ten minutes', () => {
    const session = createTestSession('flipkart');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const blockedAt = Date.now();
    const response: SessionResponse = {
      url: 'https://www.flipkart.com/hp-15s/p/itm123',
      statusCode: 503,
      body: '<html><head><title>Service Unavailable</title></head></html>',
      headers: {},
      wireBytes: 280,
    };
    (
      session as unknown as {
        recordBlock(response: SessionResponse, reason: string, detail: string): void;
      }
    ).recordBlock(response, 'flipkart_http_503', 'Flipkart returned HTTP 503');
    warn.mockRestore();

    expect(IdentitySession.warmUpsOnHold('flipkart.com', blockedAt + 60_000)).toBe(true);
    expect(IdentitySession.warmUpsOnHold('amazon.in', blockedAt + 60_000)).toBe(false);
    expect(IdentitySession.warmUpsOnHold('flipkart.com', blockedAt + 10 * 60_000 + 1_000)).toBe(
      false,
    );
  });

  it('gives checks to identities that have been to the site while the hold lasts', () => {
    const rig = createTestRig({
      identities: { ...DEFAULT_SCRAPING_CONFIG.identities, count: 3 },
    });
    rig.pool.ensureSize();
    const [warmed, ...fresh] = rig.pool.list();
    rig.pool.noteWarmed(warmed!, 'flipkart.com', daytime - 3_600_000);

    // Without the hold, a never-used identity is first in line.
    const first = rig.pool.acquire({ site: 'flipkart.com', now: daytime })!;
    expect(fresh.map((identity) => identity.id)).toContain(first.id);
    rig.pool.release(first);

    // With it, the warmed identity takes every check…
    for (let i = 0; i < 5; i++) {
      const chosen = rig.pool.acquire({ site: 'flipkart.com', now: daytime, warmUpsOnHold: true });
      expect(chosen?.id).toBe(warmed!.id);
      rig.pool.release(chosen!);
    }

    // …and while it is busy the check waits, rather than going to a fresh one.
    const busy = rig.pool.acquire({ site: 'flipkart.com', now: daytime, warmUpsOnHold: true })!;
    expect(
      rig.pool.acquire({ site: 'flipkart.com', now: daytime, warmUpsOnHold: true }),
    ).toBeNull();
    rig.pool.release(busy);
  });
});
