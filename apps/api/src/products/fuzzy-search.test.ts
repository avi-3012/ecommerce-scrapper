import { describe, expect, it } from 'vitest';
import { editDistance, matchScore, rankMatches, searchTokens } from './fuzzy-search.js';
import type { Searchable } from './fuzzy-search.js';

const victus: Searchable = {
  displayName: 'HP Victus Gaming Laptop, 13th Gen Intel Core i5-13420H, 16GB DDR4, 512GB SSD',
  marketplaceProductId: 'B0D2299GB9',
  url: 'https://www.amazon.in/dp/B0D2299GB9',
};
const loq: Searchable = {
  displayName: 'Lenovo LOQ Intel Core i5 13th Gen 13450HX - (16 GB/512 GB SSD/Windows 11 Home)',
  marketplaceProductId: 'COMGYSFGHPSWGZSV',
  url: 'https://www.flipkart.com/lenovo-loq-intel-core-i5/p/itm6d47525d5d8c5?pid=COMGYSFGHPSWGZSV',
};
const awaiting: Searchable = {
  displayName: 'Awaiting first check — COMHG6XZUYVABCDE',
  marketplaceProductId: 'COMHG6XZUYVABCDE',
  url: 'https://www.flipkart.com/hp-250r-g10-2025-i3-14th-gen-thin-light-laptop/p/itmd5c1ce605db95?pid=COMHG6XZUYVABCDE',
};

const matches = (query: string, product: Searchable): boolean =>
  matchScore(searchTokens(query), product) !== null;

describe('product search', () => {
  it('finds words in any order', () => {
    expect(matches('victus hp', victus)).toBe(true);
    expect(matches('loq lenovo', loq)).toBe(true);
  });

  it('finds a word still being typed', () => {
    expect(matches('vict', victus)).toBe(true);
    expect(matches('leno', loq)).toBe(true);
  });

  it('forgives a typo in a word of letters', () => {
    expect(matches('lenvo', loq)).toBe(true); // a letter missed
    expect(matches('victsu', victus)).toBe(true); // two swapped
    expect(matches('gamming', victus)).toBe(true); // one doubled
  });

  it('needs every word to match, so another word narrows the list', () => {
    expect(matches('hp victus', victus)).toBe(true);
    expect(matches('hp lenovo', victus)).toBe(false);
  });

  it('never stretches a number to a different model or capacity', () => {
    expect(matches('13420', victus)).toBe(true);
    expect(matches('13450', victus)).toBe(false); // a different processor
    expect(matches('256gb', victus)).toBe(false); // a different drive
    expect(matches('i5-13420h', victus)).toBe(true); // punctuation is spacing
  });

  it('finds a product by its marketplace id or its link', () => {
    expect(matches('B0D2299GB9', victus)).toBe(true);
    expect(matches('amazon.in/dp/B0D2299GB9', victus)).toBe(true);
    // Not yet checked, so the name is a placeholder: the link's words still find it.
    expect(matches('hp 250r', awaiting)).toBe(true);
  });

  it('does not let a typo reach the noise words of a link', () => {
    // "pidd" is a typo away from the "pid" in every Flipkart link.
    expect(matches('pidd', loq)).toBe(false);
  });

  it('matches nothing for a search with nothing searchable in it', () => {
    expect(searchTokens('  ¡!  ')).toEqual([]);
    expect(matchScore([], victus)).toBeNull();
  });

  it('ranks by priority first, then by how well it matched', () => {
    const at = new Date('2026-10-01T00:00:00Z');
    const ranked = rankMatches(
      [
        { ...victus, id: 'typo', displayName: 'HP Victsu 15', priority: 1, createdAt: at },
        { ...victus, id: 'exact', displayName: 'HP Victus 15', priority: 1, createdAt: at },
        { ...victus, id: 'other', displayName: 'Dell Inspiron 15', priority: 1, createdAt: at },
        { ...victus, id: 'p2-typo', displayName: 'HP Victsu 16', priority: 2, createdAt: at },
      ].map((p) => ({ ...p, url: '', marketplaceProductId: p.id })),
      searchTokens('victus'),
    );
    expect(ranked.map((m) => m.id)).toEqual(['p2-typo', 'exact', 'typo']);
  });
});

describe('editDistance', () => {
  it('counts a swap of neighbours as one edit', () => {
    expect(editDistance('victsu', 'victus', 2)).toBe(1);
    expect(editDistance('lenvo', 'lenovo', 2)).toBe(1);
    expect(editDistance('abc', 'abc', 1)).toBe(0);
  });

  it('stops counting once past the limit', () => {
    expect(editDistance('samsung', 'lenovo', 1)).toBe(2);
    expect(editDistance('a', 'abcdef', 2)).toBe(3);
  });
});
