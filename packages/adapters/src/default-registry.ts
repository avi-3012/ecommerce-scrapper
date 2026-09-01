import { AdapterRegistry } from './registry.js';
import { AmazonAdapter } from './amazon/adapter.js';
import { FlipkartAdapter } from './flipkart/adapter.js';

/**
 * The production registry: both Phase 1 marketplaces.
 *
 * Adapters no longer carry a fetch function of their own — every request they
 * make belongs to the identity session passed per check, so there is nothing
 * left to inject here.
 */
export function createDefaultRegistry(): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(new AmazonAdapter());
  registry.register(new FlipkartAdapter());
  return registry;
}
