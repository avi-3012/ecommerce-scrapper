import { gotScraping } from 'got-scraping';
import { Agent as Http2Agent } from 'http2-wrapper';
import type { Marketplace, ProxyRequestKind, ScrapeDebug } from '@pricepulse/shared';
import type { RawPage } from '../adapter.js';
import type { FetchFn, HttpFetchOptions, ResolveHop } from '../fetch/http.js';
import { CheckError } from '../errors.js';
import { decompressBody, recordProxyBytes } from '../fetch/bytes.js';
import type { Identity } from './types.js';
import type { IdentityPool } from './pool.js';
import { siteKeyOf } from './pool.js';
import type { IpGovernor } from './governor.js';
import type { IdentityCookieJar } from './jar.js';
import { bodyHash, bodyHead, classifyResponse } from './classify.js';
import { captureFailure } from './capture.js';

/**
 * One identity's live request path — the direct replacement for the proxy
 * plumbing that used to sit here.
 *
 * Everything that made a request look like a request from a specific browser
 * now comes from the identity and only from the identity: its stored headers in
 * their stored order, its own cookie jar, its own referer chain, its own pacing.
 * got-scraping supplies the Chromium TLS/HTTP2 fingerprint underneath, which is
 * why the pool is Chromium-family only — a plain Node client is flagged on the
 * handshake before a single header is read.
 *
 * `useHeaderGenerator: false` is the load-bearing option: got-scraping would
 * otherwise generate a FRESH header set per request, which is exactly the
 * per-request UA rotation this migration exists to remove.
 */

/** Requests we count against the whole-IP cap: page navigations. */
const NAVIGATION_KINDS: ReadonlySet<ProxyRequestKind> = new Set(['main_page', 'warmup', 'noise']);

/**
 * The pause between landing on a site and opening a product from it.
 *
 * Warm-up and the product fetch that follows it are ONE browsing action — a
 * person lands on the homepage and clicks through. Charging the identity's full
 * 20–150 s pacing gap between the two halves of a single visit is both wrong
 * (nobody stares at a homepage for half a minute before clicking) and expensive:
 * it made every fetch by a not-yet-warm identity take 23–42 s instead of ~1 s.
 */
const CLICK_THROUGH_MS = { min: 1_500, max: 5_000 } as const;

/**
 * Connection-level failures worth one more attempt.
 *
 * These mean NO HTTP response was received: an HTTP/2 GOAWAY while streams were
 * in flight, a reset socket, a closed keep-alive connection. Retrying one is not
 * "retrying a blocked URL" — the request never reached a verdict, and a browser
 * silently re-issues it. The rail is about not re-asking after a REFUSAL, and a
 * refusal always arrives as an HTTP response, which is handled by the classifier
 * and never retried here.
 */
const TRANSPORT_ERROR =
  /protocol error|socket hang up|ECONNRESET|EPIPE|ERR_HTTP2|GOAWAY|premature close|early terminated/i;
const TRANSPORT_RETRIES = 2;

/**
 * How long an idle HTTP/2 session may be kept before it is closed.
 *
 * Deliberately shorter than any identity's pacing gap. An identity waits 20–150 s
 * between requests, which is long enough for the far end to have dropped the
 * connection — and got, reusing the cached session, then fails with "Protocol
 * error" or "stream early terminated" having sent nothing. Closing our own idle
 * sessions first means the next request always opens a fresh one, which is also
 * what a browser that has been sitting on a tab for two minutes does.
 */
const H2_IDLE_MS = 15_000;

/**
 * How long a single request may wait for an IP-budget slot before giving up.
 *
 * Long enough to ride out ordinary cap pressure, far shorter than a global
 * backoff pause, which reaches three hours.
 */
const MAX_SLOT_WAIT_MS = 90_000;

/**
 * After a site hard-blocks, how long before another identity may warm up into
 * it. Warm-ups are the one request every fresh identity makes unprompted, so
 * without this a single site-wide refusal is multiplied by the pool size.
 */
const SITE_WARMUP_COOLDOWN_MS = 10 * 60_000;

export interface SessionRequestOptions {
  method?: 'GET' | 'POST';
  /** Merged OVER the identity's stored headers, preserving their order. */
  headers?: Record<string, string>;
  body?: string;
  kind: ProxyRequestKind;
  debug?: ScrapeDebug;
  timeoutMs?: number;
  /** Navigations set the referer chain and count against the IP cap. */
  navigation?: boolean;
  /** Don't follow redirects (short-link resolution). */
  followRedirect?: boolean;
  retry?: boolean;
}

export interface SessionResponse {
  url: string;
  statusCode: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
  wireBytes: number;
}

/** Homepages used for warm-up and for homepage noise. */
export const SITE_HOMEPAGE: Record<string, string> = {
  'amazon.in': 'https://www.amazon.in/',
  'flipkart.com': 'https://www.flipkart.com/',
};

/**
 * Turn a product title into the words a person would actually type. Long
 * marketplace titles ("HP Victus Gaming Laptop, 13th Gen Intel Core i5-13420H,
 * 8GB DDR4, …") are not search queries; the first few words are.
 */
export function searchKeywords(title: string): string {
  return title
    .replace(/[(,|].*$/, '')
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .slice(0, 4)
    .join(' ')
    .trim();
}

/** Search URL for a site, used for search-page noise. */
export function searchUrl(site: string, keywords: string): string {
  const q = encodeURIComponent(keywords);
  return site === 'amazon.in'
    ? `https://www.amazon.in/s?k=${q}`
    : `https://www.flipkart.com/search?q=${q}`;
}

export class IdentitySession {
  readonly jar: IdentityCookieJar;

  /** True when the next navigation continues the visit the warm-up began. */
  private pendingClickThrough = false;
  /**
   * The most recent response this session received, kept in memory so a failure
   * discovered LATER — in the parser, several layers up — can still be captured
   * with the bytes that caused it. Deliberately not in the debug sink: that gets
   * JSON-serialized into Postgres, and these are megabytes of HTML.
   */
  private lastResponse: { url: string; status: number; body: string; headers: unknown } | null =
    null;

  /**
   * Where the most recent hard block's body was written. Blocks are captured
   * down in the fetch path, well below the pipeline that writes the audit row,
   * so the path has to be carried back up — otherwise the bytes exist on disk
   * with nothing pointing at them, and the most common failure in the system
   * becomes the one you cannot open.
   */
  private lastBlockCapture: string | null = null;

  /** The capture path of the last hard block on this session, if any. */
  get lastBlockCapturePath(): string | null {
    return this.lastBlockCapture;
  }

  constructor(
    readonly identity: Identity,
    private readonly pool: IdentityPool,
    private readonly governor: IpGovernor,
    private readonly marketplace: Marketplace,
    /** Aborts the wait for an IP-cap slot (shutdown). */
    private readonly signal?: { aborted: boolean },
  ) {
    this.jar = pool.jarFor(identity);
  }

  get id(): string {
    return this.identity.id;
  }

  /** The identity's User-Agent — for headers that must echo it (x-user-agent). */
  get userAgent(): string {
    return this.identity.headers['user-agent'] ?? '';
  }

  /**
   * Record that this identity was served something that did not hold together.
   * Not a block — the identity keeps working — but it is counted, because an
   * identity that keeps being fed nonsense is an identity that has been flagged.
   */
  noteSuspect(): void {
    this.pool.noteSuspect(this.identity);
  }

  /**
   * We received a response but could not read it. Counted, never throttled —
   * this may well be our parser rather than their server.
   */
  noteUnreadable(): void {
    this.governor.recordSoftSignal('unreadable');
  }

  /**
   * This identity's own HTTP/2 agent.
   *
   * Per identity, not shared. A single process-wide session pool multiplexes
   * every identity's requests onto one connection per origin, so one GOAWAY
   * from the far end takes down every request in flight at once — which is why
   * the failures arrived in bursts rather than singly. Separate agents also
   * match the fiction: distinct browsers do not share a TCP connection.
   */
  private get agent(): { http2: Http2Agent } {
    IdentitySession.agents.set(
      this.identity.id,
      IdentitySession.agents.get(this.identity.id) ?? new Http2Agent({ timeout: H2_IDLE_MS }),
    );
    return { http2: IdentitySession.agents.get(this.identity.id)! };
  }

  /** identityId → agent, so a session rebuilt mid-cycle keeps its connections. */
  private static readonly agents = new Map<string, Http2Agent>();
  /** site → when it last hard-blocked, shared across every identity. */
  private static readonly siteBlockedAt = new Map<string, number>();

  /** Drop an identity's connections entirely (retirement, shutdown). */
  static destroyAgent(identityId: string): void {
    const agent = IdentitySession.agents.get(identityId);
    if (!agent) return;
    IdentitySession.agents.delete(identityId);
    try {
      agent.destroy();
    } catch {
      // already gone
    }
  }

  /** The Cookie header this identity would send to a URL (for the browser tier). */
  cookieHeaderFor(url: string): string {
    return this.jar.cookieHeaderFor(url);
  }

  /**
   * Build the wire headers for one request.
   *
   * The identity's stored headers are the base and their INSERTION ORDER is the
   * wire order, so overrides are applied in place rather than appended — a
   * Chrome that sends `accept` after `cookie` is a Chrome that isn't one.
   */
  private headersFor(url: string, options: SessionRequestOptions): Record<string, string> {
    const overrides = new Map(
      Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
    );
    const site = siteKeyOf(url);
    const lastUrl = this.identity.lastUrlBySite[site];

    if (options.navigation) {
      if (lastUrl && lastUrl !== url) {
        overrides.set('referer', lastUrl);
        // Same site, so this is a click-through, not a typed URL.
        overrides.set('sec-fetch-site', sameOrigin(lastUrl, url) ? 'same-origin' : 'same-site');
      } else {
        // No history for this site yet: a typed URL or a bookmark.
        overrides.delete('referer');
        overrides.set('sec-fetch-site', 'none');
      }
      overrides.set('sec-fetch-mode', 'navigate');
      overrides.set('sec-fetch-dest', 'document');
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(this.identity.headers)) {
      const override = overrides.get(key);
      if (override !== undefined) {
        headers[key] = override;
        overrides.delete(key);
      } else if (key === 'referer' && options.navigation) {
        continue; // dropped above
      } else {
        headers[key] = value;
      }
    }
    for (const [key, value] of overrides) headers[key] = value;
    return headers;
  }

  /**
   * Wait until the whole-IP cap, the global backoff and the kill switch all
   * allow one more page load. Polls once a second, so `PAUSE=1` or a `PAUSE`
   * file takes effect well inside the five seconds the rails require.
   */
  private async awaitSlot(): Promise<void> {
    const deadline = Date.now() + MAX_SLOT_WAIT_MS;
    for (;;) {
      if (this.signal?.aborted) throw new CheckError('other', 'Shutting down');
      const decision = this.governor.canRequest();
      if (decision.allowed) return;
      // Waiting out a MULTI-HOUR global pause inside a request is not patience,
      // it is a stall: the scheduler awaits its in-flight fetches before a cycle
      // can end, so one paused fetch freezes the whole loop — no new cycles, no
      // status updates, a dashboard frozen at pre-incident numbers. Give up and
      // let the scheduler re-plan; the pause is still in force and the next
      // cycle will find it.
      if (Date.now() > deadline) {
        throw new CheckError(
          'other',
          `Fetching is paused (${decision.reason}); giving up this check rather than blocking the cycle`,
        );
      }
      await sleep(Math.min(decision.retryAfterMs, 1_000));
    }
  }

  /**
   * Wait out this identity's own minimum gap, so its pacing stays human — unless
   * this request is the second half of a visit that just started, in which case
   * the human-shaped delay is a click, not a browsing interval.
   */
  private async awaitOwnGap(): Promise<void> {
    if (this.pendingClickThrough) {
      this.pendingClickThrough = false;
      await sleep(
        CLICK_THROUGH_MS.min + Math.random() * (CLICK_THROUGH_MS.max - CLICK_THROUGH_MS.min),
      );
      return;
    }
    const last = this.identity.lastRequestAt;
    if (last === null) return;
    const wait = this.identity.minGapMs - (Date.now() - last);
    if (wait > 0) await sleep(wait);
  }

  /**
   * One HTTP request as this identity. Never retries and never throws on an
   * HTTP status: a block must reach the classifier, not be swallowed by a retry
   * that hits the same wall from the same IP a moment later.
   */
  async request(url: string, options: SessionRequestOptions): Promise<SessionResponse> {
    const navigation = options.navigation ?? NAVIGATION_KINDS.has(options.kind);
    if (navigation) {
      await this.awaitOwnGap();
      await this.awaitSlot();
    }
    const timeoutMs = options.timeoutMs ?? 20_000;
    let response;
    let lastError = '';
    for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt++) {
      try {
        response = await gotScraping({
          url,
          method: options.method ?? 'GET',
          // An identity paces itself 20–150 s apart, so a kept-alive HTTP/2
          // session is always idle long enough for the far end to have dropped
          // it — and got reuses the dead session, which surfaces as "Protocol
          // error" with nothing sent. The first retry re-attempts over HTTP/2
          // (a genuinely transient blip); the second drops to HTTP/1.1, which
          // forces a fresh connection instead of the cached one. Chrome
          // negotiates h2 with both marketplaces, so h1 is a small fidelity
          // cost paid only on a path that would otherwise have failed outright.
          http2: attempt < TRANSPORT_RETRIES,
          // The identity IS the fingerprint. Anything generated per-request here
          // would contradict the stored headers and the TLS profile below.
          useHeaderGenerator: false,
          headers: this.headersFor(url, { ...options, navigation }),
          cookieJar: this.jar,
          // This identity's own connection pool — see `agent` above.
          ...(attempt < TRANSPORT_RETRIES ? { agent: this.agent } : {}),
          // No retries from got: a 403 or a CAPTCHA must reach the classifier
          // rather than be quietly re-issued against the same flagged IP. The
          // transport retry below is a different thing entirely.
          retry: { limit: 0 },
          throwHttpErrors: false,
          followRedirect: options.followRedirect ?? true,
          decompress: false, // meter wire bytes; we decode below
          timeout: { request: timeoutMs },
          ...(options.body === undefined ? {} : { body: options.body }),
        });
        break;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (/timeout/i.test(lastError)) {
          if (navigation) this.governor.recordRequest();
          // The far end did not serve us — congestion, and a reason to slow down.
          this.governor.recordSoftSignal('congestion');
          throw new CheckError('fetch_timeout', `Request timed out after ${timeoutMs}ms`);
        }
        // Concurrent identities share one HTTP/2 session per origin, so a GOAWAY
        // from the far end takes down every stream in flight at once — which is
        // why this arrived as a burst of failures rather than the occasional one.
        if (attempt < TRANSPORT_RETRIES && TRANSPORT_ERROR.test(lastError)) {
          await sleep(400 * (attempt + 1) + Math.random() * 600);
          continue;
        }
        if (navigation) this.governor.recordRequest();
        this.governor.recordSoftSignal('congestion');
        throw new CheckError('http_error', `Network error: ${lastError}`);
      }
    }
    if (!response) throw new CheckError('http_error', `Network error: ${lastError}`);

    if (navigation) this.governor.recordRequest();
    recordProxyBytes(options.debug, options.kind, response.rawBody.length, {
      tier: 'http',
      retry: options.retry,
    });

    const decoded = decompressBody(response.rawBody, response.headers['content-encoding']);
    this.lastResponse = {
      url: response.url ?? url,
      status: response.statusCode,
      body: decoded,
      headers: response.headers,
    };

    return {
      url: response.url ?? url,
      statusCode: response.statusCode,
      body: decoded,
      headers: response.headers,
      wireBytes: response.rawBody.length,
    };
  }

  /**
   * Write the last response this session received to disk, for a failure that
   * was only recognised further up the stack (a parse error, a variant swap).
   * Returns the stored path so the audit row can point at it.
   */
  captureLastResponse(reason: string, detail: string, productId?: string | null): string | null {
    if (!this.lastResponse) return null;
    const result = captureFailure({
      dir: this.pool.store.dir,
      marketplace: this.marketplace,
      productId,
      url: this.lastResponse.url,
      identityId: this.identity.id,
      reason,
      detail,
      status: this.lastResponse.status,
      body: this.lastResponse.body,
      headers: this.lastResponse.headers as Record<string, unknown>,
    });
    return result?.path ?? null;
  }

  /**
   * A short-link resolution hop, made as this identity.
   *
   * Marked as a navigation, so it waits out the identity's own gap and takes a
   * slot against the IP cap. Share links are overwhelmingly marketplace-operated
   * hosts, so a burst of them is a burst at the marketplace — that it returns a
   * 302 instead of a product page does not make it free, and pretending it does
   * is how an import poisons an address before a single price is checked.
   */
  resolveHop(): ResolveHop {
    return async (url, timeoutMs) => {
      const response = await this.request(url, {
        kind: 'resolve',
        followRedirect: false,
        navigation: true,
        timeoutMs,
      });
      const raw = response.headers['location'];
      return {
        statusCode: response.statusCode,
        location: Array.isArray(raw) ? raw[0] : raw,
      };
    };
  }

  /**
   * Warm-up: a fresh identity loads the site's homepage once, collecting the
   * cookies a real first visit would leave behind, before it ever asks for a
   * product page. Its first product request then carries the homepage as its
   * Referer with `Sec-Fetch-Site: same-origin` — an arrival, not an apparition.
   */
  async warmUp(site: string, debug?: ScrapeDebug): Promise<void> {
    const homepage = SITE_HOMEPAGE[site];
    if (!homepage) return;
    // One site-wide refusal should not authorise every other identity to go and
    // collect its own. 48 fresh identities each warming up into a marketplace
    // that just returned 529 produced 48 hard blocks in the same second and
    // drove the global backoff to its three-hour cap.
    const blockedAt = IdentitySession.siteBlockedAt.get(site);
    if (blockedAt && Date.now() - blockedAt < SITE_WARMUP_COOLDOWN_MS) {
      throw new CheckError(
        'fetch_blocked',
        `${site} returned a hard block ${Math.round((Date.now() - blockedAt) / 1000)}s ago; ` +
          `not warming up more identities into it yet`,
      );
    }
    const response = await this.request(homepage, { kind: 'warmup', debug, navigation: true });
    const verdict = classifyResponse({
      marketplace: this.marketplace,
      status: response.statusCode,
      body: response.body,
      // A homepage HAS no product, so the "no product ⇒ blocked" rule must not
      // run here. Amazon's own block vocabulary still applies to the body.
      expectProduct: false,
    });
    if (verdict.classification === 'hard_block') {
      this.recordBlock(response, verdict.reason, verdict.detail);
      throw new CheckError('fetch_blocked', `Warm-up blocked on ${site}: ${verdict.detail}`);
    }
    this.identity.lastUrlBySite[site] = homepage;
    this.pool.noteWarmed(this.identity, site);
    // Whatever this identity fetches next on this site is a click from here.
    this.pendingClickThrough = true;
  }

  /**
   * Walk this identity to a search results page for `keywords`, so that the
   * product fetch which follows arrives as a click from those results.
   *
   * This is the most common real path to a product page: someone searched, saw
   * results, clicked one. Arriving at a deep product URL from nowhere, with no
   * referer, over and over, is not. It costs one extra request, which is a real
   * price — volume is what gets metered — so it is applied to a fraction of
   * checks rather than all of them.
   *
   * Best-effort: a failed approach must never fail the check it precedes.
   */
  async approachViaSearch(site: string, keywords: string, debug?: ScrapeDebug): Promise<boolean> {
    if (!keywords) return false;
    try {
      const url = searchUrl(site, keywords);
      const response = await this.request(url, { kind: 'noise', debug, navigation: true });
      const verdict = classifyResponse({
        marketplace: this.marketplace,
        status: response.statusCode,
        body: response.body,
        expectProduct: false,
      });
      if (verdict.classification === 'hard_block') {
        this.recordBlock(response, verdict.reason, verdict.detail);
        return false;
      }
      // The product fetch will now carry this as its Referer automatically.
      this.identity.lastUrlBySite[site] = response.url;
      this.pool.noteOk(this.identity, response.url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A noise fetch: a homepage or a search page instead of a product. Costs one
   * slot against the cap, which is the point — an IP whose ONLY traffic is
   * product detail pages, forever, does not look like a person shopping.
   */
  async fetchNoise(site: string, keywords: string | null, debug?: ScrapeDebug): Promise<void> {
    const url = keywords ? searchUrl(site, keywords) : (SITE_HOMEPAGE[site] ?? '');
    if (!url) return;
    const response = await this.request(url, { kind: 'noise', debug, navigation: true });
    const verdict = classifyResponse({
      marketplace: this.marketplace,
      status: response.statusCode,
      body: response.body,
      expectProduct: false, // a homepage or search page, by design
    });
    if (verdict.classification === 'hard_block') {
      this.recordBlock(response, verdict.reason, verdict.detail);
      return;
    }
    this.identity.lastUrlBySite[site] = response.url;
    this.pool.noteOk(this.identity, response.url);
  }

  /**
   * The identity's page fetch, shaped as the adapters' existing `FetchFn` so
   * adapters and the pipeline need no knowledge of identities at all.
   */
  pageFetch: FetchFn = async (url: string, options: HttpFetchOptions = {}): Promise<RawPage> => {
    const site = siteKeyOf(url);
    if (this.pool.needsWarmUp(this.identity, site)) {
      await this.warmUp(site, options.debug);
    }
    const response = await this.request(url, {
      kind: options.kind ?? 'main_page',
      headers: options.headers,
      debug: options.debug,
      timeoutMs: options.timeoutMs,
      navigation: true,
    });

    const verdict = classifyResponse({
      marketplace: this.marketplace,
      status: response.statusCode,
      body: response.body,
    });
    if (options.debug) {
      options.debug.identityId = this.identity.id;
      options.debug.classification = verdict.classification;
      if (verdict.classification !== 'ok') options.debug.classificationReason = verdict.reason;
    }

    // 404/410 is the listing genuinely being gone, not a block — and it must
    // keep its own failure category so the product is not auto-paused as if the
    // IP were in trouble.
    if (response.statusCode === 404 || response.statusCode === 410) {
      this.pool.noteOk(this.identity, response.url);
      throw new CheckError('listing_removed', `Listing returned HTTP ${response.statusCode}`);
    }

    if (verdict.classification === 'hard_block') {
      this.recordBlock(response, verdict.reason, verdict.detail);
      const captcha = /captcha|robot_check/.test(verdict.reason);
      throw new CheckError(captcha ? 'captcha' : 'fetch_blocked', verdict.detail);
    }

    this.pool.noteOk(this.identity, response.url);
    return {
      url: response.url,
      body: response.body,
      tier: 'http',
      fetchedAt: new Date(),
    };
  };

  /**
   * A sub-resource request as this identity: the AJAX and API calls a real page
   * load fires off after the document arrives (Amazon's offer side-sheet,
   * Flipkart's page/fetch). It carries the identity's headers and jar like any
   * other request, but is NOT counted against the whole-IP cap and does not
   * consume the identity's minimum gap — the cap counts page loads, exactly as a
   * browser's own sub-resources are not separately rate-limited by a human.
   */
  subFetch: FetchFn = async (url: string, options: HttpFetchOptions = {}): Promise<RawPage> => {
    const response = await this.request(url, {
      kind: options.kind ?? 'side_sheet',
      headers: options.headers,
      debug: options.debug,
      timeoutMs: options.timeoutMs ?? 15_000,
      navigation: false,
    });
    if (response.statusCode >= 400) {
      // A 5xx on a sub-request is the far end struggling, same as a timeout.
      if (response.statusCode >= 500) this.governor.recordSoftSignal('congestion');
      throw new CheckError(
        response.statusCode === 403 || response.statusCode === 429 ? 'fetch_blocked' : 'http_error',
        `Sub-request to ${new URL(url).pathname} returned HTTP ${response.statusCode}`,
      );
    }
    return { url: response.url, body: response.body, tier: 'http', fetchedAt: new Date() };
  };

  /**
   * Cool the identity, count the block at the IP level, and keep the evidence:
   * a body hash plus the first 2 KB, so the detectors can be tuned against real
   * block pages rather than against a guess at what one looks like.
   */
  private recordBlock(response: SessionResponse, reason: string, detail: string): void {
    const marketplace = this.marketplace === 'amazon_in' ? 'amazon' : 'flipkart';
    const hash = bodyHash(response.body);
    // The first few of each site's block bodies, as a 2 KB head, stay in the
    // fixtures directory — that is the set the detectors get tuned against.
    if (this.pool.store.countBlockBodies(marketplace) < 3) {
      this.pool.store.recordBlockBody(
        marketplace,
        hash,
        [
          `# ${new Date().toISOString()} ${reason}`,
          `# identity=${this.identity.id} status=${response.statusCode} url=${response.url}`,
          `# sha256=${hash}`,
          '',
          bodyHead(response.body),
        ].join('\n'),
        new Date(),
      );
    }
    // Every block also gets a FULL capture, which is what you actually want
    // when diagnosing one after the fact.
    this.lastBlockCapture =
      captureFailure({
        dir: this.pool.store.dir,
        marketplace: this.marketplace,
        url: response.url,
        identityId: this.identity.id,
        reason,
        detail,
        status: response.statusCode,
        body: response.body,
        headers: response.headers as Record<string, unknown>,
      })?.path ?? null;
    IdentitySession.siteBlockedAt.set(siteKeyOf(response.url), Date.now());
    console.warn(
      `[identity] hard_block ${reason} on ${this.marketplace} via ${this.identity.id} ` +
        `(status ${response.statusCode}, sha256 ${hash.slice(0, 12)}): ${detail}`,
    );
    this.pool.noteBlock(this.identity);
    this.governor.recordHardBlock();
  }
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
