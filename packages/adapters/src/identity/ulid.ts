import { randomBytes } from 'node:crypto';

/**
 * ULID (Crockford base32, 26 chars): 48-bit timestamp + 80 bits of randomness.
 * Lexicographically sortable by creation time, which is what we want for
 * identity ids — `ls` of the store reads as a timeline of the pool.
 *
 * Implemented here rather than pulled in as a dependency: it is twenty lines
 * and the identity layer is the only consumer.
 */
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32 (no I, L, O, U)

function encode(value: number, length: number): string {
  let out = '';
  for (let i = length - 1; i >= 0; i--) {
    out = ENCODING[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

/** 10 timestamp characters + 16 randomness characters = the canonical 26. */
const RANDOM_CHARS = 16;

export function ulid(nowMs: number = Date.now()): string {
  const time = encode(nowMs, 10);
  const bytes = randomBytes(RANDOM_CHARS);
  let random = '';
  for (const byte of bytes) random += ENCODING[byte % 32]!;
  return time + random;
}

/** The creation time encoded in a ULID, or null if it isn't one. */
export function ulidTime(id: string): number | null {
  if (!/^[0-9A-HJKMNP-TV-Z]{26}$/.test(id)) return null;
  let ms = 0;
  for (const ch of id.slice(0, 10)) ms = ms * 32 + ENCODING.indexOf(ch);
  return ms;
}
