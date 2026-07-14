/**
 * Outbound proxy config (R-2 mitigation). Both the tier-1 HTTP fetch and the
 * tier-2 browser fetch route through a residential/rotating proxy when
 * SCRAPER_PROXY_URL is set — the effective cure for datacenter-IP blocking.
 *
 * Format:  http://USERNAME:PASSWORD@HOST:PORT   (https:// and socks5:// also work)
 * Example (1024Proxy-style gateway):
 *   http://user-region-in:pass@gw.1024proxy.example:8000
 *
 * Unset ⇒ no proxy (direct connection), so this is fully opt-in per environment.
 */
export function scraperProxyUrl(): string | undefined {
  const raw = process.env.SCRAPER_PROXY_URL?.trim();
  return raw && raw.length > 0 ? raw : undefined;
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
  try {
    const u = new URL(raw);
    const proxy: PlaywrightProxy = { server: `${u.protocol}//${u.host}` };
    if (u.username) proxy.username = decodeURIComponent(u.username);
    if (u.password) proxy.password = decodeURIComponent(u.password);
    return proxy;
  } catch {
    // A malformed proxy URL shouldn't crash a check; log once and go direct.
    console.error('SCRAPER_PROXY_URL is not a valid URL — ignoring and connecting directly.');
    return undefined;
  }
}

/** Host:port only, for safe logging (never prints credentials). */
export function proxyLabel(): string | undefined {
  const proxy = playwrightProxy();
  return proxy?.server;
}
