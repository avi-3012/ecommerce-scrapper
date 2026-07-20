import { gotScraping } from 'got-scraping';

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

/**
 * The proxy region + sticky-session token from the username (e.g.
 * "region-IN-sid-qAeygDrY"), for the scrape-audit trail — it identifies which
 * exit-IP pool a check used when diagnosing location/price variance. Returns
 * the raw username tail when no recognised tokens are present; never the
 * password.
 */
export function proxySession(): string | undefined {
  const raw = scraperProxyUrl();
  if (!raw) return undefined;
  try {
    const user = decodeURIComponent(new URL(raw).username);
    if (!user) return undefined;
    const region = user.match(/region-[A-Za-z0-9]+/i)?.[0];
    const sid = user.match(/sid-[A-Za-z0-9]+/i)?.[0];
    const tokens = [region, sid].filter(Boolean);
    return tokens.length ? tokens.join('-') : undefined;
  } catch {
    return undefined;
  }
}

let exitIpCache: { ip: string | null; at: number } | null = null;

/**
 * The actual outbound IP a scrape uses, resolved THROUGH the same proxy so it
 * reflects the exit node the marketplace saw (the sticky session is stable for
 * a few minutes, so this is cached for 60s to avoid an echo call per check).
 * Best-effort: returns null on any failure and never throws. Set
 * SCRAPE_AUDIT_EXIT_IP=0 to disable the echo entirely.
 *
 * This is the field that proves region-based price flapping — Flipkart's
 * IP-default price is driven by the exit node's region, which rotates.
 */
export async function resolveExitIp(nowMs: number = Date.now()): Promise<string | null> {
  if (process.env.SCRAPE_AUDIT_EXIT_IP === '0') return null;
  if (exitIpCache && nowMs - exitIpCache.at < 60_000) return exitIpCache.ip;
  const proxyUrl = scraperProxyUrl();
  let ip: string | null = null;
  for (const url of ['https://checkip.amazonaws.com', 'https://api.ipify.org']) {
    try {
      const res = await gotScraping({
        url,
        timeout: { request: 6000 },
        throwHttpErrors: false,
        ...(proxyUrl ? { proxyUrl, http2: false } : {}),
      });
      if (res.statusCode === 200) {
        const candidate = res.body.trim().split(/\s+/)[0];
        if (candidate && /^[0-9a-fA-F.:]+$/.test(candidate)) {
          ip = candidate;
          break;
        }
      }
    } catch {
      // try the next echo endpoint
    }
  }
  exitIpCache = { ip, at: nowMs };
  return ip;
}
