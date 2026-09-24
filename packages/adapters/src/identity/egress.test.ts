import { describe, expect, it } from 'vitest';
import { mergeConfig } from './config.js';
import {
  browserProxyFor,
  egressIds,
  egressRoutes,
  proxyRouteId,
  routeFor,
  transportOptions,
} from './egress.js';
import { IdentitySession } from './session.js';
import { createTestRig } from './testing.js';
import { DEFAULT_SCRAPING_CONFIG } from './config.js';

const PROXY = 'http://user:s3cret@103.1.2.3:8080';

describe('proxy routes', () => {
  it('identifies a proxy by host:port, never by its URL', () => {
    // The id lands in file names, log lines and diagnostics bundles people
    // share. The credentials must not.
    expect(proxyRouteId(PROXY)).toBe('103.1.2.3:8080');
    expect(proxyRouteId('https://u:p@proxy.example.com')).toBe('proxy.example.com:443');
    expect(proxyRouteId('http://proxy.example.com')).toBe('proxy.example.com:80');
  });

  it('treats addresses and proxies as one list of routes', () => {
    const routes = egressRoutes({ egress: ['172.31.7.30'], proxies: [PROXY] });
    expect(routes).toEqual([
      { id: '172.31.7.30', kind: 'address', localAddress: '172.31.7.30' },
      { id: '103.1.2.3:8080', kind: 'proxy', proxyUrl: PROXY },
    ]);
    expect(egressIds({ egress: ['172.31.7.30'], proxies: [PROXY] })).toEqual([
      '172.31.7.30',
      '103.1.2.3:8080',
    ]);
    expect(routeFor({ egress: [], proxies: [PROXY] }, '103.1.2.3:8080')?.proxyUrl).toBe(PROXY);
    expect(routeFor({ egress: [], proxies: [PROXY] }, undefined)).toBeUndefined();
  });

  it('sends address routes through our own bound agent, proxy routes through got-scraping', () => {
    expect(transportOptions(undefined)).toEqual({ ownAgent: true });
    expect(transportOptions({ id: 'a', kind: 'address', localAddress: '172.31.7.30' })).toEqual({
      localAddress: '172.31.7.30',
      ownAgent: true,
    });
    // No agent of ours on a proxy route: it would send around the proxy from
    // the host's own address, presenting the identity from the wrong place.
    expect(transportOptions({ id: 'p', kind: 'proxy', proxyUrl: PROXY })).toEqual({
      proxyUrl: PROXY,
      ownAgent: false,
    });
  });

  it("gives the browser tier the proxy in Playwright's shape", () => {
    expect(browserProxyFor({ id: 'p', kind: 'proxy', proxyUrl: PROXY })).toEqual({
      server: 'http://103.1.2.3:8080',
      username: 'user',
      password: 's3cret',
    });
    expect(browserProxyFor({ id: 'p', kind: 'proxy', proxyUrl: 'http://1.2.3.4:3128' })).toEqual({
      server: 'http://1.2.3.4:3128',
    });
    // Addresses cannot be honoured by a browser; it says so by returning nothing.
    expect(browserProxyFor({ id: 'a', kind: 'address', localAddress: '10.0.0.1' })).toBeUndefined();
  });
});

describe('proxies in the scraping config', () => {
  it('accepts http and https proxies with credentials', () => {
    const config = mergeConfig({ proxies: [PROXY, 'https://a:b@proxy.example.com:443'] });
    expect(config.proxies).toEqual([PROXY, 'https://a:b@proxy.example.com:443']);
  });

  it('refuses what got-scraping cannot tunnel through, at load rather than at the first request', () => {
    expect(() => mergeConfig({ proxies: ['socks5://u:p@1.2.3.4:1080'] })).toThrow(/socks5/);
    expect(() => mergeConfig({ proxies: ['not a url'] })).toThrow(/not a URL/);
    expect(() => mergeConfig({ proxies: 'http://x' })).toThrow(/array/);
  });

  it('refuses the same proxy twice', () => {
    expect(() =>
      mergeConfig({ proxies: ['http://a:b@1.2.3.4:8080', 'http://c:d@1.2.3.4:8080'] }),
    ).toThrow(/listed twice/);
  });

  it('defaults to none', () => {
    expect(mergeConfig({}).proxies).toEqual([]);
  });
});

describe('an identity on a proxy route', () => {
  it('is bound to the proxy by id, carries no credentials, and uses no agent of its own', () => {
    const rig = createTestRig({
      proxies: [PROXY],
      identities: { ...DEFAULT_SCRAPING_CONFIG.identities, count: 1 },
    });
    rig.pool.ensureSize();
    const identity = rig.pool.list()[0]!;

    expect(identity.egressId).toBe('103.1.2.3:8080');
    expect(JSON.stringify(identity)).not.toContain('s3cret');

    const session = new IdentitySession(identity, rig.pool, rig.governor, 'flipkart');
    expect((session as unknown as { agent: unknown }).agent).toBeUndefined();
  }, 30_000);
});
