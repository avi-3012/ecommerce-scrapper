/**
 * Outbound proxy config (R-2 mitigation). Both the tier-1 HTTP fetch and the
 * tier-2 browser fetch route through a residential/rotating proxy when
 * SCRAPER_PROXY_URL is set — the effective cure for datacenter-IP blocking.
 *
 * Accepts the common formats proxy dashboards hand out and normalizes them to
 * a proper URL:
 *   http://USER:PASS@HOST:PORT     (canonical)
 *   USER:PASS@HOST:PORT            (scheme assumed http)
 *   HOST:PORT:USER:PASS            (colon-delimited, e.g. 1024Proxy)
 *   HOST:PORT                      (IP-authenticated, no credentials)
 *
 * Unset ⇒ no proxy (direct connection), so this is fully opt-in per environment.
 */

/** Turn whatever the dashboard gave us into a canonical proxy URL string. */
function normalizeProxyUrl(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  // Already has a scheme (http://, https://, socks5://, …) — trust it.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  // "user:pass@host:port" with no scheme.
  if (s.includes('@')) return `http://${s}`;
  // Colon-delimited without credentials-marker.
  const parts = s.split(':');
  if (parts.length === 4) return `http://${parts[2]}:${parts[3]}@${parts[0]}:${parts[1]}`; // host:port:user:pass
  if (parts.length === 2) return `http://${parts[0]}:${parts[1]}`; // host:port
  // Last resort: assume it's a host and prepend a scheme.
  return `http://${s}`;
}

export function scraperProxyUrl(): string | undefined {
  const raw = process.env.SCRAPER_PROXY_URL;
  if (!raw || raw.trim().length === 0) return undefined;
  const normalized = normalizeProxyUrl(raw);
  if (!normalized) return undefined;
  try {
    const u = new URL(normalized);
    if (!u.hostname) throw new Error('no host');
    return normalized;
  } catch {
    console.error(
      'SCRAPER_PROXY_URL could not be parsed — expected http://user:pass@host:port. Connecting directly.',
    );
    return undefined;
  }
}

export interface PlaywrightProxy {
  server: string;
  username?: string;
  password?: string;
}

/**
 * Playwright wants the credentials split out of the server URL. Returns
 * undefined when no proxy is configured (so `proxy: undefined` is passed).
 */
export function playwrightProxy(): PlaywrightProxy | undefined {
  const raw = scraperProxyUrl();
  if (!raw) return undefined;
  const u = new URL(raw);
  const proxy: PlaywrightProxy = { server: `${u.protocol}//${u.host}` };
  if (u.username) proxy.username = decodeURIComponent(u.username);
  if (u.password) proxy.password = decodeURIComponent(u.password);
  return proxy;
}

/** Host:port only, for safe logging (never prints credentials). */
export function proxyLabel(): string | undefined {
  return playwrightProxy()?.server;
}
