import { describe, expect, it } from 'vitest';
import { browserCookiesFor } from './browser.js';

describe('browserCookiesFor', () => {
  const url = 'https://www.amazon.in/dp/B0TEST12345';

  it('scopes every cookie to the registrable domain, so it replaces the profile copy', () => {
    const { cookies } = browserCookiesFor('session-id=123; ubid-acbin=456', url);
    // Host-only cookies on www.amazon.in sat BESIDE the profile's .amazon.in
    // ones instead of replacing them, and Amazon read the profile's session.
    expect(cookies).toEqual([
      { name: 'session-id', value: '123', domain: '.amazon.in', path: '/' },
      { name: 'ubid-acbin', value: '456', domain: '.amazon.in', path: '/' },
    ]);
  });

  it('keeps an equals sign that belongs to the value', () => {
    const { cookies } = browserCookiesFor('csm-hit=tb:s-ABC|123=456', url);
    expect(cookies[0]).toMatchObject({ name: 'csm-hit', value: 'tb:s-ABC|123=456' });
  });

  it('drops empty and malformed pairs rather than adding nameless cookies', () => {
    const { cookies } = browserCookiesFor('a=1;; =nameless; noequals; b=2', url);
    expect(cookies.map((c) => c.name)).toEqual(['a', 'b']);
  });

  it('clears every cookie the site owns, and nothing belonging to anyone else', () => {
    const { domain } = browserCookiesFor('a=1', url);
    for (const owned of ['amazon.in', '.amazon.in', 'www.amazon.in']) {
      expect(domain.test(owned)).toBe(true);
    }
    for (const foreign of ['notamazon.in', 'amazon.in.evil.com', 'flipkart.com']) {
      expect(domain.test(foreign)).toBe(false);
    }
  });
});
