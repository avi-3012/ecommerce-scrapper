import { gotScraping } from 'got-scraping';
import * as cheerio from 'cheerio';
import { scraperProxyUrl } from './proxy.js';

/**
 * Location-aware scraping (pincode). Amazon India localises price, delivery and
 * offers by delivery location; anonymous location is set via its "glow" flow:
 *
 *   1. GET a page → session cookies + an `anti-csrftoken-a2z` token.
 *   2. POST /portal-migration/hz/glow/address-change with the pincode + token.
 *   3. Reuse the resulting cookies on every product fetch → localised pages.
 *
 * The cookie header is cached per pincode (it is session-bound, so it is
 * refreshed periodically). Returns undefined on any failure — callers then
 * fetch without a location (marketplace default), never hard-failing.
 *
 * NOTE: the cookies are tied to the session/IP they were minted on. Behind a
 * residential proxy that rotates IPs per request, use a STICKY session so the
 * location-set and the product fetches share an IP — otherwise Amazon may
 * ignore the location cookie.
 */

const CACHE_TTL_MS = 20 * 60_000;
const locationCache = new Map<string, { cookie: string; expiresAt: number }>();

const HEADER_GEN = { devices: ['desktop'] as const, locales: ['en-IN'] as const };

function absorbCookies(jar: Map<string, string>, setCookie: unknown): void {
  const lines = Array.isArray(setCookie) ? (setCookie as string[]) : [];
  for (const line of lines) {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * Establish (and cache) Amazon location cookies for a pincode. `seedUrl` is a
 * real product page used to mint the session + CSRF token — Amazon serves a
 * blocked stub for the bare homepage, so a product page is required.
 */
export async function amazonLocationCookie(
  pincode: string,
  seedUrl: string,
): Promise<string | undefined> {
  const key = `amazon:${pincode}`;
  const cached = locationCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.cookie;

  const proxyUrl = scraperProxyUrl();
  const proxyOpts = proxyUrl ? { proxyUrl, http2: false as const } : {};
  const jar = new Map<string, string>();
  try {
    // 1. Seed cookies + read the glow CSRF token from the location modal.
    const seed = await gotScraping({
      url: seedUrl,
      timeout: { request: 20_000 },
      throwHttpErrors: false,
      ...proxyOpts,
      headerGeneratorOptions: HEADER_GEN,
    });
    absorbCookies(jar, seed.headers['set-cookie']);
    const modal =
      cheerio.load(seed.body)('#nav-global-location-data-modal-action').attr('data-a-modal') ?? '';
    const token = modal.match(/anti-csrftoken-a2z"\s*:\s*"([^"]+)"/)?.[1];
    if (!token) return undefined;

    // 2. Set the delivery location.
    const res = await gotScraping({
      url: 'https://www.amazon.in/portal-migration/hz/glow/address-change?actionSource=glow',
      method: 'POST',
      timeout: { request: 20_000 },
      throwHttpErrors: false,
      ...proxyOpts,
      headers: {
        'anti-csrftoken-a2z': token,
        'x-requested-with': 'XMLHttpRequest',
        'content-type': 'application/x-www-form-urlencoded',
        cookie: cookieHeader(jar),
        referer: seedUrl,
      },
      body: `locationType=LOCATION_INPUT&zipCode=${encodeURIComponent(pincode)}&storeContext=generic&deviceType=web&pageType=Detail&actionSource=glow`,
      headerGeneratorOptions: HEADER_GEN,
    });
    absorbCookies(jar, res.headers['set-cookie']);

    const cookie = cookieHeader(jar);
    if (!cookie) return undefined;
    locationCache.set(key, { cookie, expiresAt: Date.now() + CACHE_TTL_MS });
    return cookie;
  } catch {
    return undefined;
  }
}

/** Test-only: clear the location cache. */
export function clearLocationCache(): void {
  locationCache.clear();
}
