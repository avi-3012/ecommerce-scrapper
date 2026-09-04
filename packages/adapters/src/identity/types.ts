/**
 * The identity pool — the replacement for the residential-proxy layer.
 *
 * All traffic now leaves from this machine's own ISP connection: one IP, no
 * proxies. What used to be "which exit node did this check use" is now "which
 * synthetic browser identity did this check use". An identity is a small,
 * internally consistent, LONG-LIVED persona:
 *
 *   TLS profile ↔ headers ↔ client hints ↔ cookie jar ↔ referer chain ↔ pacing
 *
 * Consistency is the whole point. A rotating User-Agent over a fixed TLS
 * handshake is a contradiction, not camouflage — so headers are generated once
 * at creation, stored, and replayed verbatim (order included) for the rest of
 * the identity's life, which is measured in weeks.
 */

/** Chromium-family only: got-scraping impersonates Chromium at the TLS layer. */
export type IdentityBrowser = 'chrome' | 'edge';
export type IdentityOs = 'windows' | 'macos' | 'android';
export type IdentityDevice = 'desktop' | 'mobile';

/**
 * Lifecycle:
 *   fresh    — created, has never fetched; must warm up (homepage per site) first
 *   warm     — warmed up on at least one site, idle and eligible
 *   active   — currently holds the single in-flight request allowed per identity
 *   cooling  — blocked recently; unusable until `coolingUntil`
 *   retired  — permanently out of the pool (repeated blocks, or background churn)
 */
export type IdentityState = 'fresh' | 'warm' | 'active' | 'cooling' | 'retired';

export interface IdentityStats {
  requests: number;
  blocks: number;
  suspects: number;
  createdAt: string;
  lastUsedAt: string | null;
}

export interface Identity {
  id: string;
  browser: IdentityBrowser;
  os: IdentityOs;
  device: IdentityDevice;
  /**
   * Generated ONCE at creation and replayed verbatim. Insertion order is the
   * wire order, so this object is never rebuilt, spread, or sorted — only read.
   */
  headers: Record<string, string>;
  /** Minimum gap between this identity's requests; randomized once, 60–150 s. */
  minGapMs: number;
  state: IdentityState;
  /** Epoch ms until which a `cooling` identity stays unusable. */
  coolingUntil: number | null;
  /** Last URL fetched per site host — replayed as the Referer of the next fetch. */
  lastUrlBySite: Record<string, string>;
  /** Sites this identity has completed its homepage warm-up on. */
  warmedSites: string[];
  /** Epoch ms of the last request, for the minGap gate. */
  lastRequestAt: number | null;
  /** Epoch ms until which the identity is on an "away period" (a human break). */
  awayUntil: number | null;
  /** Epoch-ms day-stamp + count of away periods taken, so we can hit 2–4×/day. */
  awayDay: string | null;
  awayCount: number;
  /** Epoch ms of this identity's recent hard blocks, pruned to 24 h. */
  recentBlocks: number[];
  /** Hard blocks since its last clean fetch — a run of these means retire it. */
  consecutiveBlocks: number;
  stats: IdentityStats;
}

/** How a fetched response was classified. Every response gets exactly one. */
export type Classification = 'ok' | 'suspect' | 'hard_block';

export interface ClassifiedResponse {
  classification: Classification;
  /** Short machine-readable reason, e.g. 'amazon_captcha', 'flipkart_non_200'. */
  reason: string;
  /** Human detail for logs/audit. */
  detail: string;
}

export type ConnectionType = 'home' | 'office';

/**
 * How an identity is chosen for a fetch.
 *
 *   sticky       — a product keeps the identity that fetched it last (~70%).
 *                  Fewer, deeper personas that each accumulate a real history.
 *   per-request  — every fetch draws a different identity, least-recently-used
 *                  first. Each identity is still fully consistent in itself; it
 *                  just does less work. Costs history depth, buys variety.
 *
 * Neither hides the IP, which is the join key either way. The choice is about
 * what the traffic from that IP looks like: one household's few devices, or a
 * CGNAT-style block of many.
 */
export type RotationMode = 'sticky' | 'per-request';

/**
 * How the whole-IP request budget is decided.
 *
 *   fixed     — the configured day/night numbers, and nothing exceeds them.
 *   adaptive  — the configured number is only a STARTING point. The rate climbs
 *               while responses stay clean and halves on a block, settling at
 *               whatever this connection actually tolerates. Use this when you
 *               want maximum throughput and are willing to have it discovered
 *               rather than declared.
 */
export type CapMode = 'fixed' | 'adaptive';

export interface AdaptiveCapConfig {
  /** Rate to start at, per minute. */
  startPerMin: number;
  /** Never climb above this, per minute. */
  maxPerMin: number;
  /** Never fall below this, per minute — the floor a bad patch cannot breach. */
  minPerMin: number;
  /** Clean seconds that earn one more request per minute (additive increase). */
  increaseEverySec: number;
  /** How much of the rate survives a congestion signal (multiplicative decrease). */
  decreaseFactor: number;
  /**
   * The share of recent requests that may be blocked before the rate is cut.
   *
   * Not every block is a congestion signal. One refusal among three hundred
   * good responses is background noise — a flaky edge node, a listing mid-edit —
   * and treating it as "slow down" makes the controller converge far below what
   * the connection actually tolerates, because a multiplicative cut is much
   * larger than one additive step back up. Cut when blocks become a PROPORTION,
   * not when one happens.
   */
  tolerateBlockRatio: number;
}

export interface ScrapingConfig {
  connection: { type: ConnectionType };
  identities: {
    count: number;
    /** Minimum gap between one identity's requests, randomized per identity. */
    minGapMs: { min: number; max: number };
    rotation: RotationMode;
  };
  cycle: { minSec: number; maxSec: number };
  /**
   * Whole-IP request budget, per minute. In `fixed` mode these are hard limits
   * and are never exceeded. In `adaptive` mode `dayPerMin` is the starting rate
   * and the controller takes over from there.
   */
  ipCap: { mode: CapMode; dayPerMin: number; nightPerMin: number; adaptive: AdaptiveCapConfig };
  night: { startIST: string; endIST: string };
  noiseRatio: number;
  /**
   * Fraction of product fetches that arrive via a SEARCH page rather than out
   * of nowhere. Costs one extra request each, and buys the most common real
   * path to a product page: someone searched, saw results, clicked through.
   */
  funnelRatio: number;
  maxConcurrent: number;
  /**
   * Diurnal pacing: run at a fraction of the learned ceiling that varies by IST
   * hour instead of flat around the clock. Disabling it makes the request rate
   * from this address constant 24/7, which is the single most machine-like
   * property traffic can have — a household's does not do that.
   */
  diurnal: { enabled: boolean };
  /**
   * Volatility tiering: how much to stretch a product's interval based on how
   * long its price has sat still. This is the only lever that makes a large
   * catalogue fit a fixed request budget, because requests/minute is
   * `products ÷ interval` and nothing else changes that arithmetic.
   */
  tiers: {
    /** Still for longer than this many hours → warm. */
    warmAfterHours: number;
    /** Still for longer than this many hours → cold. */
    coldAfterHours: number;
    /** Interval multiplier for each tier. Hot is always 1. */
    warmMultiplier: number;
    coldMultiplier: number;
  };
  limits: {
    /**
     * How many products are actively SCRAPED, highest priority first.
     *
     * Requests per minute is `products ÷ interval`, so an unbounded catalogue is
     * an unbounded request rate — and the catalogue grows one harmless-looking
     * product at a time, long after anyone last thought about the budget.
     *
     * Capacity bounds the rate without bounding the catalogue. Track as many
     * products as you like; the top `capacity` of them by `priority` are the
     * ones the scheduler spends requests on, and the rest wait their turn
     * without being checked. Reordering the list is then how you choose what
     * gets watched, which is a decision about what matters rather than a wall
     * you hit while adding.
     *
     * A slot is freed the moment its holder stops being `active` — auto-paused
     * or paused by hand — so a dead listing does not hold a slot forever.
     * 0 disables the limit and scrapes everything due.
     */
    capacity: number;
    /**
     * Hard cap on how many products may EXIST, refused at registration and
     * import. Distinct from `capacity`, which caps what is scraped: this one
     * caps what is stored. 0 disables it, which is the default — the request
     * budget is `capacity`'s job, and refusing to remember a product protects
     * nothing.
     */
    maxProducts: number;
    /**
     * Refuse to start when the catalogue stretches the cycle past 3× what was
     * requested. Correct for an unattended deployment; in the way when you are
     * deliberately running the connection as hard as it will go.
     */
    refuseWhenStretched: boolean;
  };
}
