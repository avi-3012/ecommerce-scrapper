import { describe, expect, it } from 'vitest';
import { splitForTelegram } from './telegram.service.js';

describe('splitForTelegram', () => {
  it('returns a single chunk when under the limit', () => {
    expect(splitForTelegram('short message', 100)).toEqual(['short message']);
  });

  it('splits at line boundaries, keeps every chunk within the limit, loses nothing', () => {
    const line = 'x'.repeat(50);
    const html = Array.from({ length: 30 }, (_v, i) => `${i} ${line}`).join('\n');
    const chunks = splitForTelegram(html, 200);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
    // Reassembling by line preserves the original content exactly.
    expect(chunks.flatMap((c) => c.split('\n'))).toEqual(html.split('\n'));
  });

  it('hard-splits a single over-long line as a last resort', () => {
    const chunks = splitForTelegram('a'.repeat(500), 200);
    expect(chunks.every((c) => c.length <= 200)).toBe(true);
    expect(chunks.join('')).toBe('a'.repeat(500));
  });
});
