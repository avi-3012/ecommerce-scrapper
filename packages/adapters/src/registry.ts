import type { MarketplaceAdapter, UrlRecognition } from './adapter.js';

/**
 * Adapter registry keyed by domain. The rest of the system asks the registry;
 * it never names a marketplace directly (NFR-8).
 */
export class AdapterRegistry {
  private readonly byDomain = new Map<string, MarketplaceAdapter>();
  private readonly adapters: MarketplaceAdapter[] = [];

  register(adapter: MarketplaceAdapter): void {
    this.adapters.push(adapter);
    for (const domain of adapter.domains) {
      const key = domain.toLowerCase();
      if (this.byDomain.has(key)) {
        throw new Error(`Domain ${key} is already claimed by another adapter`);
      }
      this.byDomain.set(key, adapter);
    }
  }

  all(): readonly MarketplaceAdapter[] {
    return this.adapters;
  }

  /** Recognise any user-supplied URL string; never throws on malformed input. */
  recognize(input: string): UrlRecognition {
    let url: URL;
    try {
      url = new URL(input.trim());
    } catch {
      return { kind: 'unsupported', detectedSite: null };
    }
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const adapter =
      this.byDomain.get(host) ??
      // match parent domain: dl.flipkart.com → flipkart.com
      [...this.byDomain.entries()].find(([d]) => host.endsWith(`.${d}`))?.[1];
    if (!adapter) {
      return { kind: 'unsupported', detectedSite: host || null };
    }
    return adapter.recognize(url);
  }
}
