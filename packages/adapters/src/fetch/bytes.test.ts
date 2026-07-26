import { brotliCompressSync, gzipSync, deflateSync, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import type { ScrapeDebug } from '@pricepulse/shared';
import { decompressBody, recordProxyBytes } from './bytes.js';

const SAMPLE =
  '<html><script>window.__INITIAL_STATE__={"pricing":{"finalPrice":54990}}</script></html>';

describe('decompressBody — round-trips every encoding we request', () => {
  it('br', () => {
    expect(decompressBody(brotliCompressSync(Buffer.from(SAMPLE)), 'br')).toBe(SAMPLE);
  });
  it('gzip', () => {
    expect(decompressBody(gzipSync(Buffer.from(SAMPLE)), 'gzip')).toBe(SAMPLE);
  });
  it('deflate (zlib-wrapped)', () => {
    expect(decompressBody(deflateSync(Buffer.from(SAMPLE)), 'deflate')).toBe(SAMPLE);
  });
  it('deflate (raw, headerless)', () => {
    expect(decompressBody(deflateRawSync(Buffer.from(SAMPLE)), 'deflate')).toBe(SAMPLE);
  });
  it('identity / empty encoding passes through', () => {
    expect(decompressBody(Buffer.from(SAMPLE), undefined)).toBe(SAMPLE);
    expect(decompressBody(Buffer.from(SAMPLE), 'identity')).toBe(SAMPLE);
  });
  it('case/whitespace-insensitive', () => {
    expect(decompressBody(gzipSync(Buffer.from(SAMPLE)), ' GZIP ')).toBe(SAMPLE);
  });
  it('an unrequested encoding is returned as-is, never thrown', () => {
    expect(decompressBody(Buffer.from(SAMPLE), 'zstd')).toBe(SAMPLE);
  });
});

describe('recordProxyBytes', () => {
  it('accumulates totals and a per-kind breakdown', () => {
    const debug: ScrapeDebug = {};
    recordProxyBytes(debug, 'main_page', 200_000);
    recordProxyBytes(debug, 'pincode_api', 40_000);
    recordProxyBytes(debug, 'pincode_api', 40_000, { retry: true });
    expect(debug.proxy?.wireBytes).toBe(280_000);
    expect(debug.proxy?.requests).toBe(3);
    expect(debug.proxy?.retries).toBe(1);
    expect(debug.proxy?.byKind.pincode_api).toEqual({ wireBytes: 80_000, requests: 2 });
    expect(debug.proxy?.byKind.main_page).toEqual({ wireBytes: 200_000, requests: 1 });
  });
  it('is a no-op without a debug sink', () => {
    expect(() => recordProxyBytes(undefined, 'main_page', 1)).not.toThrow();
  });
});
