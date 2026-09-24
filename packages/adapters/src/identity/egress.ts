import type { ScrapingConfig } from './types.js';

/**
 * Where a request leaves from.
 *
 * Two kinds, one model. An ADDRESS route binds the socket to one of the host's
 * own IPs; a PROXY route tunnels through a static ISP proxy that presents its
 * own IP to the far end. Everything above this layer — one governor per route,
 * one route per identity for its whole life, blocks counted where they land —
 * is the same for both, which is the point: the identity pool does not care
 * whether an address is on the host or rented, only that a persona never
 * changes it.
 *
 * `id` is what everything else keys on: files, log lines, the dashboard. A
 * proxy's id is `host:port`, never its URL, because the URL carries the
 * credentials and the id ends up in diagnostics bundles people share.
 */
export interface EgressRoute {
  id: string;
  kind: 'address' | 'proxy';
  /** Address routes: the local IP to bind. */
  localAddress?: string;
  /** Proxy routes: the full proxy URL, credentials included. Never logged. */
  proxyUrl?: string;
}

/** A proxy's stable, credential-free id. */
export function proxyRouteId(proxyUrl: string): string {
  const url = new URL(proxyUrl);
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  return `${url.hostname}:${port}`;
}

export function egressRoutes(config: Pick<ScrapingConfig, 'egress' | 'proxies'>): EgressRoute[] {
  return [
    ...config.egress.map((ip): EgressRoute => ({ id: ip, kind: 'address', localAddress: ip })),
    ...config.proxies.map((proxyUrl): EgressRoute => ({
      id: proxyRouteId(proxyUrl),
      kind: 'proxy',
      proxyUrl,
    })),
  ];
}

/** Every route id, in config order. Empty means the host's default route. */
export function egressIds(config: Pick<ScrapingConfig, 'egress' | 'proxies'>): string[] {
  return egressRoutes(config).map((route) => route.id);
}

export function routeFor(
  config: Pick<ScrapingConfig, 'egress' | 'proxies'>,
  egressId: string | undefined,
): EgressRoute | undefined {
  if (!egressId) return undefined;
  return egressRoutes(config).find((route) => route.id === egressId);
}

/**
 * What a request needs in order to leave from a route.
 *
 * Address routes keep the identity's own HTTP/2 agent (bound to the address).
 * Proxy routes must NOT: got-scraping builds the tunnelling agents itself from
 * `proxyUrl`, and an agent of ours would either be overwritten or, worse, win
 * and send around the proxy from the host's own address.
 */
export function transportOptions(route: EgressRoute | undefined): {
  proxyUrl?: string;
  localAddress?: string;
  ownAgent: boolean;
} {
  if (!route) return { ownAgent: true };
  if (route.kind === 'proxy') return { proxyUrl: route.proxyUrl, ownAgent: false };
  return { localAddress: route.localAddress, ownAgent: true };
}

/**
 * The proxy as Playwright wants it — server without credentials, credentials
 * beside it. Unlike an address (a socket cannot be bound from inside Chromium),
 * a proxy is something the browser tier CAN honour, so a tier-2 escalation
 * leaves from the same place as the identity's tier-1 requests.
 */
export function browserProxyFor(
  route: EgressRoute | undefined,
): { server: string; username?: string; password?: string } | undefined {
  if (!route || route.kind !== 'proxy' || !route.proxyUrl) return undefined;
  const url = new URL(route.proxyUrl);
  const server = `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  if (!url.username) return { server };
  return {
    server,
    username: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
  };
}
