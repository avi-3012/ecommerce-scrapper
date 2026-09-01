import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SCRAPING_CONFIG,
  HOME_IDENTITY_WARN_THRESHOLD,
  configWarnings,
  mergeConfig,
} from './config.js';
import { IDENTITY_SPECS, assertIdentityConsistent, generateHeaders } from './headers.js';
import { IdentityPool, createIdentity } from './pool.js';
import { IdentityStore } from './store.js';
import { IdentitySession } from './session.js';
import { IdentityCookieJar } from './jar.js';
import { parseSetCookie } from './cookie.js';
import { ulid, ulidTime } from './ulid.js';
import type { ScrapingConfig } from './types.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'pricepulse-identity-test-'));
}

/** The defaults with a different pool size / rotation, for one test at a time. */
function withPool(
  count: number,
  overrides: Partial<ScrapingConfig['identities']> = {},
): ScrapingConfig {
  return {
    ...DEFAULT_SCRAPING_CONFIG,
    identities: { ...DEFAULT_SCRAPING_CONFIG.identities, count, ...overrides },
  };
}

describe('identity consistency', () => {
  it.each(IDENTITY_SPECS)(
    'generates a self-consistent header set for $browser/$os/$device',
    (spec) => {
      const identity = createIdentity(spec);
      // The assertion runs inside createIdentity; re-running it here is what
      // makes the failure legible if the generator's dataset ever drifts.
      expect(() => assertIdentityConsistent(identity)).not.toThrow();
      expect(identity.headers['user-agent']).toMatch(/Chrome\/\d+/);
      expect(identity.headers['accept-language']).toMatch(/^en-IN/);
    },
  );

  it('refuses a Firefox User-Agent, because the TLS handshake is Chromium', () => {
    const headers = { ...generateHeaders(IDENTITY_SPECS[0]!) };
    headers['user-agent'] = 'Mozilla/5.0 (Windows NT 10.0; rv:128.0) Gecko/20100101 Firefox/128.0';
    expect(() =>
      assertIdentityConsistent({ browser: 'chrome', os: 'windows', device: 'desktop', headers }),
    ).toThrow(/not Chromium-family/);
  });

  it('refuses a sec-ch-ua whose major version disagrees with the User-Agent', () => {
    const headers = { ...generateHeaders({ browser: 'chrome', os: 'windows', device: 'desktop' }) };
    const major = headers['user-agent']!.match(/Chrome\/(\d+)/)![1]!;
    headers['sec-ch-ua'] = headers['sec-ch-ua']!.replace(
      `"Google Chrome";v="${major}"`,
      '"Google Chrome";v="99"',
    );
    expect(() =>
      assertIdentityConsistent({ browser: 'chrome', os: 'windows', device: 'desktop', headers }),
    ).toThrow(/sec-ch-ua major/);
  });

  it('refuses a platform hint that contradicts the identity OS', () => {
    const headers = { ...generateHeaders({ browser: 'chrome', os: 'windows', device: 'desktop' }) };
    headers['sec-ch-ua-platform'] = '"macOS"';
    expect(() =>
      assertIdentityConsistent({ browser: 'chrome', os: 'windows', device: 'desktop', headers }),
    ).toThrow(/sec-ch-ua-platform/);
  });

  it('refuses an Edge identity whose UA never mentions Edge', () => {
    const headers = generateHeaders({ browser: 'chrome', os: 'windows', device: 'desktop' });
    expect(() =>
      assertIdentityConsistent({ browser: 'edge', os: 'windows', device: 'desktop', headers }),
    ).toThrow(/edge identity without Edg/);
  });

  it('gives every identity a human pacing gap of 60–150 s', () => {
    for (let i = 0; i < 20; i++) {
      const identity = createIdentity(IDENTITY_SPECS[i % IDENTITY_SPECS.length]!);
      expect(identity.minGapMs).toBeGreaterThanOrEqual(60_000);
      expect(identity.minGapMs).toBeLessThanOrEqual(150_000);
    }
  });
});

describe('supported personas', () => {
  it('never creates a mobile identity — the parsers read the desktop layout', () => {
    // A mobile UA makes Amazon serve `apex_mobile`; the parsers target
    // `apex_desktop` / `corePriceDisplay_desktop_feature_div`. Mobile personas
    // silently failed roughly one Amazon check in four, looking exactly like
    // throttling until a response body was captured and read.
    expect(IDENTITY_SPECS.every((s) => s.device === 'desktop')).toBe(true);
    const pool = new IdentityPool(withPool(25), new IdentityStore(tempDir()));
    pool.ensureSize();
    expect(pool.list().every((i) => i.device === 'desktop')).toBe(true);
    expect(pool.list().every((i) => !/Mobile/.test(i.headers['user-agent'] ?? ''))).toBe(true);
  });

  it('retires personas already in the store whose device is no longer supported', () => {
    const dir = tempDir();
    const store = new IdentityStore(dir);
    const pool = new IdentityPool(withPool(4), store);
    pool.ensureSize();

    // Forge a mobile persona of the kind earlier builds created, and persist it.
    const mobile = createIdentity({ browser: 'chrome', os: 'android', device: 'mobile' });
    (pool as unknown as { identities: (typeof mobile)[] }).identities.push(mobile);
    pool.persistNow();
    expect(new IdentityStore(dir).loadIdentities().some((i) => i.id === mobile.id)).toBe(true);

    // Trimming by COUNT alone would leave it in place forever.
    const reloaded = new IdentityPool(withPool(4), new IdentityStore(dir));
    reloaded.ensureSize();
    expect(reloaded.list().some((i) => i.id === mobile.id)).toBe(false);
    expect(reloaded.list().every((i) => i.device === 'desktop')).toBe(true);
  });
});

describe('identity persistence across restart', () => {
  it('restores the same headers, id and pacing after a restart', () => {
    const dir = tempDir();
    const first = new IdentityPool(DEFAULT_SCRAPING_CONFIG, new IdentityStore(dir));
    first.ensureSize();
    const before = first.list().map((i) => ({ ...i, headers: { ...i.headers } }));
    expect(before).toHaveLength(DEFAULT_SCRAPING_CONFIG.identities.count);
    first.flush();

    // A whole new process would see exactly this: a fresh store over the dir.
    const second = new IdentityPool(DEFAULT_SCRAPING_CONFIG, new IdentityStore(dir));
    second.ensureSize();
    const after = second.list();

    expect(after.map((i) => i.id)).toEqual(before.map((i) => i.id));
    for (const [index, identity] of after.entries()) {
      // Verbatim, order included — this is the property the whole layer rests on.
      expect(Object.entries(identity.headers)).toEqual(Object.entries(before[index]!.headers));
      expect(identity.minGapMs).toBe(before[index]!.minGapMs);
      expect(identity.browser).toBe(before[index]!.browser);
    }
  });

  it('restores an identity cookie jar, and keeps jars separate per identity', async () => {
    const dir = tempDir();
    const store = new IdentityStore(dir);
    const pool = new IdentityPool(DEFAULT_SCRAPING_CONFIG, store);
    pool.ensureSize();
    const [alice, bob] = pool.list();

    const jar = store.jarFor(alice!.id);
    await jar.setCookie(
      'session-id=abc123; Domain=.amazon.in; Path=/',
      'https://www.amazon.in/dp/X',
    );
    await jar.setCookie('lc-acbin=en_IN; Path=/', 'https://www.amazon.in/dp/X');
    store.flush(pool.list());

    const restored = new IdentityStore(dir);
    expect(restored.jarFor(alice!.id).cookieHeaderFor('https://www.amazon.in/dp/Y')).toBe(
      'session-id=abc123; lc-acbin=en_IN',
    );
    // Bob never saw those cookies and must not inherit them.
    expect(restored.jarFor(bob!.id).cookieHeaderFor('https://www.amazon.in/dp/Y')).toBe('');
    // Nor do Amazon cookies leak to the other marketplace.
    expect(restored.jarFor(alice!.id).cookieHeaderFor('https://www.flipkart.com/')).toBe('');
  });

  it('drops a hand-edited identity whose headers no longer hold together', () => {
    const dir = tempDir();
    const pool = new IdentityPool(withPool(2), new IdentityStore(dir));
    pool.ensureSize();
    pool.flush();

    const path = join(dir, 'pool.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as {
      identities: Array<{ headers: Record<string, string> }>;
    };
    file.identities[0]!.headers['user-agent'] = 'curl/8.4.0';
    writeFileSync(path, JSON.stringify(file));

    const reloaded = new IdentityStore(dir).loadIdentities();
    expect(reloaded).toHaveLength(1);
  });
});

describe('cookie jar', () => {
  it('honours Path, Secure, expiry and host-only scoping', async () => {
    const jar = new IdentityCookieJar();
    await jar.setCookie('deep=1; Path=/dp', 'https://www.amazon.in/dp/X');
    await jar.setCookie('secureonly=1; Secure; Path=/', 'https://www.amazon.in/');
    await jar.setCookie('gone=1; Path=/; Max-Age=-1', 'https://www.amazon.in/');

    expect(jar.cookieHeaderFor('https://www.amazon.in/dp/X')).toContain('deep=1');
    expect(jar.cookieHeaderFor('https://www.amazon.in/gp/cart')).not.toContain('deep=1');
    expect(jar.cookieHeaderFor('http://www.amazon.in/')).not.toContain('secureonly');
    expect(jar.cookieHeaderFor('https://www.amazon.in/')).not.toContain('gone');
  });

  it('ignores a Domain attribute that tries to widen past the origin', () => {
    const cookie = parseSetCookie('evil=1; Domain=example.com', 'https://www.amazon.in/');
    expect(cookie?.domain).toBe('www.amazon.in');
    expect(cookie?.hostOnly).toBe(true);
  });

  it('expires a cookie once its Max-Age has passed', async () => {
    const jar = new IdentityCookieJar();
    await jar.setCookie('short=1; Path=/; Max-Age=60', 'https://www.amazon.in/');
    expect(jar.cookieHeaderFor('https://www.amazon.in/')).toContain('short=1');
    expect(jar.cookieHeaderFor('https://www.amazon.in/', Date.now() + 61_000)).toBe('');
  });
});

describe('pool selection', () => {
  it('holds an identity back until its own minimum gap has elapsed', () => {
    const pool = new IdentityPool(withPool(1), new IdentityStore(tempDir()));
    pool.ensureSize();
    const identity = pool.list()[0]!;
    const now = Date.UTC(2026, 7, 21, 6, 0, 0); // 11:30 IST — daytime

    pool.noteOk(identity, 'https://www.amazon.in/dp/X', now);
    expect(pool.eligible(now + identity.minGapMs - 1_000)).toHaveLength(0);
    expect(pool.eligible(now + identity.minGapMs + 1_000)).toHaveLength(1);
  });

  it('cools a blocked identity for 45–120 minutes rather than discarding it', () => {
    const pool = new IdentityPool(withPool(3), new IdentityStore(tempDir()));
    pool.ensureSize();
    const identity = pool.list()[0]!;
    const now = Date.UTC(2026, 7, 21, 6, 0, 0);

    pool.noteBlock(identity, now);
    expect(identity.state).toBe('cooling');
    expect(identity.coolingUntil! - now).toBeGreaterThanOrEqual(45 * 60_000);
    expect(identity.coolingUntil! - now).toBeLessThanOrEqual(120 * 60_000);
    expect(pool.eligible(now + 60_000).map((i) => i.id)).not.toContain(identity.id);
    // It comes BACK — a pool that only ever loses identities looks synthetic.
    expect(pool.eligible(identity.coolingUntil! + 1_000).map((i) => i.id)).toContain(identity.id);
  });

  it('retires an identity only after repeated blocks', () => {
    const pool = new IdentityPool(withPool(4), new IdentityStore(tempDir()));
    pool.ensureSize();
    const identity = pool.list()[0]!;
    let now = Date.UTC(2026, 7, 21, 6, 0, 0);

    pool.noteBlock(identity, now);
    pool.noteBlock(identity, (now += 3_600_000));
    expect(pool.list().map((i) => i.id)).toContain(identity.id);
    pool.noteBlock(identity, (now += 3_600_000));
    expect(pool.list().map((i) => i.id)).not.toContain(identity.id);
  });

  it('keeps a product with the same identity most of the time, but not always', () => {
    const pool = new IdentityPool(withPool(8), new IdentityStore(tempDir()));
    pool.ensureSize();
    const now = Date.UTC(2026, 7, 21, 6, 0, 0);

    const incumbent = pool.acquire({ site: 'amazon.in', productId: 'p1', now })!;
    pool.release(incumbent);

    let stayed = 0;
    const rounds = 600;
    for (let i = 0; i < rounds; i++) {
      const chosen = pool.acquire({ site: 'amazon.in', productId: 'p1', now })!;
      if (chosen.id === incumbent.id) stayed++;
      pool.release(chosen);
      // Restore the incumbent so every round measures the same decision. It has
      // to go through the store, because acquire() re-reads it from there.
      const meta = (pool as unknown as { meta: { assignments: Record<string, string> } }).meta;
      meta.assignments['p1'] = incumbent.id;
      // persistNow, not persist: acquire() re-reads the file, and the debounced
      // write would not have landed yet.
      pool.persistNow();
    }
    // ~70% stickiness, with enough slack that this is not a flaky coin-flip test.
    expect(stayed / rounds).toBeGreaterThan(0.6);
    expect(stayed / rounds).toBeLessThan(0.8);
  });

  it('per-request rotation hands out a different identity every time', () => {
    const pool = new IdentityPool(
      withPool(20, { rotation: 'per-request', minGapMs: { min: 0, max: 0 } }),
      new IdentityStore(tempDir()),
    );
    pool.ensureSize();
    const now = Date.UTC(2026, 7, 21, 6, 0, 0);

    // Same product every time. Under sticky rotation this would return one
    // identity ~70% of the time; under per-request it must spread.
    const picked: string[] = [];
    for (let i = 0; i < 20; i++) {
      const identity = pool.acquire({ site: 'amazon.in', productId: 'p1', now })!;
      picked.push(identity.id);
      pool.noteOk(identity, 'https://www.amazon.in/dp/X', now + i);
      pool.release(identity);
    }
    // Least-recently-used with a zero gap cycles the whole pool before repeating.
    expect(new Set(picked).size).toBe(20);
    // And consecutive requests are never the same browser.
    for (let i = 1; i < picked.length; i++) expect(picked[i]).not.toBe(picked[i - 1]);
  });

  it('per-request rotation still gives each identity its own consistent persona', () => {
    const pool = new IdentityPool(
      withPool(12, { rotation: 'per-request', minGapMs: { min: 0, max: 0 } }),
      new IdentityStore(tempDir()),
    );
    pool.ensureSize();
    // Rotation changes WHICH identity answers, never what an identity is.
    for (const identity of pool.list()) {
      expect(() => assertIdentityConsistent(identity)).not.toThrow();
    }
    const uas = new Set(pool.list().map((i) => i.headers['user-agent']));
    expect(uas.size).toBeGreaterThan(1);
  });

  it('applies an edited gap range to identities that already exist', () => {
    const dir = tempDir();
    const slow = new IdentityPool(withPool(4), new IdentityStore(dir));
    slow.ensureSize();
    expect(slow.list().every((i) => i.minGapMs >= 60_000)).toBe(true);

    // Lowering the gap must take effect now, not weeks from now as the pool churns.
    const fast = new IdentityPool(
      withPool(4, { minGapMs: { min: 5_000, max: 10_000 } }),
      new IdentityStore(dir),
    );
    fast.ensureSize();
    expect(fast.list().every((i) => i.minGapMs >= 5_000 && i.minGapMs <= 10_000)).toBe(true);
    // Same identities, though — a gap change is not a reason to discard personas.
    expect(
      fast
        .list()
        .map((i) => i.id)
        .sort(),
    ).toEqual(
      slow
        .list()
        .map((i) => i.id)
        .sort(),
    );
  });

  it('lets only a small night crew work the small hours', () => {
    const pool = new IdentityPool(withPool(8), new IdentityStore(tempDir()));
    pool.ensureSize();
    // 21:30 UTC on the 20th = 03:00 IST on the 21st.
    const night = Date.UTC(2026, 7, 20, 21, 30, 0);
    expect(pool.eligible(night).length).toBeLessThanOrEqual(2);
    expect(pool.eligible(night).length).toBeGreaterThanOrEqual(1);
  });

  it('never hands the same identity out twice while a request is in flight', () => {
    const pool = new IdentityPool(withPool(2), new IdentityStore(tempDir()));
    pool.ensureSize();
    const now = Date.UTC(2026, 7, 21, 6, 0, 0);
    const a = pool.acquire({ site: 'amazon.in', productId: 'p1', now })!;
    const b = pool.acquire({ site: 'amazon.in', productId: 'p2', now })!;
    expect(a.id).not.toBe(b.id);
    expect(pool.acquire({ site: 'amazon.in', productId: 'p3', now })).toBeNull();
    pool.release(a);
    expect(pool.acquire({ site: 'amazon.in', productId: 'p3', now })!.id).toBe(a.id);
  });
});

describe('request shaping', () => {
  it('replays the stored headers verbatim, in their stored order', () => {
    const dir = tempDir();
    const pool = new IdentityPool(withPool(1), new IdentityStore(dir));
    pool.ensureSize();
    const identity = pool.list()[0]!;
    pool.noteWarmed(identity, 'amazon.in');
    const session = new IdentitySession(identity, pool, fakeGovernor(), 'amazon_in');

    const headers = (
      session as unknown as {
        headersFor(url: string, options: { navigation: boolean }): Record<string, string>;
      }
    ).headersFor('https://www.amazon.in/dp/X', { navigation: true });

    // Same values, and the same order — a browser's header order is part of its
    // fingerprint, so an override must land in place rather than at the end.
    const storedKeys = Object.keys(identity.headers);
    const sentKeys = Object.keys(headers).filter((k) => storedKeys.includes(k));
    expect(sentKeys).toEqual(storedKeys.filter((k) => k !== 'referer'));
    expect(headers['user-agent']).toBe(identity.headers['user-agent']);
    expect(headers['sec-ch-ua']).toBe(identity.headers['sec-ch-ua']);
  });

  it('arrives at a product page from the last page it saw on that site', () => {
    const dir = tempDir();
    const pool = new IdentityPool(withPool(1), new IdentityStore(dir));
    pool.ensureSize();
    const identity = pool.list()[0]!;
    identity.lastUrlBySite['amazon.in'] = 'https://www.amazon.in/';
    const session = new IdentitySession(identity, pool, fakeGovernor(), 'amazon_in');

    const headers = (
      session as unknown as {
        headersFor(url: string, options: { navigation: boolean }): Record<string, string>;
      }
    ).headersFor('https://www.amazon.in/dp/X', { navigation: true });

    expect(headers['referer']).toBe('https://www.amazon.in/');
    expect(headers['sec-fetch-site']).toBe('same-origin');
    expect(headers['sec-fetch-mode']).toBe('navigate');
  });

  it('has no referer at all on the very first visit to a site', () => {
    const dir = tempDir();
    const pool = new IdentityPool(withPool(1), new IdentityStore(dir));
    pool.ensureSize();
    const session = new IdentitySession(pool.list()[0]!, pool, fakeGovernor(), 'flipkart');

    const headers = (
      session as unknown as {
        headersFor(url: string, options: { navigation: boolean }): Record<string, string>;
      }
    ).headersFor('https://www.flipkart.com/', { navigation: true });

    expect(headers['referer']).toBeUndefined();
    expect(headers['sec-fetch-site']).toBe('none');
  });
});

describe('request pacing', () => {
  it('treats warm-up and the fetch that follows it as one visit', async () => {
    const pool = new IdentityPool(
      withPool(1, { minGapMs: { min: 120_000, max: 120_000 } }),
      new IdentityStore(tempDir()),
    );
    pool.ensureSize();
    const identity = pool.list()[0]!;
    const session = new IdentitySession(identity, pool, fakeGovernor(), 'flipkart');

    // The identity has just loaded the homepage. The product page it opens next
    // is a click from there, not a new browsing session two minutes later —
    // charging the full gap here made every cold fetch take 23–42 s.
    (session as unknown as { pendingClickThrough: boolean }).pendingClickThrough = true;
    identity.lastRequestAt = Date.now();

    const started = Date.now();
    await (session as unknown as { awaitOwnGap(): Promise<void> }).awaitOwnGap();
    const waited = Date.now() - started;
    expect(waited).toBeLessThan(6_000);
    expect(waited).toBeGreaterThanOrEqual(1_400);
  });

  it('charges the full pacing gap for an ordinary next fetch', async () => {
    const pool = new IdentityPool(
      withPool(1, { minGapMs: { min: 300, max: 300 } }),
      new IdentityStore(tempDir()),
    );
    pool.ensureSize();
    const identity = pool.list()[0]!;
    const session = new IdentitySession(identity, pool, fakeGovernor(), 'flipkart');
    identity.lastRequestAt = Date.now();

    const started = Date.now();
    await (session as unknown as { awaitOwnGap(): Promise<void> }).awaitOwnGap();
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });
});

describe('config', () => {
  it('defaults every key and clamps nonsense into range', () => {
    expect(mergeConfig({})).toEqual(DEFAULT_SCRAPING_CONFIG);
    // The clamps are sanity bounds against a typo, not a view about how hard
    // anyone should run their own connection.
    expect(mergeConfig({ ipCap: { dayPerMin: 99_999 } }).ipCap.dayPerMin).toBe(10_000);
    expect(mergeConfig({ maxConcurrent: 0 }).maxConcurrent).toBe(1);
    expect(mergeConfig({ identities: { count: 50 } }).identities.count).toBe(50);
  });

  it('accepts the shipped local high-throughput profile', () => {
    const local = mergeConfig({
      identities: { count: 50, rotation: 'per-request', minGapMs: { min: 20_000, max: 40_000 } },
      cycle: { minSec: 55, maxSec: 70 },
      ipCap: {
        mode: 'adaptive',
        dayPerMin: 30,
        adaptive: { startPerMin: 30, maxPerMin: 120, minPerMin: 4, decreaseFactor: 0.6 },
      },
      maxConcurrent: 12,
      limits: { refuseWhenStretched: false },
    });
    expect(local.identities.rotation).toBe('per-request');
    expect(local.ipCap.mode).toBe('adaptive');
    expect(local.limits.refuseWhenStretched).toBe(false);
    // 50 identities at a 30 s average gap reach ~100/min, so a 120 ceiling is
    // within reach and the pool-is-the-ceiling warning must stay quiet.
    expect(configWarnings(local).filter((w) => w.includes('the ceiling'))).toEqual([]);
  });

  it('says so when the pool can never reach the configured budget', () => {
    const mismatched = mergeConfig({
      identities: { count: 8, minGapMs: { min: 60_000, max: 150_000 } },
      ipCap: { mode: 'adaptive', adaptive: { maxPerMin: 240 } },
    });
    const warning = configWarnings(mismatched).find((w) => w.includes('the ceiling'));
    expect(warning).toMatch(/raising the budget will do nothing/);
    // And it says what would actually reach it.
    expect(warning).toMatch(/you need about \d+ identities/);
  });

  it('rejects a cycle window that runs backwards', () => {
    expect(() => mergeConfig({ cycle: { minSec: 300, maxSec: 60 } })).toThrow(/below cycle.minSec/);
  });

  it('warns when a home line claims more devices than a home has', () => {
    expect(
      configWarnings(mergeConfig({ connection: { type: 'home' }, identities: { count: 8 } })),
    ).toEqual([]);
    expect(
      configWarnings(
        mergeConfig({
          connection: { type: 'home' },
          identities: { count: HOME_IDENTITY_WARN_THRESHOLD + 1 },
        }),
      )[0],
    ).toMatch(/more devices than a household has/);
    // An office line legitimately runs 20–40.
    expect(
      configWarnings(mergeConfig({ connection: { type: 'office' }, identities: { count: 30 } })),
    ).toEqual([]);
  });
});

describe('ulid', () => {
  it('sorts by creation time and round-trips its timestamp', () => {
    const early = ulid(1_700_000_000_000);
    const late = ulid(1_800_000_000_000);
    expect(early < late).toBe(true);
    expect(ulidTime(early)).toBe(1_700_000_000_000);
    expect(ulidTime('not-a-ulid')).toBeNull();
  });
});

/** A governor that always says yes — cap behaviour has its own test file. */
function fakeGovernor(): never {
  return {
    canRequest: () => ({ allowed: true, reason: null, retryAfterMs: 0 }),
    recordRequest: () => {},
    recordHardBlock: () => null,
    killSwitchEngaged: () => false,
  } as never;
}
