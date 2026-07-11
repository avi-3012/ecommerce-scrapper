import { describe, expect, it } from 'vitest';
import { loadConfig } from './config.js';

const valid = {
  DATABASE_URL: 'postgresql://pricepulse:pricepulse@localhost:5432/pricepulse',
  JWT_SECRET: 'x'.repeat(32),
  SETTINGS_ENC_KEY: 'ab'.repeat(32),
};

describe('loadConfig (fail-fast env validation, WP-0.5)', () => {
  it('accepts a valid environment and applies defaults', () => {
    const config = loadConfig(valid);
    expect(config.PORT).toBe(3000);
    expect(config.NODE_ENV).toBe('development');
  });

  it('names the missing variable in the error', () => {
    const { DATABASE_URL: _omitted, ...withoutDb } = valid;
    expect(() => loadConfig(withoutDb)).toThrow(/DATABASE_URL/);
  });

  it('rejects a malformed encryption key with guidance', () => {
    expect(() => loadConfig({ ...valid, SETTINGS_ENC_KEY: 'too-short' })).toThrow(
      /64 hex characters/,
    );
  });

  it('rejects a short JWT secret', () => {
    expect(() => loadConfig({ ...valid, JWT_SECRET: 'short' })).toThrow(/32 characters/);
  });
});
