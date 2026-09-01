import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Identity } from './types.js';
import { IdentityCookieJar } from './jar.js';
import type { CookieRecord } from './cookie.js';
import { assertIdentityConsistent } from './headers.js';

/**
 * On-disk home of the identity pool.
 *
 * Identities are long-lived — weeks — so their state cannot live only in the
 * worker's memory. It also has to be readable by a second process: the `status`
 * command runs while the daemon is running, so the store is the interface
 * between them. Plain JSON files, written atomically (tmp + rename) so a crash
 * mid-write can never leave a half-parsed pool behind.
 *
 *   <dir>/pool.json        the identities themselves
 *   <dir>/jars/<id>.json   one identity's cookie jars, keyed by site
 *   <dir>/governor.json    IP-level cap accounting and backoff state
 *
 * Deliberately NOT in Postgres: the storage schema is out of scope for this
 * migration beyond recording `identity_id` on fetches, and a file store keeps
 * the pool readable and hand-fixable without a migration.
 */

const POOL_VERSION = 1;

/** Pool-level bookkeeping that is not a property of any one identity. */
export interface PoolMeta {
  /** Epoch ms of the last background churn (one identity replaced ≈ weekly). */
  lastChurnAt: number | null;
  /** productId → identityId, so stickiness survives a restart. */
  assignments: Record<string, string>;
}

export interface PoolFile {
  version: number;
  identities: Identity[];
  meta?: PoolMeta;
}

export function emptyMeta(): PoolMeta {
  return { lastChurnAt: null, assignments: {} };
}

export function defaultStoreDir(): string {
  return process.env.IDENTITY_DIR ?? join(process.cwd(), 'data', 'identities');
}

export class IdentityStore {
  private readonly jarDir: string;
  private readonly jars = new Map<string, IdentityCookieJar>();
  private flushTimer: NodeJS.Timeout | null = null;
  private dirtyPool = false;

  constructor(readonly dir: string = defaultStoreDir()) {
    this.jarDir = join(dir, 'jars');
    mkdirSync(this.jarDir, { recursive: true });
  }

  // ── identities ────────────────────────────────────────────────────────────

  /**
   * Load the pool. A stored identity is re-validated on the way in: the
   * consistency assertion runs against the persisted headers, so a hand-edited
   * or corrupted persona is dropped loudly rather than silently used.
   */
  loadPool(): { identities: Identity[]; meta: PoolMeta } {
    return { identities: this.loadIdentities(), meta: this.loadMeta() };
  }

  loadMeta(): PoolMeta {
    const file = this.readJson<PoolFile>(join(this.dir, 'pool.json'));
    return {
      lastChurnAt: file?.meta?.lastChurnAt ?? null,
      assignments: file?.meta?.assignments ?? {},
    };
  }

  loadIdentities(): Identity[] {
    const file = this.readJson<PoolFile>(join(this.dir, 'pool.json'));
    if (!file || !Array.isArray(file.identities)) return [];
    const loaded: Identity[] = [];
    for (const identity of file.identities) {
      try {
        assertIdentityConsistent(identity);
        loaded.push(normalize(identity));
      } catch (err) {
        console.error(
          `Identity ${identity?.id ?? '?'} failed its consistency check on load and was dropped:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    return loaded;
  }

  saveIdentities(identities: readonly Identity[], meta: PoolMeta = this.loadMeta()): void {
    this.writeJson(join(this.dir, 'pool.json'), {
      version: POOL_VERSION,
      identities: [...identities],
      meta,
    } satisfies PoolFile);
    this.dirtyPool = false;
  }

  // ── cookie jars ───────────────────────────────────────────────────────────

  /** The (lazily loaded) jar for one identity. Same instance on repeat calls. */
  jarFor(identityId: string): IdentityCookieJar {
    const existing = this.jars.get(identityId);
    if (existing) return existing;
    const data = this.readJson<Record<string, CookieRecord[]>>(this.jarPath(identityId));
    const jar = IdentityCookieJar.fromJSON(data ?? {}, () => this.scheduleFlush());
    this.jars.set(identityId, jar);
    return jar;
  }

  private jarPath(identityId: string): string {
    return join(this.jarDir, `${identityId}.json`);
  }

  /** Forget an identity's cookies entirely (retirement). */
  dropJar(identityId: string): void {
    this.jars.delete(identityId);
    try {
      unlinkSync(this.jarPath(identityId));
    } catch {
      // never existed, or already gone
    }
  }

  // ── governor state ────────────────────────────────────────────────────────

  loadGovernor<T>(): T | null {
    return this.readJson<T>(join(this.dir, 'governor.json'));
  }

  saveGovernor(state: unknown): void {
    this.writeJson(join(this.dir, 'governor.json'), state);
  }

  // ── block bodies ──────────────────────────────────────────────────────────

  /**
   * Persist the first 2 KB of a hard-blocked response alongside its body hash,
   * so a block can be diagnosed (and the detectors tuned) after the fact
   * without re-triggering one — particularly for Flipkart, which does not
   * announce a block and simply stops serving product pages.
   *
   * Written under the STORE's own `fixtures/` directory rather than the
   * package's checked-in parser fixtures: these are live captures, and mixing
   * them into the fixture set the parser tests assert against would silently
   * change what those tests mean.
   */
  recordBlockBody(marketplace: string, bodyHash: string, head: string, at: Date): void {
    const dir = join(this.dir, 'fixtures', marketplace);
    mkdirSync(dir, { recursive: true });
    const name = `${at.toISOString().replace(/[:.]/g, '-')}-${bodyHash.slice(0, 12)}.txt`;
    try {
      writeFileSync(join(dir, name), head, 'utf8');
    } catch (err) {
      console.error(
        'Block-body write failed (non-fatal):',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** How many block bodies have been saved for a marketplace so far. */
  countBlockBodies(marketplace: string): number {
    try {
      return readdirSync(join(this.dir, 'fixtures', marketplace)).length;
    } catch {
      return 0;
    }
  }

  // ── flushing ──────────────────────────────────────────────────────────────

  markPoolDirty(): void {
    this.dirtyPool = true;
    this.scheduleFlush();
  }

  /**
   * Coalesce writes: a cycle touches jars and identity stats dozens of times,
   * and none of it is worth a synchronous write each. Anything unflushed is at
   * most one second of cookie churn, which a restart re-collects for free.
   */
  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushJars();
    }, 1_000);
    this.flushTimer.unref?.();
  }

  flushJars(): void {
    for (const [id, jar] of this.jars) {
      if (!jar.isDirty) continue;
      this.writeJson(this.jarPath(id), jar.toJSON());
      jar.markClean();
    }
  }

  /** Flush everything now — called on shutdown and after each cycle. */
  flush(identities?: readonly Identity[], meta?: PoolMeta): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushJars();
    if (identities) this.saveIdentities(identities, meta);
  }

  // ── json helpers ──────────────────────────────────────────────────────────

  private readJson<T>(path: string): T | null {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as T;
    } catch {
      return null;
    }
  }

  private writeJson(path: string, value: unknown): void {
    const tmp = `${path}.tmp`;
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
      renameSync(tmp, path);
    } catch (err) {
      console.error(
        `Identity store write to ${path} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}

/** Fill in fields a store file written by an older build may not carry. */
function normalize(identity: Identity): Identity {
  return {
    ...identity,
    coolingUntil: identity.coolingUntil ?? null,
    lastUrlBySite: identity.lastUrlBySite ?? {},
    warmedSites: identity.warmedSites ?? [],
    lastRequestAt: identity.lastRequestAt ?? null,
    awayUntil: identity.awayUntil ?? null,
    awayDay: identity.awayDay ?? null,
    awayCount: identity.awayCount ?? 0,
    recentBlocks: identity.recentBlocks ?? [],
    consecutiveBlocks: identity.consecutiveBlocks ?? 0,
    stats: {
      requests: identity.stats?.requests ?? 0,
      blocks: identity.stats?.blocks ?? 0,
      suspects: identity.stats?.suspects ?? 0,
      createdAt: identity.stats?.createdAt ?? new Date().toISOString(),
      lastUsedAt: identity.stats?.lastUsedAt ?? null,
    },
  };
}
