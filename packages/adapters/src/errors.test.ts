import { describe, expect, it } from 'vitest';
import { CheckError, toCheckError } from './errors.js';

describe('CheckError escalation', () => {
  it('defaults to escalatable, so an ordinary parse failure still reaches the browser tier', () => {
    expect(new CheckError('parse_failed', 'client-rendered page').escalate).toBe(true);
  });

  it('can opt out, for failures a browser would reproduce exactly', () => {
    expect(new CheckError('parse_failed', 'wrong variant', { escalate: false }).escalate).toBe(
      false,
    );
  });

  it('preserves the flag through toCheckError', () => {
    const err = new CheckError('parse_failed', 'wrong variant', { escalate: false });
    expect(toCheckError(err).escalate).toBe(false);
  });

  it('treats an unknown thrown value as escalatable', () => {
    expect(toCheckError(new Error('boom')).escalate).toBe(true);
  });
});
