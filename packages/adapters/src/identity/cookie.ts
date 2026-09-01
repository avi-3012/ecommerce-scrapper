/**
 * A minimal RFC 6265 Set-Cookie parser and matcher.
 *
 * Deliberately hand-rolled rather than pulling in tough-cookie: the jar only
 * ever talks to two marketplaces over https, and keeping the cookie shape a
 * plain JSON record is what lets a jar be persisted, diffed and restored
 * verbatim across restarts without a serialization adapter in the middle.
 */

export interface CookieRecord {
  key: string;
  value: string;
  domain: string;
  path: string;
  /** Epoch ms, or null for a session cookie. */
  expires: number | null;
  secure: boolean;
  /** True when the Set-Cookie carried no Domain attribute (exact-host only). */
  hostOnly: boolean;
}

export type Cookie = CookieRecord;

/** The default path for a cookie set from `url`, per RFC 6265 §5.1.4. */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : pathname.slice(0, lastSlash);
}

export function parseSetCookie(raw: string, url: string): Cookie | null {
  const parts = raw.split(';');
  const pair = parts[0] ?? '';
  const eq = pair.indexOf('=');
  if (eq <= 0) return null;
  const key = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!key) return null;

  const target = new URL(url);
  const cookie: Cookie = {
    key,
    value,
    domain: target.hostname.toLowerCase(),
    path: defaultPath(target.pathname),
    expires: null,
    secure: false,
    hostOnly: true,
  };

  let maxAge: number | null = null;
  for (const attribute of parts.slice(1)) {
    const attrEq = attribute.indexOf('=');
    const name = (attrEq < 0 ? attribute : attribute.slice(0, attrEq)).trim().toLowerCase();
    const attrValue = attrEq < 0 ? '' : attribute.slice(attrEq + 1).trim();
    switch (name) {
      case 'domain': {
        const domain = attrValue.replace(/^\./, '').toLowerCase();
        // Ignore a Domain that tries to widen beyond the origin host.
        if (domain && domainMatches(target.hostname, domain, false)) {
          cookie.domain = domain;
          cookie.hostOnly = false;
        }
        break;
      }
      case 'path':
        if (attrValue.startsWith('/')) cookie.path = attrValue;
        break;
      case 'expires': {
        const parsed = Date.parse(attrValue);
        if (Number.isFinite(parsed)) cookie.expires = parsed;
        break;
      }
      case 'max-age': {
        const seconds = Number(attrValue);
        if (Number.isFinite(seconds)) maxAge = seconds;
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      default:
        break; // httponly / samesite / priority — no effect on what we send
    }
  }
  // Max-Age wins over Expires when both are present (RFC 6265 §5.3).
  if (maxAge !== null) cookie.expires = Date.now() + maxAge * 1000;
  return cookie;
}

/** RFC 6265 §5.1.3 domain matching, plus the host-only shortcut. */
export function domainMatches(host: string, domain: string, hostOnly: boolean): boolean {
  const h = host.toLowerCase();
  const d = domain.toLowerCase();
  if (h === d) return true;
  if (hostOnly) return false;
  return h.endsWith(`.${d}`);
}

/** RFC 6265 §5.1.4 path matching. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

export function serializeCookies(cookies: readonly Cookie[]): string {
  // Longer paths first, then oldest first — the order a browser sends.
  return [...cookies]
    .sort((a, b) => b.path.length - a.path.length)
    .map((c) => `${c.key}=${c.value}`)
    .join('; ');
}
