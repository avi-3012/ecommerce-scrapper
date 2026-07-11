import { AdapterRegistry } from './registry.js';
import { AmazonAdapter } from './amazon/adapter.js';
import { FlipkartAdapter } from './flipkart/adapter.js';
import type { FetchFn } from './fetch/http.js';

/** The production registry: both Phase 1 marketplaces. */
export function createDefaultRegistry(fetchFn?: FetchFn): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new AmazonAdapter(fetchFn));
  registry.register(new FlipkartAdapter(fetchFn));
  return registry;
}
