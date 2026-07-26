import { brotliDecompressSync, gunzipSync, inflateSync, inflateRawSync } from 'node:zlib';
import type { ScrapeDebug, ProxyRequestKind } from '@pricepulse/shared';

/**
 * Proxy bandwidth accounting + response decompression.
 *
 * The proxy bills WIRE bytes (compressed), but got's decompressed `body.length`
 * is 5–9× larger — so metering must read the compressed transfer. We therefore
 * fetch with `decompress: false` (raw compressed body = exact wire bytes),
 * record that, and decompress here for the parser.
 *
 * Compression is REQUIRED for cost: without an explicit accept-encoding,
 * Flipkart returns HTML uncompressed (~1.8 MB vs ~207 KB). We pin the header to
 * a value every CDN honours — and, by choosing it ourselves, we bound the
 * encodings we must decode to exactly this set (so `decompressBody` is total).
 */
export const ACCEPT_ENCODING = 'gzip, deflate, br';

/**
 * Decode a raw (possibly compressed) response body to text. Handles exactly the
 * encodings ACCEPT_ENCODING can elicit; an unrecognised/empty encoding is
 * treated as identity. Throws only if the bytes are corrupt for their declared
 * encoding — which surfaces as a normal failed check, never silent garbage.
 */
export function decompressBody(raw: Buffer, contentEncoding: string | undefined): string {
  const enc = (contentEncoding ?? '').trim().toLowerCase();
  switch (enc) {
    case 'br':
      return brotliDecompressSync(raw).toString('utf8');
    case 'gzip':
      return gunzipSync(raw).toString('utf8');
    case 'deflate':
      // Some servers send raw deflate (no zlib header); fall back to it.
      try {
        return inflateSync(raw).toString('utf8');
      } catch {
        return inflateRawSync(raw).toString('utf8');
      }
    case '':
    case 'identity':
      return raw.toString('utf8');
    default:
      // An encoding we didn't ask for (e.g. zstd). Best-effort: return as-is
      // rather than throw — parsing will fail cleanly if it really is encoded.
      return raw.toString('utf8');
  }
}

/** Record one proxied request's wire cost into the per-check debug sink. */
export function recordProxyBytes(
  debug: ScrapeDebug | undefined,
  kind: ProxyRequestKind,
  wireBytes: number,
  opts: { tier?: string; retry?: boolean } = {},
): void {
  if (!debug) return;
  const p = (debug.proxy ??= { wireBytes: 0, requests: 0, retries: 0, byKind: {} });
  p.wireBytes += wireBytes;
  p.requests += 1;
  if (opts.retry) p.retries += 1;
  const k = (p.byKind[kind] ??= { wireBytes: 0, requests: 0 });
  k.wireBytes += wireBytes;
  k.requests += 1;
}
