import { describe, expect, it } from 'vitest';
import { amazonLocationApplied } from './location.js';

describe('amazonLocationApplied', () => {
  it('true when the glow ingress shows the requested pincode', () => {
    const html = '<html><body><span id="glow-ingress-line2">Mumbai 400001</span></body></html>';
    expect(amazonLocationApplied(html, '400001')).toBe(true);
  });

  it('false when the location did not take (e.g. "Update location")', () => {
    const html = '<html><body><span id="glow-ingress-line2">Update location</span></body></html>';
    expect(amazonLocationApplied(html, '400001')).toBe(false);
  });

  it('false when a different location was resolved', () => {
    const html = '<html><body><span id="glow-ingress-line2">Bengaluru 560001</span></body></html>';
    expect(amazonLocationApplied(html, '400001')).toBe(false);
  });
});
