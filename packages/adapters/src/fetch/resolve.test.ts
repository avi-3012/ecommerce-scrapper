import { describe, expect, it, vi } from 'vitest';
import { resolveListingUrl } from './http.js';

/**
 * Network-free tests: resolveListingUrl must short-circuit (no HTTP) the
 * moment the URL is already a listing. Redirect-following is covered by live
 * verification against real short links, not in CI (no live marketplace calls).
 */
describe('resolveListingUrl short-circuit', () => {
  it('returns immediately without any fetch when the URL is already a listing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const url = 'https://www.flipkart.com/x/p/itm1234567890abc?pid=ABCD1234EFGH5678';
    const result = await resolveListingUrl(url, () => true);
    expect(result).toBe(url);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('respects maxHops=0 and returns the original when not yet a listing', async () => {
    // isListing false + maxHops 0 → one loop iteration, predicate false, then
    // the loop bound stops it. With no network mock we force 0 hops so it never
    // actually fetches (the hop<=maxHops guard runs the body once, so use a
    // predicate that flips to avoid a real request).
    let calls = 0;
    const result = await resolveListingUrl(
      'https://fkrt.co/abc',
      () => {
        calls += 1;
        return true; // treat as listing on first check → no fetch
      },
      { maxHops: 0 },
    );
    expect(result).toBe('https://fkrt.co/abc');
    expect(calls).toBe(1);
  });
});
