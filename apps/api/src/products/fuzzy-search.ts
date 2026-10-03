/**
 * Product search that forgives the way people type: words in any order, a
 * word cut short, a slip of the finger. "victus hp", "lenvo loq" and "vict"
 * all find what a plain substring search would miss.
 *
 * Every word typed has to match somewhere — the product's name, its
 * marketplace id (ASIN / Flipkart pid) or its link — so adding a word narrows
 * the list, as it does in any search box. Only words of letters forgive
 * typos. A digit carries the meaning of a model number or a capacity: 13420
 * and 13450 are different processors and 256 and 512 different drives, so
 * anything with a digit in it must match exactly or as part of a word.
 *
 * Small and in-process on purpose: one catalogue is hundreds of products, so
 * scoring every candidate per request costs microseconds, and it needs no
 * database extension or migration.
 */

/** What a product is searched by. */
export interface Searchable {
  displayName: string;
  marketplaceProductId: string;
  url: string;
}

/** Lowercase, accents dropped, and every run of punctuation one space. */
export function normalize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** The distinct words of a search, normalised; empty when nothing searchable was typed. */
export function searchTokens(query: string): string[] {
  return [...new Set(normalize(query).split(' ').filter(Boolean))];
}

const EXACT = 1;
const PREFIX = 0.95;
const INSIDE = 0.85;
const ONE_TYPO = 0.75;
const TWO_TYPOS = 0.6;

/**
 * How well a product matches, from 0 (barely) to 1 (every word exact), or null
 * when some word of the search is nowhere in it.
 */
export function matchScore(tokens: readonly string[], product: Searchable): number | null {
  if (tokens.length === 0) return null;
  const nameWords = normalize(product.displayName).split(' ');
  // The link and the id are matched literally. A URL is full of words that
  // are not the product — https, www, pid, marketplace — and letting a typo
  // reach them would match nearly everything.
  const literalWords = [
    ...normalize(product.marketplaceProductId).split(' '),
    ...normalize(product.url).split(' '),
  ];
  let total = 0;
  for (const token of tokens) {
    const score = Math.max(
      wordScore(token, nameWords, true),
      wordScore(token, literalWords, false),
    );
    if (score === 0) return null;
    total += score;
  }
  return total / tokens.length;
}

function wordScore(token: string, words: readonly string[], forgiving: boolean): number {
  const typos = forgiving ? allowedTypos(token) : 0;
  let best = 0;
  for (const word of words) {
    if (!word) continue;
    if (word === token) return EXACT;
    if (word.startsWith(token)) best = Math.max(best, PREFIX);
    else if (word.includes(token)) best = Math.max(best, INSIDE);
    else if (typos > 0 && best < ONE_TYPO) {
      // Against the whole word, and against its start: "lenvo" is a typo of
      // "lenovo", and "victsu" of the "victus" still being typed.
      const distance = Math.min(
        editDistance(token, word, typos),
        editDistance(token, word.slice(0, token.length), typos),
      );
      // `distance` is typos + 1 when too far — never read that as a match.
      if (distance <= typos) best = Math.max(best, distance <= 1 ? ONE_TYPO : TWO_TYPOS);
    }
  }
  return best;
}

/** None under four letters (too many short words are a typo apart), and never with a digit. */
function allowedTypos(token: string): number {
  if (/\d/.test(token)) return 0;
  if (token.length >= 8) return 2;
  if (token.length >= 4) return 1;
  return 0;
}

/**
 * Edits (insert, delete, substitute, swap two neighbours) to turn `a` into
 * `b`, or `max + 1` as soon as it is certain to exceed `max`.
 */
export function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prevPrev: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, prevPrev[j - 2]! + 1);
      }
      row.push(value);
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
    prevPrev = prev;
    prev = row;
  }
  return Math.min(prev[b.length]!, max + 1);
}

/** A match, with what "best match first" orders by. */
export interface RankedMatch {
  id: string;
  score: number;
  priority: number;
  createdAt: Date;
}

/**
 * The candidates that match, best first within each priority band — priority
 * still leads, as it does everywhere in the list, and newer breaks a tie.
 */
export function rankMatches<T extends Searchable & Omit<RankedMatch, 'score'>>(
  candidates: readonly T[],
  tokens: readonly string[],
): RankedMatch[] {
  const matches: RankedMatch[] = [];
  for (const candidate of candidates) {
    const score = matchScore(tokens, candidate);
    if (score === null) continue;
    matches.push({
      id: candidate.id,
      score,
      priority: candidate.priority,
      createdAt: candidate.createdAt,
    });
  }
  return matches.sort(
    (a, b) =>
      b.priority - a.priority || b.score - a.score || b.createdAt.getTime() - a.createdAt.getTime(),
  );
}
