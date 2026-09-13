import * as cheerio from 'cheerio';
import type { ScrapeDebug } from '@pricepulse/shared';
import type { IdentitySession } from '../identity/session.js';
import { CheckError } from '../errors.js';

/**
 * Location-aware scraping (pincode). Amazon India localises price, delivery and
 * offers by delivery location; anonymous location is set via its "glow" flow:
 *
 *   1. GET a page → session cookies + an `anti-csrftoken-a2z` token.
 *   2. POST /portal-migration/hz/glow/address-change with the pincode + token.
 *   3. Reuse the resulting cookies on every product fetch → localised pages.
 *
 * The resulting cookies land in the IDENTITY'S OWN JAR, and the cookie header
 * is cached per identity+pincode. Amazon binds the glow cookie to the session
 * that set it, so it can never be shared between identities: a cookie minted by
 * one persona and replayed by another is a contradiction of exactly the kind
 * this layer exists to prevent. Returns undefined when the location could not
 * be set; a refusal from Amazon is rethrown as the block it is, never disguised
 * as a missing location.
 */

/**
 * Failures that must not be flattened into "no location". Each already means
 * something specific to the pipeline — a block to back off from, a listing that
 * is gone — and `pageFetch` has already acted on it (cooled the identity,
 * captured the body) by the time it throws.
 */
const PROPAGATE: ReadonlySet<string> = new Set(['fetch_blocked', 'captcha', 'listing_removed']);

const CACHE_TTL_MS = 20 * 60_000;
const locationCache = new Map<string, { cookie: string; expiresAt: number }>();

/**
 * Establish (and cache) Amazon location cookies for a pincode. `seedUrl` is a
 * real product page used to mint the session + CSRF token — Amazon serves a
 * blocked stub for the bare homepage, so a product page is required.
 */
export async function amazonLocationCookie(
  session: IdentitySession,
  pincode: string,
  seedUrl: string,
  forceRefresh = false,
  debug?: ScrapeDebug,
): Promise<string | undefined> {
  const key = `${session.id}:amazon:${pincode}`;
  if (!forceRefresh) {
    const cached = locationCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.cookie;
  }

  try {
    // 1. Seed cookies + read the glow CSRF token from the location modal. This
    //    is the identity opening the product page it is about to price, so it
    //    goes through `pageFetch` like every other page load: warmed up first if
    //    the identity is fresh, classified, paced off a timestamp that actually
    //    advances, and cooled if Amazon refuses it.
    //
    //    It used to call `session.request` directly and skip all four. On
    //    13 Sep 2026 that let fresh identities hit a product page cold, read a
    //    ~1.3 KB refusal as "no token", and — with no block recorded and
    //    `lastRequestAt` never stamped — be handed straight back out by
    //    least-recently-used rotation: one identity failed six products in three
    //    minutes, loading a refused page each time.
    const seed = await session.pageFetch(seedUrl, { kind: 'cookie_mint', debug });
    const modal =
      cheerio.load(seed.body)('#nav-global-location-data-modal-action').attr('data-a-modal') ?? '';
    const token = modal.match(/anti-csrftoken-a2z"\s*:\s*"([^"]+)"/)?.[1];
    if (!token) return undefined;

    // 2. Set the delivery location. An XHR the real page fires, so it rides the
    //    identity's jar (which already holds the seed cookies) without counting
    //    as another page load.
    await session.request(
      'https://www.amazon.in/portal-migration/hz/glow/address-change?actionSource=glow',
      {
        method: 'POST',
        kind: 'cookie_mint',
        debug,
        navigation: false,
        headers: {
          'anti-csrftoken-a2z': token,
          'x-requested-with': 'XMLHttpRequest',
          'content-type': 'application/x-www-form-urlencoded',
          referer: seedUrl,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
        },
        body: `locationType=LOCATION_INPUT&zipCode=${encodeURIComponent(pincode)}&storeContext=generic&deviceType=web&pageType=Detail&actionSource=glow`,
      },
    );

    // The jar absorbed every Set-Cookie from both calls; this header is what the
    // identity would now send, and what the browser tier is handed verbatim.
    const cookie = session.cookieHeaderFor(seedUrl);
    if (!cookie) return undefined;
    locationCache.set(key, { cookie, expiresAt: Date.now() + CACHE_TTL_MS });
    return cookie;
  } catch (err) {
    // A refusal is not "location unavailable" — it is a block, and it has to
    // reach the pipeline as one, so the check is recorded as fetch_blocked and
    // not as a localisation fault. Only genuinely non-block failures (a modal
    // without a token, a transport error on the address-change XHR) still
    // degrade to "no location".
    if (err instanceof CheckError && PROPAGATE.has(err.reason)) throw err;
    return undefined;
  }
}

/**
 * Whether a fetched Amazon page actually reflects the requested pincode. Amazon
 * shows the resolved delivery location in the "glow" ingress (e.g. "Mumbai
 * 400001"); if our pincode isn't there, the location cookie didn't take and the
 * price is the default-location one.
 */
export function amazonLocationApplied(html: string, pincode: string): boolean {
  return amazonResolvedLocation(html).includes(pincode);
}

/** The delivery location string the Amazon page actually shows (glow ingress). */
export function amazonResolvedLocation(html: string): string {
  return cheerio.load(html)('#glow-ingress-line2').text().replace(/\s+/g, ' ').trim();
}

/** Test-only: clear the location cache. */
export function clearLocationCache(): void {
  locationCache.clear();
}
