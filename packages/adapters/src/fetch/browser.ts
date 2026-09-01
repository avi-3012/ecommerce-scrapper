import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { RawPage } from '../adapter.js';
import type { FetchFn } from './http.js';
import { CheckError } from '../errors.js';
import { recordProxyBytes } from './bytes.js';
import type { Identity } from '../identity/types.js';
import { userAgentOf } from '../identity/headers.js';

/**
 * Tier-2 fetch: a real Chrome, one PERSISTENT profile per identity.
 *
 * The old shape — one shared browser, a fresh incognito context per fetch —
 * was the browser equivalent of a rotating proxy: every page load arrived as a
 * brand-new visitor with an empty jar. That is the pattern this migration
 * removes. Each identity now gets its own `userDataDir`, kept across cycles, so
 * its cookies, storage and history accumulate the way a real profile's do, and
 * its viewport / UA / locale / timezone match the headers it uses over HTTP.
 *
 * Contexts are expensive in memory, so only a few stay open at once: the pool
 * of identities is deliberately allowed to be larger than the number of live
 * browser contexts, and a context is closed when its identity goes away.
 *
 * Returns `undefined` when Playwright isn't installed, so callers degrade to
 * tier-1 HTTP only rather than crashing.
 */

/** How many identity profiles may have a browser open simultaneously. */
const MAX_OPEN_CONTEXTS = 2;

/**
 * Resource types the browser tier never parses. Blocking them cuts a large slice
 * of tier-2 bandwidth (images/fonts don't compress). Scripts, stylesheets and
 * the document are deliberately NOT blocked: these pages are client-rendered, so
 * stripping JS/CSS would leave an empty skeleton with none of the price/offer
 * data we extract.
 */
const BLOCKED_RESOURCES: ReadonlySet<string> = new Set(['image', 'media', 'font']);

/** Viewports that go with each device class; fixed per identity, never resized. */
const VIEWPORTS = {
  desktop: { width: 1366, height: 768 },
  mobile: { width: 393, height: 852 },
} as const;

interface PersistentContext {
  addCookies(cookies: Array<{ name: string; value: string; url: string }>): Promise<void>;
  route(
    pattern: string,
    handler: (route: {
      request(): { resourceType(): string };
      abort(): Promise<void>;
      continue(): Promise<void>;
    }) => void,
  ): Promise<void>;
  newCDPSession(page: unknown): Promise<{
    send(method: string): Promise<unknown>;
    on(event: string, cb: (e: { encodedDataLength?: number }) => void): void;
  }>;
  newPage(): Promise<{
    goto(url: string, opts: object): Promise<{ status(): number } | null>;
    content(): Promise<string>;
    url(): string;
    close(): Promise<void>;
  }>;
  close(): Promise<void>;
}

interface PlaywrightModule {
  chromium: {
    launchPersistentContext(userDataDir: string, opts: object): Promise<PersistentContext>;
  };
}

/** The slice of the governor the browser tier needs: it only counts page loads. */
export interface RequestCounter {
  recordRequest(now?: number): void;
}

export interface BrowserTier {
  /** A tier-2 `FetchFn` bound to one identity's persistent profile. */
  fetchFor(identity: Identity): FetchFn;
  /** Close an identity's browser (retirement, or making room). */
  close(identityId: string): Promise<void>;
  closeAll(): Promise<void>;
}

export async function createBrowserTier(
  profilesDir: string = join(process.cwd(), 'data', 'browser-profiles'),
  /**
   * Counts each browser page load against the whole-IP budget.
   *
   * A tier-2 fetch is the HEAVIEST request this system makes — a full page with
   * JavaScript — and it used to be invisible to the budget entirely. That is
   * precisely backwards: escalation happens when a check has already gone wrong,
   * so the uncounted requests arrived exactly when the connection was under the
   * most pressure.
   */
  counter?: RequestCounter,
): Promise<BrowserTier | undefined> {
  const specifier = 'playwright';
  let playwright: PlaywrightModule;
  try {
    playwright = (await import(specifier)) as PlaywrightModule;
  } catch {
    return undefined;
  }
  mkdirSync(profilesDir, { recursive: true });

  /** identityId → its open persistent context, most-recently-used last. */
  const open = new Map<string, PersistentContext>();
  /** Null until the first launch tells us whether real Chrome is installed. */
  let chromeChannelWorks: boolean | null = null;

  async function close(identityId: string): Promise<void> {
    const context = open.get(identityId);
    if (!context) return;
    open.delete(identityId);
    await context.close().catch(() => undefined);
  }

  async function contextFor(identity: Identity): Promise<PersistentContext> {
    const existing = open.get(identity.id);
    if (existing) {
      // Refresh LRU order.
      open.delete(identity.id);
      open.set(identity.id, existing);
      return existing;
    }
    while (open.size >= MAX_OPEN_CONTEXTS) {
      const oldest = open.keys().next().value;
      if (oldest === undefined) break;
      await close(oldest);
    }
    const userDataDir = join(profilesDir, identity.id);
    mkdirSync(userDataDir, { recursive: true });
    const options = {
      headless: true,
      // Fixed for the life of the identity, and matched to its HTTP headers.
      userAgent: userAgentOf(identity),
      viewport: VIEWPORTS[identity.device],
      isMobile: identity.device === 'mobile',
      hasTouch: identity.device === 'mobile',
      locale: 'en-IN',
      timezoneId: 'Asia/Kolkata',
    };
    // Real Chrome rather than bundled Chromium where it exists: the branded
    // build is what the identity's UA and sec-ch-ua claim to be. But it is a
    // separate install that is frequently absent (containers, CI), and
    // launchPersistentContext only discovers that at LAUNCH — by which time a
    // check is already in flight and would fail for a reason that has nothing
    // to do with the listing. So try Chrome, fall back to bundled Chromium, and
    // remember which one worked.
    let context: PersistentContext;
    if (chromeChannelWorks !== false) {
      try {
        context = await playwright.chromium.launchPersistentContext(userDataDir, {
          ...options,
          channel: 'chrome',
        });
        chromeChannelWorks = true;
      } catch (err) {
        chromeChannelWorks = false;
        console.warn(
          `[identity] real Chrome not available (${err instanceof Error ? err.message.split('\n')[0] : err}); ` +
            `using bundled Chromium for the browser tier`,
        );
        context = await playwright.chromium.launchPersistentContext(userDataDir, options);
      }
    } else {
      context = await playwright.chromium.launchPersistentContext(userDataDir, options);
    }
    await context
      .route('**/*', (route) =>
        BLOCKED_RESOURCES.has(route.request().resourceType())
          ? void route.abort()
          : void route.continue(),
      )
      .catch(() => undefined);
    open.set(identity.id, context);
    return context;
  }

  function fetchFor(identity: Identity): FetchFn {
    return async (url, options): Promise<RawPage> => {
      const context = await contextFor(identity);
      const page = await context.newPage();
      try {
        // Apply a caller-supplied cookie (Amazon's glow location cookie) so a
        // browser-tier fetch is localised exactly like the HTTP tier. Without it,
        // the browser would load the IP-default location and record a wrong price.
        const cookieHeader = options?.headers?.cookie;
        if (cookieHeader) {
          const cookies = cookieHeader
            .split(';')
            .map((pair) => {
              const eq = pair.indexOf('=');
              return eq > 0
                ? { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), url }
                : null;
            })
            .filter((c): c is { name: string; value: string; url: string } => c !== null);
          if (cookies.length) await context.addCookies(cookies);
        }
        // Meter true wire bytes (encoded) via CDP — best-effort observability.
        let wireBytes = 0;
        try {
          const cdp = await context.newCDPSession(page);
          await cdp.send('Network.enable');
          cdp.on('Network.loadingFinished', (e) => {
            wireBytes += e.encodedDataLength ?? 0;
          });
        } catch {
          // CDP unavailable — skip metering, never block the fetch.
        }
        counter?.recordRequest();
        const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (wireBytes > 0) {
          recordProxyBytes(options?.debug, options?.kind ?? 'main_page', wireBytes, {
            tier: 'browser',
          });
        }
        const status = response?.status() ?? 0;
        if (status === 404 || status === 410) {
          throw new CheckError('listing_removed', `Listing returned HTTP ${status} (browser)`);
        }
        return {
          url: page.url(),
          body: await page.content(),
          tier: 'browser',
          fetchedAt: new Date(),
        };
      } catch (err) {
        if (err instanceof CheckError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        if (/timeout/i.test(message)) {
          throw new CheckError('fetch_timeout', `Browser navigation timed out: ${message}`);
        }
        throw new CheckError('http_error', `Browser fetch failed: ${message}`);
      } finally {
        // The PAGE closes; the CONTEXT stays, because the context is the profile.
        await page.close().catch(() => undefined);
      }
    };
  }

  return {
    fetchFor,
    close,
    async closeAll(): Promise<void> {
      for (const id of [...open.keys()]) await close(id);
    },
  };
}
