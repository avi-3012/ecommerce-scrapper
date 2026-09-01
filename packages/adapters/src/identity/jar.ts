import type { Cookie, CookieRecord } from './cookie.js';
import { domainMatches, parseSetCookie, pathMatches, serializeCookies } from './cookie.js';

/**
 * One cookie jar per identity per site, persisted so it survives restarts.
 *
 * A real browser accumulates cookies over weeks; ours must too, because the
 * cookie jar is a load-bearing half of an identity's consistency. A session
 * cookie set on Monday and still presented on Friday is what makes the identity
 * look like the same returning household device rather than a fresh visitor
 * every 2 minutes.
 *
 * Shaped to got's promise-style `cookieJar` contract — `setCookie(raw, url)` /
 * `getCookieString(url)` — so it can be handed straight to got-scraping.
 */
export class IdentityCookieJar {
  /** site host key ('amazon.in') → cookies for that site. */
  private readonly sites = new Map<string, Cookie[]>();
  private dirty = false;

  constructor(
    /** Called whenever the jar changes, so the store can schedule a flush. */
    private readonly onChange: () => void = () => {},
  ) {}

  /** The site key a URL belongs to: the registrable-ish host, e.g. 'amazon.in'. */
  static siteKey(url: string): string {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    // Two marketplaces, both with a handful of subdomains (rome.api.flipkart.com,
    // amazon.in). Collapse to the last two labels, which is exactly right for
    // .in / .com and keeps one jar per marketplace rather than per subdomain.
    const parts = host.split('.');
    return parts.length <= 2 ? host : parts.slice(-2).join('.');
  }

  async setCookie(rawCookie: string, url: string): Promise<void> {
    const parsed = parseSetCookie(rawCookie, url);
    if (!parsed) return;
    const key = IdentityCookieJar.siteKey(url);
    const jar = this.sites.get(key) ?? [];
    const index = jar.findIndex(
      (c) => c.key === parsed.key && c.domain === parsed.domain && c.path === parsed.path,
    );
    // A Set-Cookie with an expiry in the past is a deletion, not a cookie.
    if (parsed.expires !== null && parsed.expires <= Date.now()) {
      if (index >= 0) jar.splice(index, 1);
    } else if (index >= 0) {
      jar[index] = parsed;
    } else {
      jar.push(parsed);
    }
    this.sites.set(key, jar);
    this.touch();
  }

  async getCookieString(url: string): Promise<string> {
    return this.cookieHeaderFor(url);
  }

  /** Synchronous read of the Cookie header for a URL (for non-got call sites). */
  cookieHeaderFor(url: string, nowMs: number = Date.now()): string {
    const target = new URL(url);
    const jar = this.sites.get(IdentityCookieJar.siteKey(url)) ?? [];
    const live = jar.filter((c) => c.expires === null || c.expires > nowMs);
    if (live.length !== jar.length) {
      this.sites.set(IdentityCookieJar.siteKey(url), live);
      this.touch();
    }
    const matching = live.filter(
      (c) =>
        domainMatches(target.hostname, c.domain, c.hostOnly) &&
        pathMatches(target.pathname, c.path) &&
        (!c.secure || target.protocol === 'https:'),
    );
    return serializeCookies(matching);
  }

  /** Whether this identity has ever collected a cookie for a site. */
  hasCookiesFor(url: string): boolean {
    return (this.sites.get(IdentityCookieJar.siteKey(url)) ?? []).length > 0;
  }

  /** Drop every cookie for one site (used when an identity is retired/recycled). */
  clearSite(url: string): void {
    if (this.sites.delete(IdentityCookieJar.siteKey(url))) this.touch();
  }

  toJSON(): Record<string, CookieRecord[]> {
    const out: Record<string, CookieRecord[]> = {};
    for (const [site, cookies] of this.sites) out[site] = cookies;
    return out;
  }

  static fromJSON(
    data: Record<string, CookieRecord[]> | undefined,
    onChange: () => void = () => {},
  ): IdentityCookieJar {
    const jar = new IdentityCookieJar(onChange);
    for (const [site, cookies] of Object.entries(data ?? {})) {
      jar.sites.set(
        site,
        cookies.filter(
          (c): c is Cookie => typeof c?.key === 'string' && typeof c?.value === 'string',
        ),
      );
    }
    jar.dirty = false;
    return jar;
  }

  get isDirty(): boolean {
    return this.dirty;
  }

  markClean(): void {
    this.dirty = false;
  }

  private touch(): void {
    this.dirty = true;
    this.onChange();
  }
}
