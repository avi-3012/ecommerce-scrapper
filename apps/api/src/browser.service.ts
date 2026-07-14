import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { createBrowserFetch, proxyLabel } from '@pricepulse/adapters';
import type { FetchFn } from '@pricepulse/adapters';

/**
 * Lazily provides the tier-2 (headless browser) fetch to the API's
 * registration preview so a Flipkart URL blocked at tier-1 can escalate to a
 * real browser instead of hard-failing (R-2 mitigation). Created on first use
 * and reused; returns undefined when Playwright isn't installed, so preview
 * cleanly degrades to tier-1 HTTP only.
 */
@Injectable()
export class BrowserService implements OnModuleDestroy {
  private fetchFn: FetchFn | undefined;
  private initialized = false;
  private initializing: Promise<void> | null = null;

  async get(): Promise<FetchFn | undefined> {
    if (this.initialized) return this.fetchFn;
    this.initializing ??= this.init();
    await this.initializing;
    return this.fetchFn;
  }

  private async init(): Promise<void> {
    this.fetchFn = await createBrowserFetch();
    this.initialized = true;
    console.log(
      this.fetchFn
        ? 'API browser tier (Playwright) available for preview escalation'
        : 'API browser tier not installed — preview is tier-1 HTTP only (see HUMAN-TASKS H-13)',
    );
    const proxy = proxyLabel();
    console.log(proxy ? `API scraper proxy active: ${proxy}` : 'API scraper proxy: none (direct)');
  }

  onModuleDestroy(): void {
    // The browser is auto-recycled inside createBrowserFetch; nothing to close here.
  }
}
